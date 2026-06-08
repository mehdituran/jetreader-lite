/**
 * JetReader Engine - Core reader logic supporting EPUB, PDF, TXT, DOCX formats.
 * Supports: TOC/NCX extraction, HTML rendering for EPUB, canvas rendering for PDF.
 *
 * @package JetReader
 */

import * as pdfjsLib from 'pdfjs-dist';
import { unzipSync, strFromU8 } from 'fflate';
import mammoth from 'mammoth';
import DOMPurify from 'dompurify';

// Use locally bundled worker — vite.config copies it to dist/js/ at build time.
const _pluginUrl = ( window as any ).jetreaderSettings?.pluginUrl ?? '';
pdfjsLib.GlobalWorkerOptions.workerSrc = `${ _pluginUrl.replace( /\/$/, '' ) }/dist/js/pdf.worker.min.mjs`;

function re( key: string ): string {
    const t = ( window as any ).jetreaderSettings?.translations?.readerEngine;
    return t?.[ key ] ?? key;
}

export type ReaderFormat = 'epub' | 'pdf' | 'txt' | 'docx' | 'doc';

/** A single TOC/Fihrist entry pointing to a page index. */
export interface TocEntry {
    label: string;
    pageIndex: number;  // 0-based index into pages[]
    depth: number;      // 0 = top-level, 1 = sub-section, etc.
    fragmentId?: string; // element id within the page to scroll to (EPUB #anchors)
}

/** A single page/section of content. */
export interface ReaderPage {
    index: number;
    content: string;         // plain text (search + fallback)
    htmlContent?: string;    // sanitized HTML (EPUB only)
    pdfPageNumber?: number;  // 1-based PDF page number for canvas render
    label?: string;
}

/** Book-level metadata. */
export interface ReaderMetadata {
    title: string;
    author?: string;
    coverImage?: string;
    totalPages: number;
    format: ReaderFormat;
}

/** Full load result returned by ReaderEngine.loadBook(). */
export interface ReaderLoadResult {
    pages: ReaderPage[];
    metadata: ReaderMetadata;
    toc: TocEntry[];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    pdfDoc?: any; // PDFDocumentProxy — kept as any to avoid deep pdfjs type imports in the modal
}

interface EpubManifestItem {
    href: string;
    mediaType: string;
    properties: string;
}

interface PdfTextItem {
    str: string;
    hasEOL?: boolean;
}

/** Returns the URL to use for fetching — routes cross-origin URLs through the WP proxy. */
function resolveFileUrl( fileUrl: string ): string {
    try {
        const target  = new URL( fileUrl );
        const current = new URL( window.location.href );
        if ( target.origin !== current.origin ) {
            const apiBase = ( window as any ).jetreaderSettings?.apiUrl ?? '/wp-json/jetreader/v1/';
            return `${apiBase.replace( /\/$/, '' )}/proxy?url=${encodeURIComponent( fileUrl )}`;
        }
    } catch { /* relative or invalid URL — use as-is */ }
    return fileUrl;
}

/** Detect ReaderFormat from a file URL's extension. Returns null when unknown. */
export function detectFormatFromUrl( url: string ): ReaderFormat | null {
    const path = url.split( '?' )[ 0 ].split( '#' )[ 0 ];
    const ext  = path.split( '.' ).pop()?.toLowerCase() ?? '';
    const map: Record<string, ReaderFormat> = {
        pdf: 'pdf', epub: 'epub', docx: 'docx', doc: 'doc', txt: 'txt',
    };
    return map[ ext ] ?? null;
}

class LectorDB {
    private static dbName = 'LectorCache';
    private static version = 1;
    private static storeName = 'books';

    private static getDB(): Promise<IDBDatabase> {
        return new Promise( ( resolve, reject ) => {
            if ( typeof window === 'undefined' || typeof window.indexedDB === 'undefined' ) {
                return reject( new Error( 'IndexedDB not supported' ) );
            }
            const request = window.indexedDB.open( this.dbName, this.version );
            request.onupgradeneeded = () => {
                const db = request.result;
                if ( ! db.objectStoreNames.contains( this.storeName ) ) {
                    db.createObjectStore( this.storeName );
                }
            };
            request.onsuccess = () => resolve( request.result );
            request.onerror = () => reject( request.error );
        } );
    }

    public static async get( key: string ): Promise<any> {
        try {
            const db = await this.getDB();
            return new Promise( ( resolve, reject ) => {
                const tx = db.transaction( this.storeName, 'readonly' );
                const store = tx.objectStore( this.storeName );
                const request = store.get( key );
                request.onsuccess = () => resolve( request.result );
                request.onerror = () => reject( request.error );
            } );
        } catch {
            return null;
        }
    }

    public static async set( key: string, val: any ): Promise<void> {
        try {
            const db = await this.getDB();
            return new Promise( ( resolve, reject ) => {
                const tx = db.transaction( this.storeName, 'readwrite' );
                const store = tx.objectStore( this.storeName );
                const request = store.put( val, key );
                request.onsuccess = () => resolve();
                request.onerror = () => reject( request.error );
            } );
        } catch {
            // ignore database write errors
        }
    }

    public static async cleanupOldEntries(): Promise<void> {
        try {
            const db = await this.getDB();
            const tx = db.transaction( this.storeName, 'readwrite' );
            const store = tx.objectStore( this.storeName );
            const thirtyDays = 30 * 24 * 60 * 60 * 1000;
            const now = Date.now();

            const request = store.openCursor();
            request.onsuccess = ( event: any ) => {
                const cursor = event.target.result;
                if ( cursor ) {
                    const data = cursor.value;
                    if ( data && data.cachedAt && ( now - data.cachedAt > thirtyDays ) ) {
                        cursor.delete();
                    }
                    cursor.continue();
                }
            };
        } catch {
            // ignore cleanup errors
        }
    }
}

// Run cleanup in background once when loaded
if ( typeof window !== 'undefined' ) {
    setTimeout( () => {
        LectorDB.cleanupOldEntries().catch( () => {} );
    }, 5000 );
}

export class ReaderEngine {
    private static memoryCache = new Map<string, ReaderLoadResult>();

    public static prefetchBook( fileUrl: string, format: ReaderFormat, encoding?: string ): void {
        if ( format === 'txt' ) return; // Avoid prefetching TXT files to prevent raw encoding cache pollution
        this.loadBook( fileUrl, format, encoding ).catch( () => {} );
    }

    public static async loadBook( fileUrl: string, format: ReaderFormat, encoding?: string ): Promise<ReaderLoadResult> {
        const cacheKey = `${fileUrl}_${format}_${encoding || 'utf-8'}`;

        // 1. Check in-memory cache first
        if ( this.memoryCache.has( cacheKey ) ) {
            return this.memoryCache.get( cacheKey )!;
        }

        const urlFormat    = detectFormatFromUrl( fileUrl );
        const activeFormat = urlFormat ?? format;

        // 2. Check IndexedDB cache
        const cached = await LectorDB.get( cacheKey );
        if ( cached && cached.pages && cached.metadata ) {
            const thirtyDays = 30 * 24 * 60 * 60 * 1000;
            if ( Date.now() - cached.cachedAt < thirtyDays ) {
                // Update sliding expiration in background
                cached.cachedAt = Date.now();
                LectorDB.set( cacheKey, cached ).catch( () => {} );

                if ( activeFormat === 'pdf' && cached.fileData ) {
                    try {
                        const loadingTask = pdfjsLib.getDocument( { data: cached.fileData, verbosity: 0 } );
                        const pdf = await loadingTask.promise;
                        const result: ReaderLoadResult = {
                            pages: cached.pages,
                            metadata: cached.metadata,
                            toc: cached.toc,
                            pdfDoc: pdf,
                        };
                        this.memoryCache.set( cacheKey, result );
                        return result;
                    } catch ( err ) {
                        console.warn( 'Failed to load cached PDF document, falling back to network', err );
                    }
                } else if ( activeFormat !== 'pdf' ) {
                    const result: ReaderLoadResult = {
                        pages: cached.pages,
                        metadata: cached.metadata,
                        toc: cached.toc,
                    };
                    this.memoryCache.set( cacheKey, result );
                    return result;
                }
            }
        }

        // 3. Cache miss: Fetch and parse
        const resolvedUrl = resolveFileUrl( fileUrl );
        const response = await fetch( resolvedUrl );
        if ( ! response.ok ) {
            throw new Error( `${re( 'failedToFetch' )}: ${response.statusText}` );
        }
        const arrayBuffer = await response.arrayBuffer();
        const uint8 = new Uint8Array( arrayBuffer );

        let result: ReaderLoadResult;
        switch ( activeFormat ) {
            case 'pdf':  result = await this.loadPdf( uint8 ); break;
            case 'epub': result = this.loadEpub( uint8 ); break;
            case 'txt':  result = this.loadTxt( uint8, encoding ); break;
            case 'docx': result = await this.loadDocx( uint8 ); break;
            case 'doc':  result = await this.loadDoc( uint8 ); break;
            default: throw new Error( `${re( 'unsupportedFormat' )}: ${activeFormat}` );
        }

        // Store in memory cache
        this.memoryCache.set( cacheKey, result );

        // Store in IndexedDB cache (omit pdfDoc proxy from serialized data)
        const serializedData = {
            pages: result.pages,
            metadata: result.metadata,
            toc: result.toc,
            cachedAt: Date.now(),
            fileData: activeFormat === 'pdf' ? uint8 : undefined,
        };
        LectorDB.set( cacheKey, serializedData ).catch( () => {} );

        return result;
    }

    /* ------------------------------------------------------------------ */
    /*  PDF                                                                */
    /* ------------------------------------------------------------------ */

    private static async loadPdf( data: Uint8Array ): Promise<ReaderLoadResult> {
        const loadingTask = pdfjsLib.getDocument( { data, verbosity: 0 } );
        const pdf = await loadingTask.promise;
        const totalPages = pdf.numPages;

        let bookTitle = re( 'untitledPdf' );
        try {
            const meta = await pdf.getMetadata();
            const info = meta.info as Record<string, unknown>;
            if ( info?.Title && typeof info.Title === 'string' && info.Title.trim() ) {
                bookTitle = info.Title.trim();
            }
        } catch { /* metadata optional */ }

        // Create lightweight page stubs — text is NOT extracted upfront.
        // Canvas rendering is done lazily (on-demand per page), so 500-page PDFs
        // open in <1s instead of waiting for sequential getTextContent() on every page.
        const pages: ReaderPage[] = Array.from( { length: totalPages }, ( _, i ) => ( {
            index: i,
            content: `${re( 'pageLabel' )} ${i + 1}`,
            pdfPageNumber: i + 1,
            label: `${re( 'pageLabel' )} ${i + 1}`,
        } ) );

        // Extract PDF outline (Dokümanın ana hatları) — same API Chrome uses.
        // Fast even for large PDFs since it only reads the outline tree, not page content.
        const toc = await this.extractPdfOutline( pdf );

        return {
            pages,
            metadata: { title: bookTitle, totalPages, format: 'pdf' },
            toc,
            pdfDoc: pdf,
        };
    }

    /**
     * Extract the PDF's built-in outline (bookmarks/章节) using PDF.js getOutline().
     * Resolves named destinations to 0-based page indices.
     */
    private static async extractPdfOutline( pdf: any ): Promise<TocEntry[]> {
        try {
            const outline = await pdf.getOutline();
            if ( ! outline || outline.length === 0 ) return [];

            const entries: TocEntry[] = [];

            const walk = async ( items: any[], depth: number ) => {
                for ( const item of items ) {
                    if ( ! item.title ) continue;

                    // External URL entries (not in-document) — skip entirely.
                    if ( ! item.dest && item.url ) continue;

                    let pageIndex: number | null = null;
                    try {
                        if ( item.dest ) {
                            let dest = item.dest;
                            if ( typeof dest === 'string' ) {
                                dest = await pdf.getDestination( dest );
                            }
                            if ( Array.isArray( dest ) && dest[ 0 ] != null ) {
                                pageIndex = await pdf.getPageIndex( dest[ 0 ] );
                            }
                        }
                    } catch { /* destination unresolvable (e.g. encrypted PDF) — skip entry */ }

                    // Destination çözülemediyse (şifreli PDF, bozuk link) bu başlığı atla.
                    // Yanlış sayfa (0) göstermek yerine hiç göstermemek daha iyi.
                    if ( pageIndex === null ) {
                        // Alt başlıkları yine de tara — bazıları çözülebilir olabilir
                        if ( item.items?.length ) await walk( item.items, depth + 1 );
                        continue;
                    }

                    entries.push( { label: item.title, pageIndex, depth } );

                    if ( item.items?.length ) await walk( item.items, depth + 1 );
                }
            };

            await walk( outline, 0 );
            return entries;
        } catch {
            return [];
        }
    }

    /* ------------------------------------------------------------------ */
    /*  EPUB                                                               */
    /* ------------------------------------------------------------------ */

    private static loadEpub( data: Uint8Array ): ReaderLoadResult {
        const zip = unzipSync( data );

        const containerRaw = zip[ 'META-INF/container.xml' ];
        if ( ! containerRaw ) throw new Error( re( 'invalidEpubContainer' ) );

        const containerXml = strFromU8( containerRaw );
        const opfPathMatch = containerXml.match( /full-path="([^"]+)"/ );
        if ( ! opfPathMatch ) throw new Error( re( 'invalidEpubOpf' ) );

        const opfPath = opfPathMatch[ 1 ];
        const opfRaw = zip[ opfPath ];
        if ( ! opfRaw ) throw new Error( re( 'invalidEpubMissingOpf' ) );

        const opfXml = strFromU8( opfRaw );
        const opfBaseDir = opfPath.includes( '/' )
            ? opfPath.substring( 0, opfPath.lastIndexOf( '/' ) + 1 )
            : '';

        // Metadata
        const title = opfXml.match( /<dc:title[^>]*>([^<]+)<\/dc:title>/ )?.[1]?.trim() ?? re( 'untitledEpub' );
        const author = opfXml.match( /<dc:creator[^>]*>([^<]+)<\/dc:creator>/ )?.[1]?.trim();

        // Manifest — match any <item ...> tag (self-closing or not)
        const manifestItems: Record<string, EpubManifestItem> = {};
        const manifestTagRegex = /<item\s+([^>]+)>/gi;
        let mTag: RegExpExecArray | null;
        while ( ( mTag = manifestTagRegex.exec( opfXml ) ) !== null ) {
            const attrs = mTag[ 1 ];
            const id         = attrs.match( /\bid="([^"]+)"/ )?.[1] ?? '';
            const href       = attrs.match( /\bhref="([^"]+)"/ )?.[1] ?? '';
            const mediaType  = attrs.match( /\bmedia-type="([^"]+)"/ )?.[1] ?? '';
            const properties = attrs.match( /\bproperties="([^"]+)"/ )?.[1] ?? '';
            if ( id && href ) {
                manifestItems[ id ] = {
                    href: opfBaseDir + decodeURIComponent( href ),
                    mediaType,
                    properties,
                };
            }
        }

        // Pre-build blob URL map for every image in the ZIP so inline <img src>
        // references can be resolved without hitting the network.
        const IMG_MIME: Record<string, string> = {
            jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png',
            gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml',
        };
        // Use data URLs (base64) instead of blob URLs — blob URLs become invalid after
        // page reload, which would break images loaded from IndexedDB cache.
        const imageBlobUrls: Record<string, string> = {};
        for ( const [ zipPath, zipData ] of Object.entries( zip ) ) {
            const ext = zipPath.split( '.' ).pop()?.toLowerCase() ?? '';
            if ( ! ( ext in IMG_MIME ) ) continue;
            let binary = '';
            const chunkSize = 8192;
            for ( let i = 0; i < zipData.length; i += chunkSize ) {
                binary += String.fromCharCode( ...zipData.subarray( i, i + chunkSize ) );
            }
            imageBlobUrls[ zipPath ] = `data:${ IMG_MIME[ ext ] };base64,${ btoa( binary ) }`;
        }

        // Spine — ordered linear items
        const spineContent = opfXml.match( /<spine[^>]*>([\s\S]*?)<\/spine>/ )?.[1] ?? '';
        const spineOrder: Array<{ idref: string; linear: boolean }> = [];
        const spineTagRegex = /<itemref\s+([^>]+)>/gi;
        let sTag: RegExpExecArray | null;
        while ( ( sTag = spineTagRegex.exec( spineContent ) ) !== null ) {
            const attrs  = sTag[ 1 ];
            const idref  = attrs.match( /\bidref="([^"]+)"/ )?.[1] ?? '';
            const linear = ! /\blinear="no"/i.test( attrs );
            if ( idref ) spineOrder.push( { idref, linear } );
        }

        // Build pages + href→pageIndex map for TOC resolution
        const hrefToPageIndex: Record<string, number> = {};
        // Maps element id → pageIndex so TOC entries with #fragments resolve correctly.
        // Many EPUBs store whole books in 1-2 files, separating chapters only by id anchors.
        const fragmentToPageIndex: Record<string, number> = {};
        const pages: ReaderPage[] = [];

        for ( const { idref, linear } of spineOrder ) {
            if ( ! linear ) continue;
            const item = manifestItems[ idref ];
            if ( ! item ) continue;

            const resourcePath = item.href;
            const fileData = zip[ resourcePath ];
            if ( ! fileData ) continue;

            const rawHtml = strFromU8( fileData );

            // Sanitised HTML via DOMPurify (robust XSS prevention)
            const bodyMatch = rawHtml.match( /<body[^>]*>([\s\S]*?)<\/body>/i );
            const rawBody = bodyMatch ? bodyMatch[ 1 ] : rawHtml;
            const htmlContent = DOMPurify.sanitize( rawBody, {
                ALLOWED_TAGS: [
                    'p', 'div', 'span', 'section', 'article',
                    'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
                    'a', 'img', 'figure', 'figcaption',
                    'ul', 'ol', 'li', 'dl', 'dt', 'dd',
                    'table', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td', 'caption',
                    'strong', 'em', 'b', 'i', 'u', 's', 'del', 'ins', 'mark',
                    'sup', 'sub', 'abbr', 'cite', 'q', 'blockquote', 'pre', 'code',
                    'br', 'hr', 'wbr',
                ],
                ALLOWED_ATTR: [ 'href', 'src', 'alt', 'title', 'class', 'id', 'lang', 'dir', 'epub:type', 'style' ],
                ALLOW_DATA_ATTR: false,
                FORBID_TAGS: [ 'script', 'style', 'iframe', 'frame', 'frameset', 'object', 'embed', 'form', 'input', 'button', 'link', 'base', 'meta', 'svg', 'math' ],
                FORBID_ATTR: [ 'onload', 'onerror', 'onclick', 'onmouseover', 'onfocus', 'onblur', 'onchange', 'onsubmit' ],
            } );

            // Plain text for search index using browser DOMParser to decode all HTML/XML entities correctly
            let textContent = '';
            try {
                const doc = new DOMParser().parseFromString( rawHtml, 'text/html' );
                doc.querySelectorAll( 'style, script' ).forEach( ( s ) => s.remove() );
                textContent = doc.body.textContent || doc.body.innerText || '';
            } catch {
                // Fallback to basic regex stripping if DOMParser fails
                textContent = rawHtml
                    .replace( /<style[^>]*>[\s\S]*?<\/style>/gi, '' )
                    .replace( /<script[^>]*>[\s\S]*?<\/script>/gi, '' )
                    .replace( /<[^>]+>/g, ' ' );
            }
            textContent = textContent.replace( /\s+/g, ' ' ).trim();

            if ( textContent.length === 0 && htmlContent.length === 0 ) continue;

            const pageIndex = pages.length;

            // Register both full path and relative path for TOC lookup
            hrefToPageIndex[ resourcePath ] = pageIndex;
            const relHref = resourcePath.startsWith( opfBaseDir )
                ? resourcePath.slice( opfBaseDir.length )
                : resourcePath;
            hrefToPageIndex[ relHref ] = pageIndex;
            // Also register basename alone (some NCX/nav files use only filename)
            const basename = resourcePath.split( '/' ).pop() ?? '';
            if ( basename && ! ( basename in hrefToPageIndex ) ) {
                hrefToPageIndex[ basename ] = pageIndex;
            }

            const label =
                rawHtml.match( /<title[^>]*>([^<]+)<\/title>/i )?.[1]?.trim()
                ?? rawHtml.match( /<h1[^>]*>([^<]*)<\/h1>/i )?.[1]
                    ?.replace( /<[^>]+>/g, '' ).trim();

            const parser = new DOMParser();
            const doc = parser.parseFromString( htmlContent, 'text/html' );

            // Resolve relative img src → blob URL so images render without network requests
            doc.querySelectorAll( 'img[src]' ).forEach( ( el ) => {
                const src = el.getAttribute( 'src' ) ?? '';
                if ( ! src || src.startsWith( 'blob:' ) || src.startsWith( 'data:' ) || src.startsWith( 'http' ) ) return;
                const resolved = this.resolveEpubPath( src, resourcePath );
                const blobUrl  = imageBlobUrls[ resolved ]
                    ?? imageBlobUrls[ opfBaseDir + resolved.split( '/' ).pop()! ];
                if ( blobUrl ) el.setAttribute( 'src', blobUrl );
            } );

            const children = Array.from( doc.body.children ) as HTMLElement[];

            if ( children.length === 0 ) {
                const pidx = pages.length;
                pages.push( { index: pidx, content: textContent, htmlContent: doc.body.innerHTML, label } );
                for ( const m of doc.body.innerHTML.matchAll( /\bid="([^"]+)"/g ) ) {
                    fragmentToPageIndex[ m[ 1 ] ] = pidx;
                }
            } else {
                const nodeHtmls = children.map( n => n.outerHTML );
                const chunks = this.chunkHtml( nodeHtmls, 8000 );
                chunks.forEach( ( chunk, ci ) => {
                    const pidx = pages.length;
                    pages.push( {
                        index: pidx,
                        content: chunk.content,
                        htmlContent: chunk.htmlContent ?? '',
                        label: ci === 0 ? ( label || undefined ) : undefined,
                    } );
                    for ( const m of ( chunk.htmlContent ?? '' ).matchAll( /\bid="([^"]+)"/g ) ) {
                        fragmentToPageIndex[ m[ 1 ] ] = pidx;
                    }
                } );
            }
        }

        if ( pages.length === 0 ) {
            pages.push( { index: 0, content: re( 'noTextContent' ), label: title } );
        }

        // Cover image
        let coverImage: string | undefined;
        const coverMetaId = opfXml.match( /<meta[^>]*name="cover"[^>]*content="([^"]+)"/ )?.[1];
        if ( coverMetaId && manifestItems[ coverMetaId ] ) {
            const coverPath = manifestItems[ coverMetaId ].href;
            coverImage = imageBlobUrls[ coverPath ];
        }
        if ( ! coverImage ) {
            const coverItem = Object.values( manifestItems ).find( ( i ) => i.properties.includes( 'cover-image' ) );
            if ( coverItem ) coverImage = imageBlobUrls[ coverItem.href ];
        }

        // Extract TOC
        const toc = this.extractEpubToc( zip, opfXml, opfBaseDir, manifestItems, hrefToPageIndex, fragmentToPageIndex );

        return {
            pages,
            metadata: { title, author, coverImage, totalPages: pages.length, format: 'epub' },
            toc,
        };
    }

    /* ---- TOC extraction ---- */

    private static extractEpubToc(
        zip: Record<string, Uint8Array>,
        opfXml: string,
        opfBaseDir: string,
        manifestItems: Record<string, EpubManifestItem>,
        hrefToPageIndex: Record<string, number>,
        fragmentToPageIndex: Record<string, number>,
    ): TocEntry[] {
        // EPUB3: nav document
        const navItem = Object.values( manifestItems ).find( ( i ) => i.properties.includes( 'nav' ) );
        if ( navItem && zip[ navItem.href ] ) {
            const navContent = strFromU8( zip[ navItem.href ] );
            const toc = this.parseNavXhtml( navContent, navItem.href, hrefToPageIndex, fragmentToPageIndex, opfBaseDir );
            if ( toc.length > 0 ) return toc;
        }

        // EPUB2: toc.ncx
        const ncxItem = Object.values( manifestItems ).find( ( i ) =>
            i.mediaType === 'application/x-dtbncx+xml',
        );
        if ( ncxItem && zip[ ncxItem.href ] ) {
            const ncxContent = strFromU8( zip[ ncxItem.href ] );
            return this.parseNcx( ncxContent, ncxItem.href, hrefToPageIndex, fragmentToPageIndex, opfBaseDir );
        }

        // Last resort: try known filenames
        const candidates = [ `${opfBaseDir}nav.xhtml`, `${opfBaseDir}toc.ncx`, 'nav.xhtml', 'toc.ncx' ];
        for ( const candidate of candidates ) {
            if ( zip[ candidate ] ) {
                const content = strFromU8( zip[ candidate ] );
                const toc = candidate.endsWith( '.ncx' )
                    ? this.parseNcx( content, candidate, hrefToPageIndex, fragmentToPageIndex, opfBaseDir )
                    : this.parseNavXhtml( content, candidate, hrefToPageIndex, fragmentToPageIndex, opfBaseDir );
                if ( toc.length > 0 ) return toc;
            }
        }

        return [];
    }

    private static parseNavXhtml(
        navContent: string,
        navFilePath: string,
        hrefToPageIndex: Record<string, number>,
        fragmentToPageIndex: Record<string, number>,
        opfBaseDir: string,
    ): TocEntry[] {
        const entries: TocEntry[] = [];

        // Use DOMParser (browser context) for reliable XML/XHTML parsing
        const parser = new DOMParser();
        let doc: Document;
        try {
            doc = parser.parseFromString( navContent, 'application/xhtml+xml' );
            if ( doc.querySelector( 'parsererror' ) ) {
                doc = parser.parseFromString( navContent, 'text/html' );
            }
        } catch {
            return entries;
        }

        // Find the TOC nav element
        const navElements = Array.from( doc.querySelectorAll( 'nav' ) );
        const tocNav =
            navElements.find( ( el ) =>
                el.getAttribute( 'epub:type' ) === 'toc' ||
                el.getAttributeNS( 'http://www.idpf.org/2007/ops', 'type' ) === 'toc' ||
                el.getAttribute( 'role' ) === 'doc-toc',
            ) ?? navElements[ 0 ];

        if ( ! tocNav ) return entries;

        const traverseOl = ( ol: Element, depth: number ) => {
            for ( const child of Array.from( ol.children ) ) {
                if ( child.tagName.toLowerCase() !== 'li' ) continue;

                const a = child.querySelector( 'a' );
                const rawLabel = ( a ?? child.querySelector( 'span' ) )?.textContent?.trim() ?? '';

                if ( a ) {
                    const rawHref  = a.getAttribute( 'href' ) ?? '';
                    const hashPos  = rawHref.indexOf( '#' );
                    const filePart = hashPos >= 0 ? rawHref.slice( 0, hashPos ) : rawHref;
                    const fragment = hashPos >= 0 ? rawHref.slice( hashPos + 1 ) : '';

                    if ( filePart || fragment ) {
                        const resolved = filePart ? this.resolveEpubPath( filePart, navFilePath ) : '';
                        const pageIndex =
                            // Fragment-based lookup first: many EPUBs store chapters as #anchors
                            ( fragment ? fragmentToPageIndex[ fragment ] : undefined ) ??
                            hrefToPageIndex[ resolved ] ??
                            hrefToPageIndex[ resolved.replace( opfBaseDir, '' ) ] ??
                            hrefToPageIndex[ resolved.split( '/' ).pop() ?? '' ] ??
                            -1;

                        if ( rawLabel && pageIndex >= 0 ) {
                            entries.push( { label: rawLabel, pageIndex, depth, fragmentId: fragment || undefined } );
                        }
                    }
                }

                const subOl = child.querySelector( 'ol' );
                if ( subOl ) traverseOl( subOl, depth + 1 );
            }
        };

        const firstOl = tocNav.querySelector( 'ol' );
        if ( firstOl ) traverseOl( firstOl, 0 );

        return entries;
    }

    private static parseNcx(
        ncxContent: string,
        ncxFilePath: string,
        hrefToPageIndex: Record<string, number>,
        fragmentToPageIndex: Record<string, number>,
        opfBaseDir: string,
    ): TocEntry[] {
        const entries: TocEntry[] = [];

        const parser = new DOMParser();
        let doc: Document;
        try {
            doc = parser.parseFromString( ncxContent, 'application/xml' );
        } catch {
            return entries;
        }

        const navMap =
            doc.querySelector( 'navMap' ) ??
            doc.getElementsByTagName( 'navMap' )[ 0 ];
        if ( ! navMap ) return entries;

        const traverseNavPoints = ( parent: Element, depth: number ) => {
            for ( const child of Array.from( parent.children ) ) {
                if ( child.localName !== 'navPoint' ) continue;

                const labelEl =
                    child.querySelector( 'navLabel > text' ) ??
                    child.getElementsByTagName( 'text' )[ 0 ];
                const contentEl =
                    child.querySelector( 'content' ) ??
                    child.getElementsByTagName( 'content' )[ 0 ];

                const label   = labelEl?.textContent?.trim() ?? '';
                const rawSrc  = contentEl?.getAttribute( 'src' ) ?? '';
                const hashPos = rawSrc.indexOf( '#' );
                const filePart = hashPos >= 0 ? rawSrc.slice( 0, hashPos ) : rawSrc;
                const fragment = hashPos >= 0 ? rawSrc.slice( hashPos + 1 ) : '';

                if ( filePart || fragment ) {
                    const resolved = filePart ? this.resolveEpubPath( filePart, ncxFilePath ) : '';
                    const pageIndex =
                        ( fragment ? fragmentToPageIndex[ fragment ] : undefined ) ??
                        hrefToPageIndex[ resolved ] ??
                        hrefToPageIndex[ resolved.replace( opfBaseDir, '' ) ] ??
                        hrefToPageIndex[ resolved.split( '/' ).pop() ?? '' ] ??
                        -1;

                    if ( label && pageIndex >= 0 ) {
                        entries.push( { label, pageIndex, depth, fragmentId: fragment || undefined } );
                    }
                }

                traverseNavPoints( child, depth + 1 );
            }
        };

        traverseNavPoints( navMap, 0 );
        return entries;
    }

    /** Resolve a relative href against the file that contains it. */
    private static resolveEpubPath( href: string, fromFilePath: string ): string {
        const path = href.split( '#' )[ 0 ];
        if ( ! path ) return '';
        if ( path.startsWith( 'http' ) ) return path;

        const fromDir = fromFilePath.includes( '/' )
            ? fromFilePath.substring( 0, fromFilePath.lastIndexOf( '/' ) + 1 )
            : '';

        const parts = ( fromDir + path ).split( '/' );
        const resolved: string[] = [];
        for ( const part of parts ) {
            if ( part === '..' ) resolved.pop();
            else if ( part !== '.' && part !== '' ) resolved.push( part );
        }
        return resolved.join( '/' );
    }

    /* ------------------------------------------------------------------ */
    /*  TXT                                                                */
    /* ------------------------------------------------------------------ */

    private static loadTxt( data: Uint8Array, encoding?: string ): ReaderLoadResult {
        const fullText = new TextDecoder( encoding || 'utf-8' ).decode( data );
        const pages = this.chunkText( fullText );
        return {
            pages,
            metadata: { title: re( 'textDocument' ), totalPages: pages.length, format: 'txt' },
            toc: [],
        };
    }

    /* ------------------------------------------------------------------ */
    /*  DOC (legacy binary OLE format)                                     */
    /* ------------------------------------------------------------------ */

    private static async loadDoc( data: Uint8Array ): Promise<ReaderLoadResult> {
        // If ZIP magic (PK) → file is OOXML mislabelled as .doc; delegate to mammoth.
        if ( data[ 0 ] === 0x50 && data[ 1 ] === 0x4B ) {
            try { return await this.loadDocx( data ); } catch { /* fall through to binary path */ }
        }

        // Genuine binary OLE2 DOC — heuristic UTF-16LE extraction.
        // Unicode ranges deliberately exclude Cyrillic (U+0400-04FF): those codepoints
        // coincide with OLE2 FAT/sector-chain bytes (0x00–0x04 hi byte), producing
        // garbage like "ЀāЀāЀā". Cyrillic support requires a proper OLE2 parser.
        const isTextCp = ( cp: number ): boolean => (
            ( cp >= 0x0020 && cp <= 0x007E ) ||  // Basic Latin
            ( cp >= 0x00A0 && cp <= 0x024F ) ||  // Latin-1 + Extended-A/B (incl. all Turkish)
            ( cp >= 0x0590 && cp <= 0x05FF ) ||  // Hebrew
            ( cp >= 0x0600 && cp <= 0x06FF ) ||  // Arabic
            ( cp >= 0x2010 && cp <= 0x2027 ) ||  // General Punctuation (quotes, dashes)
            cp === 0x000A || cp === 0x000D        // newlines
        );

        // Collect runs of consecutive valid codepoints.
        // BUG FIX: 0x000D (CR) was previously discarded — it is Word's paragraph-end
        // marker in binary DOC, so dropping it collapsed all content onto one "page".
        // Now we convert CR → LF so paragraph structure is preserved.
        const segments: string[] = [];
        let seg = '';
        let i = 0;
        while ( i + 1 < data.length ) {
            const cp = data[ i ] | ( data[ i + 1 ] << 8 );
            if ( isTextCp( cp ) ) {
                // CR (0x0D) = Word paragraph mark → treat as newline
                seg += String.fromCodePoint( cp === 0x000D ? 0x000A : cp );
                i += 2;
            } else {
                if ( seg.replace( /\s/g, '' ).length >= 8 ) segments.push( seg );
                seg = '';
                i += 1; // step 1 byte to resync after binary garbage
            }
        }
        if ( seg.replace( /\s/g, '' ).length >= 8 ) segments.push( seg );

        const rawText = segments
            .join( '\n' )
            .replace( /\r/g, '' )
            .replace( /[ \t]{6,}/g, '\n' )
            .replace( /\n{4,}/g, '\n\n\n' )
            .trim();

        if ( ! rawText ) {
            const empty = re( 'emptyFile' );
            return {
                pages: [ { index: 0, content: empty, htmlContent: `<p>${ empty }</p>` } ],
                metadata: { title: re( 'wordDocument' ), totalPages: 1, format: 'doc' },
                toc: [],
            };
        }

        // Convert extracted text to HTML so it benefits from:
        //  • the HTML renderer (styled, readable)
        //  • search highlight (highlightHtml in ReaderModal)
        //  • basic heading detection for TOC
        //
        // Heading heuristic: a paragraph that is a single short line without trailing
        // sentence punctuation, surrounded by paragraph breaks, is treated as <h2>.
        const paras = rawText.split( /\n{2,}/ );
        const htmlParts: string[] = [];

        for ( const para of paras ) {
            const trimmed = para.trim();
            if ( ! trimmed ) continue;
            const lines = trimmed.split( '\n' ).map( l => l.trim() ).filter( Boolean );
            if (
                lines.length === 1 &&
                trimmed.length >= 3 &&
                trimmed.length <= 100 &&
                ! /[.,;]$/.test( trimmed )
            ) {
                htmlParts.push( `<h2>${ trimmed }</h2>` );
            } else {
                htmlParts.push( lines.map( l => `<p>${ l }</p>` ).join( '' ) );
            }
        }

        const pages = this.chunkHtml( htmlParts, 1500 );

        // Build TOC from the first <h2> of each page
        const toc: TocEntry[] = [];
        for ( const page of pages ) {
            const m = page.htmlContent?.match( /<h2>([^<]+)<\/h2>/ );
            if ( m && ! toc.find( e => e.label === m[ 1 ] ) ) {
                toc.push( { label: m[ 1 ], pageIndex: page.index, depth: 0 } );
            }
        }

        const title = toc.length > 0 ? toc[ 0 ].label : re( 'wordDocument' );
        return {
            pages,
            metadata: { title, totalPages: pages.length, format: 'doc' },
            toc,
        };
    }

    /* ------------------------------------------------------------------ */
    /*  DOCX                                                               */
    /* ------------------------------------------------------------------ */

    private static async loadDocx( data: Uint8Array ): Promise<ReaderLoadResult> {
        const buf = data.buffer.slice( data.byteOffset, data.byteOffset + data.byteLength ) as ArrayBuffer;

        const { value: html } = await mammoth.convertToHtml( { arrayBuffer: buf } );

        const parser   = new DOMParser();
        const doc      = parser.parseFromString( html, 'text/html' );
        const children = Array.from( doc.body.children ) as HTMLElement[];

        // H1–H4 all start a new section; depth derived from heading level
        const HEADING_DEPTH: Record<string, number> = { H1: 0, H2: 1, H3: 2, H4: 3 };
        type Section = { headingTag: string; headingText: string; depth: number; nodes: HTMLElement[] };

        const rawSections: Section[] = [];
        let current: Section = { headingTag: '', headingText: '', depth: 0, nodes: [] };

        for ( const el of children ) {
            if ( el.tagName in HEADING_DEPTH ) {
                if ( current.nodes.length > 0 || current.headingText ) rawSections.push( current );
                current = {
                    headingTag:  el.tagName.toLowerCase(),
                    headingText: el.textContent?.trim() ?? '',
                    depth:       HEADING_DEPTH[ el.tagName ],
                    nodes:       [],
                };
            } else {
                current.nodes.push( el );
            }
        }
        if ( current.nodes.length > 0 || current.headingText ) rawSections.push( current );

        const hasHeadings = rawSections.some( s => s.headingText );

        // No headings at all → chunk the raw HTML paragraphs by length
        if ( ! hasHeadings || rawSections.length === 0 ) {
            const paragraphs = children.map( n => n.outerHTML );
            const fallback   = this.chunkHtml( paragraphs );
            return {
                pages:    fallback,
                metadata: { title: re( 'wordDocument' ), totalPages: fallback.length, format: 'docx' },
                toc:      [],
            };
        }

        // For each section, sub-split if the HTML content exceeds MAX_CHARS
        const MAX_CHARS = 1500;
        const pages: ReaderPage[] = [];
        const toc: TocEntry[]    = [];
        let bookTitle = re( 'wordDocument' );

        for ( const sec of rawSections ) {
            const headHtml   = sec.headingText
                ? `<${ sec.headingTag }>${ sec.headingText }</${ sec.headingTag }>\n`
                : '';
            const nodeHtmls  = sec.nodes.map( n => n.outerHTML );
            const totalChars = nodeHtmls.reduce( ( s, h ) => s + h.length, 0 );

            // Register TOC entry pointing to the first page of this section
            if ( sec.headingText ) {
                if ( sec.headingTag === 'h1' && bookTitle === re( 'wordDocument' ) ) bookTitle = sec.headingText;
                toc.push( { label: sec.headingText, pageIndex: pages.length, depth: sec.depth } );
            }

            if ( totalChars <= MAX_CHARS || nodeHtmls.length === 0 ) {
                // Section fits on one page
                const htmlContent = headHtml + nodeHtmls.join( '\n' );
                pages.push( {
                    index:       pages.length,
                    content:     ( sec.headingText + ' ' + sec.nodes.map( n => n.textContent ).join( ' ' ) ).replace( /\s+/g, ' ' ).trim(),
                    htmlContent,
                    label:       sec.headingText || undefined,
                } );
            } else {
                // Section is long — split into chunks; first chunk carries the heading
                const chunks = this.chunkHtml( nodeHtmls, MAX_CHARS );
                chunks.forEach( ( chunk, ci ) => {
                    pages.push( {
                        index:       pages.length,
                        content:     chunk.content,
                        htmlContent: ( ci === 0 ? headHtml : '' ) + ( chunk.htmlContent ?? '' ),
                        label:       ci === 0 ? ( sec.headingText || undefined ) : undefined,
                    } );
                } );
            }
        }

        return {
            pages,
            metadata: { title: bookTitle, totalPages: pages.length, format: 'docx' },
            toc,
        };
    }

    /** Chunk an array of HTML strings into pages capped at maxChars each. */
    private static chunkHtml( htmlParts: string[], maxChars = 6000 ): ReaderPage[] {
        const pages: ReaderPage[] = [];
        let htmlBuf  = '';
        let textBuf  = '';

        const flush = () => {
            if ( htmlBuf.trim() ) {
                pages.push( {
                    index:       pages.length,
                    content:     textBuf.replace( /\s+/g, ' ' ).trim(),
                    htmlContent: htmlBuf,
                } );
            }
            htmlBuf = '';
            textBuf = '';
        };

        for ( const part of htmlParts ) {
            if ( htmlBuf.length + part.length > maxChars && htmlBuf.length > 0 ) flush();
            htmlBuf += part + '\n';
            // Strip tags for plain-text search index
            textBuf += part.replace( /<[^>]+>/g, ' ' ) + ' ';
        }
        flush();
        return pages.length > 0 ? pages : [ { index: 0, content: '', htmlContent: '' } ];
    }

    /* ------------------------------------------------------------------ */
    /*  Shared helpers                                                     */
    /* ------------------------------------------------------------------ */

    private static chunkText( text: string ): ReaderPage[] {
        const pages: ReaderPage[] = [];
        const lines = text.split( '\n' );
        let chunk = '';

        for ( const line of lines ) {
            chunk += line + '\n';
            if ( chunk.length >= 1500 ) {
                if ( chunk.trim() ) pages.push( { index: pages.length, content: chunk.trim() } );
                chunk = '';
            }
        }
        if ( chunk.trim() ) pages.push( { index: pages.length, content: chunk.trim() } );
        if ( pages.length === 0 ) pages.push( { index: 0, content: text || re( 'emptyFile' ) } );
        return pages;
    }
}

export default ReaderEngine;
