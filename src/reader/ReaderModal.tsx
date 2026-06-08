/**
 * JetReader Reader Modal — Full-screen reader with:
 *  - EPUB: HTML rendering + TOC/Fihrist sidebar (NCX & nav.xhtml)
 *  - PDF: canvas rendering (PDF.js)
 *  - DOCX/TXT: plain-text rendering
 *  - Gece modu / sepia / light tema
 *  - Sayfa atlama input, içerik arama (Ctrl+F)
 *  - Annotations (highlights) + Bookmarks — API-first, localStorage fallback
 *  - Okuma pozisyonu localStorage'a kaydedilir (kitap/cilt bazında)
 *  - Mobil: TOC drawer (slide-in)
 *  - Çok ciltli kitaplar / çok sayılı dergiler — profesyonel cilt seçici
 *
 * @package JetReader
 */

import React, {
    useEffect,
    useState,
    useCallback,
    useRef,
    useMemo,
} from 'react';
import { createPortal } from 'react-dom';
import { motion, AnimatePresence } from 'framer-motion';
import DOMPurify from 'dompurify';
import {
    ReaderEngine,
    ReaderPage,
    ReaderMetadata,
    ReaderFormat,
    TocEntry,
    detectFormatFromUrl,
} from './ReaderEngine';
import { useTranslation } from '../i18n/I18nContext';
import { TextLayer } from 'pdfjs-dist';

/* ═══════════════════════════════════════════════════════════════════════ */
/*  Types                                                                  */
/* ═══════════════════════════════════════════════════════════════════════ */

interface ReaderPublicSettings {
    annotation_enabled: boolean;
    copy_enabled: boolean;
    logo_url: string;
}

interface ReaderAnnotation {
    id: string;
    remoteId?: number;
    pageIndex: number;
    text: string;
    note: string;
    color: string;
    createdAt: string;
}

interface ReaderBookmark {
    id: string;
    remoteId?: number;
    itemId: number;
    pageIndex: number;
    label: string;
    color: string;
    createdAt: string;
}

interface VolumeEntry {
    vol: number;
    file_path: string;
    file_type: string;
    cover_image: string;
    page_count?: number;
    encoding?: string;
}

interface ReaderModalProps {
    itemId: number;
    fileUrl: string;
    format: ReaderFormat;
    title: string;
    volumes?: VolumeEntry[];
    itemType?: string;
    onClose: () => void;
    /** 'page' = full-page mode, no close button (CPT single page) */
    pageMode?: 'modal' | 'page';
    /** Jump to this page index on first render */
    initialPage?: number;
    /** Open this volume index on first render (for multi-volume deeplinks) */
    initialVolume?: number;
    /** Auto-open search with this term on first render */
    initialSearch?: string;
    /** Raw excerpt anchor stored by the "Go" button as a fallback navigation hint */
    initialAnchor?: string;
    /** Custom character encoding for text files */
    encoding?: string;
}

/**
 * Typographic → keyboard character maps for universal search normalisation.
 * All replacements are 1:1 BMP code-unit swaps so indexMap in normalizeAndMap stays valid.
 *
 * Covers: straight ↔ curly quotes/apostrophes, Arabic romanization marks (ʾ/ʿ),
 * en-/em-dash, all Unicode dash variants, curly/guillemet double quotes, and
 * full-width ASCII variants (CJK documents).  User can type the plain keyboard
 * character and find any typographic variant in PDF/DOCX/EPUB content.
 */
// Single quotes / apostrophes → ' (U+0027)
// U+02BE = RIGHT HALF RING (Arabic romanization hamza), U+02BF = LEFT HALF RING (ʿain)
const _READER_APOS_RE   = /[‘’‚‛ʼʻ＇`´ʾʿ]/g;
// Double quotes → " (U+0022)
const _READER_DQUOTE_RE = /[“”„‟«»]/g;
// Dashes → - (U+002D): hyphen, en-dash, em-dash, minus sign, fullwidth variants
const _READER_DASH_RE   = /[‐‑‒–—―−﹣－]/g;
// Full-width ASCII punctuation → ASCII  (U+FFxx − 0xFEE0 = ASCII code)
const _READER_FWIDTH_RE = /[！？．，；：（）]/g;

/**
 * Normalise a string for search-query matching (query text AND PDF page text).
 * - NFC canonical form (handles combining diacritics for Greek, Arabic, etc.)
 * - Turkish İ → i  before toLowerCase; ı → i  after
 * - All apostrophe/quote/dash/full-width variants → ASCII equivalents
 * - toLowerCase: Latin, Cyrillic, Greek, Armenian, Georgian, etc.
 */
const normalizeQuery = (str: string): string => {
    return str
        .normalize('NFC')
        .replace(/[\r\n\t\u00A0\u2000-\u200A\u202F\u3000]/g, ' ')
        .replace(/\s+/g, ' ')
        .replace(/İ/g, 'i')
        .replace(_READER_APOS_RE,   "'")
        .replace(_READER_DQUOTE_RE, '"' )
        .replace(_READER_DASH_RE,   '-')
        .replace(_READER_FWIDTH_RE, (m) => String.fromCodePoint(m.codePointAt(0)! - 0xFEE0))
        .toLowerCase()
        .replace(/ı/g, 'i')
        .replace(/i̇/g, 'i')
        .trim();
};

/**
 * Locate the exact reader page index containing the initialAnchor snippet.
 */
const findAnchorPage = (
    anchor: string,
    pages: ReaderPage[],
    pdfTextCache: string[] | null,
    format: string
): { pageIndex: number; charOffset: number } | null => {
    const normAnchor = normalizeQuery(anchor);
    if (normAnchor.length < 5) return null; // too short to be unique

    if (format === 'pdf' && pdfTextCache) {
        for (let i = 0; i < pdfTextCache.length; i++) {
            const normContent = normalizeQuery(pdfTextCache[i]);
            const pos = normContent.indexOf(normAnchor);
            if (pos !== -1) {
                return { pageIndex: i, charOffset: pos };
            }
        }
    } else {
        for (let i = 0; i < pages.length; i++) {
            const normContent = normalizeQuery(pages[i].content ?? '');
            const pos = normContent.indexOf(normAnchor);
            if (pos !== -1) {
                return { pageIndex: i, charOffset: pos };
            }
        }
    }
    return null;
};

/**
 * Normalizes text for search and returns a map from normalized character indices
 * back to the original indices in the input string. Collapses all consecutive whitespaces
 * into a single standard space.
 */
const normalizeAndMap = (virt: string) => {
    let normalized = '';
    const indexMap: number[] = [];
    let inWhitespace = false;

    for (let i = 0; i < virt.length; i++) {
        const char = virt[i];
        const isSpace = /[\s\u00A0]/.test(char);

        if (isSpace) {
            if (!inWhitespace) {
                normalized += ' ';
                indexMap.push(i);
                inWhitespace = true;
            }
        } else {
            const normChar = char
                .replace(/İ/g, 'i')
                .replace(_READER_APOS_RE,   "'")
                .replace(_READER_DQUOTE_RE, '"' )
                .replace(_READER_DASH_RE,   '-')
                .replace(_READER_FWIDTH_RE, (m) => String.fromCodePoint(m.codePointAt(0)! - 0xFEE0))
                .toLowerCase()
                .replace(/ı/g, 'i')
                .replace(/i̇/g, 'i');
            
            normalized += normChar;
            for (let j = 0; j < normChar.length; j++) {
                indexMap.push(i);
            }
            inWhitespace = false;
        }
    }

    return { normalized, indexMap };
};

/**
 * Helper to perform Unicode-safe whole-word matching.
 */
const findMatchPositions = (text: string, query: string): number[] => {
    const q = query;
    const qLen = q.length;
    if (qLen < 2) return [];

    const isWordChar = (char: string) => /[\p{L}\p{N}]/u.test(char);
    const qStartsWord = isWordChar(q.charAt(0));
    const qEndsWord = isWordChar(q.charAt(qLen - 1));

    const positions: number[] = [];
    let pos = text.indexOf(q);
    while (pos !== -1) {
        let isValid = true;
        if (qStartsWord && pos > 0 && isWordChar(text.charAt(pos - 1))) {
            isValid = false;
        }
        if (qEndsWord && pos + qLen < text.length && isWordChar(text.charAt(pos + qLen))) {
            isValid = false;
        }
        if (isValid) {
            positions.push(pos);
        }
        pos = text.indexOf(q, pos + qLen);
    }
    return positions;
};

/**
 * Wrap query matches in <mark class="jr-search-hl"> inside an HTML string.
 * Only touches text nodes — skips content inside < > so tags stay intact.
 */
function highlightHtml(html: string, query: string, activeMatchIndex?: number | null): string {
    if (query.trim().length < 2) return html;

    try {
        const parser = new DOMParser();
        const doc = parser.parseFromString(`<div>${html}</div>`, 'text/html');
        const root = doc.body.firstChild as HTMLElement;
        if (!root) return html;

        // Collect all leaf text nodes and build a virtual concatenated string.
        // This lets us find matches that span across inline elements
        // (e.g. "they <em>are</em>" → virtual "they are" → match found).
        const textNodes: { node: Text; start: number; len: number }[] = [];
        let virt = '';
        const collect = (node: Node) => {
            if (node.nodeType === Node.TEXT_NODE) {
                const text = node.textContent ?? '';
                textNodes.push({ node: node as Text, start: virt.length, len: text.length });
                virt += text;
            } else if (node.nodeName.toLowerCase() !== 'mark' || !(node as HTMLElement).classList.contains('jr-search-hl')) {
                Array.from(node.childNodes).forEach(collect);
            }
        };
        collect(root);

        // Find all match positions in the normalized virtual text.
        const q = normalizeQuery(query);
        const { normalized: virtNorm, indexMap } = normalizeAndMap(virt);
        const ranges: { start: number; end: number; active: boolean }[] = [];
        let counter = 0;
        const matchedPositions = findMatchPositions(virtNorm, q);
        for (const p of matchedPositions) {
            const origStart = indexMap[p];
            const origEnd = indexMap[p + q.length - 1] + 1;
            ranges.push({ start: origStart, end: origEnd, active: counter === activeMatchIndex });
            counter++;
        }
        if (ranges.length === 0) return html;

        // Apply marks to text nodes. Process in reverse order so replacing a
        // node doesn't shift sibling indices for nodes we haven't processed yet.
        for (let ni = textNodes.length - 1; ni >= 0; ni--) {
            const { node, start: ns, len } = textNodes[ni];
            const ne = ns + len;
            const hits = ranges.filter(r => r.start < ne && r.end > ns);
            if (!hits.length) continue;

            const raw = node.textContent ?? '';
            const frag = doc.createDocumentFragment();
            let cursor = 0;

            for (const r of hits) {
                const ls = Math.max(r.start - ns, 0);
                const le = Math.min(r.end   - ns, len);
                if (ls > cursor) frag.appendChild(doc.createTextNode(raw.slice(cursor, ls)));
                const mark = doc.createElement('mark');
                mark.className = r.active ? 'jr-search-hl jr-search-hl-active' : 'jr-search-hl';
                mark.textContent = raw.slice(ls, le);
                frag.appendChild(mark);
                cursor = le;
            }
            if (cursor < len) frag.appendChild(doc.createTextNode(raw.slice(cursor)));
            node.parentNode?.replaceChild(frag, node);
        }

        return root.innerHTML;
    } catch {
        // Safe fallback
        let c = 0;
        const esc = query.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        return html.replace(new RegExp(`(${esc})`, 'gi'), (m) => {
            const active = c++ === activeMatchIndex;
            return `<mark class="${active ? 'jr-search-hl jr-search-hl-active' : 'jr-search-hl'}">${m}</mark>`;
        });
    }
}

/* ═══════════════════════════════════════════════════════════════════════ */
/*  Constants                                                              */
/* ═══════════════════════════════════════════════════════════════════════ */

const ANNOTATION_COLORS = ['#FFFF00', '#FF6B6B', '#51CF66', '#339AF0', '#CC5DE8', '#FF922B'];
const BOOKMARK_COLORS = ['#FFD700', '#FF6B6B', '#339AF0', '#51CF66'];
const API_BASE = ((window as any).jetreaderSettings?.apiUrl ?? '/wp-json/jetreader/v1').replace(/\/$/, '');
const dbg = (...args: unknown[]) => { if ((window as any).jetreaderSettings?.debug) console.warn('[JetReader]', ...args); };
const getNonce = (): string =>
    (window as any).jetreaderSettings?.nonce ??
    (window as any).wpApiSettings?.nonce ??
    '';

/* ═══════════════════════════════════════════════════════════════════════ */
/*  Global PDF Text Cache (LRU cache of size 10)                           */
/* ═══════════════════════════════════════════════════════════════════════ */
const pdfTextGlobalCache = new Map<string, string[]>();
const MAX_CACHE_SIZE = 10;

function setGlobalPdfCache(key: string, value: string[]) {
    if (pdfTextGlobalCache.has(key)) {
        pdfTextGlobalCache.delete(key);
    }
    pdfTextGlobalCache.set(key, value);
    if (pdfTextGlobalCache.size > MAX_CACHE_SIZE) {
        const oldestKey = pdfTextGlobalCache.keys().next().value;
        if (oldestKey !== undefined) {
            pdfTextGlobalCache.delete(oldestKey);
        }
    }
}

/* ═══════════════════════════════════════════════════════════════════════ */
/*  IndexedDB Persistent Cache for PDF Text                                */
/* ═══════════════════════════════════════════════════════════════════════ */
const DB_NAME = 'jetreader_cache';
const STORE_NAME = 'pdf_text_store';
const DB_VERSION = 1;

interface PdfDbCacheEntry {
    key: string;
    texts: string[];
    timestamp: number;
}

function openDB(): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
        if (!window.indexedDB) {
            reject(new Error('IndexedDB not supported'));
            return;
        }
        const request = window.indexedDB.open(DB_NAME, DB_VERSION);
        request.onerror = () => reject(request.error);
        request.onsuccess = () => resolve(request.result);
        request.onupgradeneeded = () => {
            const db = request.result;
            if (!db.objectStoreNames.contains(STORE_NAME)) {
                db.createObjectStore(STORE_NAME, { keyPath: 'key' });
            }
        };
    });
}

async function getCachedPdfText(key: string): Promise<string[] | null> {
    try {
        const db = await openDB();
        return new Promise((resolve) => {
            const transaction = db.transaction(STORE_NAME, 'readonly');
            const store = transaction.objectStore(STORE_NAME);
            const request = store.get(key);
            request.onerror = () => resolve(null);
            request.onsuccess = () => {
                const result = request.result as PdfDbCacheEntry | undefined;
                if (result && Array.isArray(result.texts)) {
                    // Update timestamp asynchronously to keep LRU correct
                    void updateTimestamp(key, result.texts);
                    resolve(result.texts);
                } else {
                    resolve(null);
                }
            };
        });
    } catch (e) {
        dbg('IndexedDB get error:', e);
        return null;
    }
}

async function updateTimestamp(key: string, texts: string[]): Promise<void> {
    try {
        const db = await openDB();
        const transaction = db.transaction(STORE_NAME, 'readwrite');
        const store = transaction.objectStore(STORE_NAME);
        store.put({ key, texts, timestamp: Date.now() });
    } catch {
        // ignore errors on bg timestamp updates
    }
}

async function setCachedPdfText(key: string, texts: string[]): Promise<void> {
    try {
        const db = await openDB();
        const transaction = db.transaction(STORE_NAME, 'readwrite');
        const store = transaction.objectStore(STORE_NAME);
        
        const MAX_DB_CACHE_SIZE = 20;
        
        // Save the new entry
        store.put({ key, texts, timestamp: Date.now() });
        
        // Clean up oldest items if limit is exceeded
        const allRequest = store.getAll();
        allRequest.onerror = () => {};
        allRequest.onsuccess = () => {
            const records = allRequest.result as PdfDbCacheEntry[];
            if (records.length > MAX_DB_CACHE_SIZE) {
                // Sort ascending by timestamp (oldest first)
                records.sort((a, b) => a.timestamp - b.timestamp);
                const toDelete = records.length - MAX_DB_CACHE_SIZE;
                for (let i = 0; i < toDelete; i++) {
                    store.delete(records[i].key);
                }
            }
        };
    } catch (e) {
        dbg('IndexedDB set error:', e);
    }
}


/* ═══════════════════════════════════════════════════════════════════════ */
/*  Sub-components                                                         */
/* ═══════════════════════════════════════════════════════════════════════ */

/**
 * PDF canvas renderer.
 * zoom=1 → fit-to-screen (no scroll, like Chrome default view).
 * zoom>1 → scale up (parent overflows → scrollable).
 */
const PdfCanvas: React.FC<{
    pdfDoc: any; pageNum: number; theme: string; zoom: number; searchQuery?: string;
}> = ({ pdfDoc, pageNum, theme, zoom, searchQuery }) => {
    const wrapperRef = useRef<HTMLDivElement>(null);
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const hlCanvasRef = useRef<HTMLCanvasElement>(null); // highlight overlay
    const renderTaskRef = useRef<any>(null);
    // Stored after each render so the highlight effect can use them without re-rendering
    const stateRef = useRef<{ page: any; viewport: any; dpr: number } | null>(null);
    const sqRef = useRef(searchQuery ?? '');
    useEffect(() => { sqRef.current = searchQuery ?? ''; }, [searchQuery]);

    // Draw yellow highlight rectangles for text items that match the query.
    // Only touches the overlay canvas — no PDF re-render needed.
    const drawHighlights = useCallback(async (query: string) => {
        const hlCanvas = hlCanvasRef.current;
        const state = stateRef.current;
        if (!hlCanvas || !state) return;

        const { page, viewport, dpr } = state;
        hlCanvas.width = Math.floor(viewport.width * dpr);
        hlCanvas.height = Math.floor(viewport.height * dpr);
        hlCanvas.style.width = `${viewport.width}px`;
        hlCanvas.style.height = `${viewport.height}px`;

        const ctx = hlCanvas.getContext('2d')!;
        ctx.clearRect(0, 0, hlCanvas.width, hlCanvas.height);

        const q = normalizeQuery(query);
        if (q.length < 2) return;

        const tc = await page.getTextContent();
        ctx.fillStyle = 'rgba(255, 213, 0, 0.45)';

        for (const item of tc.items as any[]) {
            if (typeof item.str !== 'string' || !item.str) continue;

            const lowerStr = normalizeQuery(item.str);
            const matchedPositions = findMatchPositions(lowerStr, q);
            if (matchedPositions.length === 0) continue;

            const [a, b, , , tx, ty] = item.transform as number[];
            const w = item.width as number;
            const h = (item.height as number) > 0 ? item.height : Math.hypot(a, b);
            const charWidth = w / item.str.length;

            for (const pos of matchedPositions) {
                const startX = tx + charWidth * pos;
                const matchW = charWidth * q.length;

                // Convert PDF user-space coordinates (bottom-left origin) to viewport CSS pixels.
                // ty is baseline; ty + h is the top of the glyph box.
                const [x1, y1] = viewport.convertToViewportPoint(startX, ty + h);
                const [x2, y2] = viewport.convertToViewportPoint(startX + matchW, ty);

                const rx = Math.min(x1, x2) * dpr;
                const ry = Math.min(y1, y2) * dpr;
                const rw = Math.abs(x2 - x1) * dpr;
                const rh = Math.abs(y2 - y1) * dpr;
                if (rw > 0 && rh > 0) ctx.fillRect(rx, ry, rw, rh);
            }
        }
    }, []); // uses only refs — stable forever

    // Main render effect: re-runs when page/zoom changes.
    useEffect(() => {
        let cancelled = false;
        stateRef.current = null;

        (async () => {
            if (!canvasRef.current || !wrapperRef.current) return;
            if (renderTaskRef.current) {
                try { renderTaskRef.current.cancel(); } catch { /* noop */ }
            }
            try {
                const page = await pdfDoc.getPage(pageNum);
                if (cancelled) return;

                const wrapper = wrapperRef.current!;
                const availW = wrapper.clientWidth - 16;
                const availH = wrapper.clientHeight - 16;
                const unscaled = page.getViewport({ scale: 1 });
                const baseScale = Math.min(availW / unscaled.width, availH / unscaled.height);
                const scale = Math.max(0.1, Math.min(baseScale * zoom, 5.0));
                const viewport = page.getViewport({ scale });
                const dpr = Math.min(window.devicePixelRatio ?? 1, 2);
                const canvas = canvasRef.current!;

                canvas.width = Math.floor(viewport.width * dpr);
                canvas.height = Math.floor(viewport.height * dpr);
                canvas.style.width = `${viewport.width}px`;
                canvas.style.height = `${viewport.height}px`;

                const ctx = canvas.getContext('2d')!;
                ctx.scale(dpr, dpr);

                const task = page.render({ canvasContext: ctx, viewport });
                renderTaskRef.current = task;
                await task.promise;

                if (!cancelled) {
                    stateRef.current = { page, viewport, dpr };
                    await drawHighlights(sqRef.current);
                }
            } catch (e: any) {
                if (!cancelled && e?.name !== 'RenderingCancelledException') {
                    dbg('PDF render error:', e);
                }
            }
        })();

        return () => {
            cancelled = true;
            try { renderTaskRef.current?.cancel(); } catch { /* noop */ }
        };
    }, [pdfDoc, pageNum, zoom, drawHighlights]);

    // Highlight-only effect: re-runs when searchQuery changes without re-rendering the PDF.
    useEffect(() => {
        void drawHighlights(searchQuery ?? '');
    }, [searchQuery, drawHighlights]);

    const isDark = theme === 'dark';

    return (
        <div
            ref={wrapperRef}
            className={zoom === 1
                ? 'absolute inset-0 flex items-center justify-center p-2'
                : 'flex items-center justify-center p-4 min-h-full min-w-full'
            }
        >
            {/* Wrapper keeps overlay canvas pixel-perfect over the main canvas */}
            <div style={{ position: 'relative', display: 'inline-block', lineHeight: 0 }}>
                <canvas
                    ref={canvasRef}
                    className={`rounded shadow-lg ${isDark ? 'shadow-black/60' : 'shadow-gray-500/30'}`}
                />
                <canvas
                    ref={hlCanvasRef}
                    style={{ position: 'absolute', top: 0, left: 0, pointerEvents: 'none', borderRadius: '0.25rem' }}
                />
            </div>
        </div>
    );
};

/* ──────────────────────────────────────────────────────────────────── */

/** Lazy thumbnail for one PDF page. Renders canvas only when scrolled into view. */
const THUMB_W = 110;

const PdfThumbnailItem = React.memo<{
    pdfDoc: any; pageNum: number; isActive: boolean;
    onClick: () => void; theme: string;
}>(({ pdfDoc, pageNum, isActive, onClick, theme }) => {
    const wrapperRef = useRef<HTMLDivElement>(null);
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const [visible, setVisible] = useState(false);

    useEffect(() => {
        const el = wrapperRef.current;
        if (!el) return;
        const obs = new IntersectionObserver(
            ([e]) => { if (e.isIntersecting) { setVisible(true); obs.disconnect(); } },
            { rootMargin: '300px' },
        );
        obs.observe(el);
        return () => obs.disconnect();
    }, []);

    useEffect(() => {
        if (!visible || !canvasRef.current) return;
        let cancelled = false;
        (async () => {
            try {
                const page = await pdfDoc.getPage(pageNum);
                if (cancelled) return;
                const canvas = canvasRef.current!;
                const unscaled = page.getViewport({ scale: 1 });
                const scale = THUMB_W / unscaled.width;
                const vp = page.getViewport({ scale });
                const dpr = Math.min(window.devicePixelRatio ?? 1, 2);
                canvas.width = Math.floor(vp.width * dpr);
                canvas.height = Math.floor(vp.height * dpr);
                canvas.style.width = `${vp.width}px`;
                canvas.style.height = `${vp.height}px`;
                const ctx = canvas.getContext('2d')!;
                ctx.scale(dpr, dpr);
                await page.render({ canvasContext: ctx, viewport: vp }).promise;
            } catch { /* cancelled or render error */ }
        })();
        return () => { cancelled = true; };
    }, [visible, pdfDoc, pageNum]);

    const isDark = theme === 'dark';
    const isSepia = theme === 'sepia';
    const activeClass = 'jr-item-active ring-2 ring-blue-500';
    const idleClass = 'jr-item-idle';
    const numCls = isActive ? 'font-bold' : 'jr-text-muted';

    return (
        <div
            ref={wrapperRef}
            onClick={onClick}
            className={`flex flex-col items-center px-1.5 py-1.5 mx-1 mb-1 rounded-lg cursor-pointer transition-all ${isActive ? activeClass : idleClass}`}
        >
            <div
                className={`rounded overflow-hidden shadow-sm ${isDark ? 'shadow-black/40' : 'shadow-gray-300/60'}`}
                style={{ width: THUMB_W }}
            >
                {visible
                    ? <canvas ref={canvasRef} className="block w-full" />
                    : <div className={`rounded jr-badge-bg`} style={{ width: THUMB_W, height: Math.round(THUMB_W * 1.414) }} />
                }
            </div>
            <span className={`text-xs font-medium mt-1 ${numCls}`}>{pageNum}</span>
        </div>
    );
});

/* ──────────────────────────────────────────────────────────────────── */

type SidebarFontStep = 'xs' | 'sm' | 'base' | 'lg' | 'xl';
const FONT_STEPS: SidebarFontStep[] = ['xs', 'sm', 'base', 'lg', 'xl'];

/** PDF sidebar — two tabs: page thumbnails & document outline. */
const PdfSidebar: React.FC<{
    pdfDoc: any;
    totalPages: number;
    currentPage: number;
    outline: TocEntry[];
    onJump: (page: number) => void;
    onClose: () => void;
    isMobile?: boolean;
    theme: string;
}> = ({ pdfDoc, totalPages, currentPage, outline, onJump, onClose, isMobile, theme }) => {
    const { t, locale } = useTranslation();
    const [mode, setMode] = useState<'thumbs' | 'outline'>(outline.length > 0 ? 'outline' : 'thumbs');
    const [fontStep, setFontStep] = useState<SidebarFontStep>('base');
    const activeThumbRef = useRef<HTMLDivElement>(null);

    const isDark = theme === 'dark';
    const isSepia = theme === 'sepia';

    const headerBgHex = isDark ? '#0d182d' : isSepia ? '#f9e6a0' : '#f1f5f9';
    const sidebarBgHex = isDark ? '#142440' : isSepia ? '#FDF0BC' : '#f8fafc';

    const fontBtnCls = isDark ? 'hover:bg-white/10' : isSepia ? 'hover:bg-amber-800/20' : 'hover:bg-black/5';

    const fontIdx = FONT_STEPS.indexOf(fontStep);
    const canGrow = fontIdx < FONT_STEPS.length - 1;
    const canShrink = fontIdx > 0;

    const activeOutlineIdx = useMemo(() =>
        outline.reduce((acc, e, i) => e.pageIndex <= currentPage ? i : acc, 0),
        [outline, currentPage],
    );

    useEffect(() => {
        if (mode === 'thumbs') {
            activeThumbRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        }
    }, [currentPage, mode]);

    return (
        <div
            className={`flex flex-col h-full overflow-hidden transition-colors duration-200 jr-sidebar`}
        >
            {/* Tab + font controls header */}
            <div className={`flex flex-col border-b shrink-0 jr-header`}>
                <div className="flex items-center justify-between pl-1 pr-2">
                    <div className="flex flex-1 divide-x divide-black/5 dark:divide-white/5">
                        {outline.length > 0 && (
                            <button
                                onClick={() => setMode('outline')}
                                className={`flex-1 !py-3 text-[11px] font-extrabold uppercase tracking-widest transition-all !border-b-2 whitespace-nowrap jr-btn-sidebar-tab ${mode === 'outline' ? 'jr-item-active' : '!border-transparent jr-item-idle jr-text-muted'}`}
                            >
                                {locale === 'tr' ? 'ANA HATLAR' : t('reader.pdfOutlineTab')}
                            </button>
                        )}
                        <button
                            onClick={() => setMode('thumbs')}
                            className={`flex-1 !py-3 text-[11px] font-extrabold uppercase tracking-widest transition-all !border-b-2 whitespace-nowrap jr-btn-sidebar-tab ${mode === 'thumbs' ? 'jr-item-active' : '!border-transparent jr-item-idle jr-text-muted'}`}
                        >
                            {locale === 'tr' ? 'SAYFALAR' : t('reader.pdfPagesTab')}
                        </button>
                    </div>
                    <div className="flex items-center gap-1 pr-1.5 pl-2 border-l border-black/5 dark:border-white/5">
                        <div className="jr-font-controls-container flex items-center gap-1 rounded-md !p-0.5">
                            <button
                                onClick={() => canShrink && setFontStep(FONT_STEPS[fontIdx - 1])}
                                disabled={!canShrink}
                                className={`!w-7 !h-7 flex items-center justify-center !rounded transition-colors ${fontBtnCls} jr-item-idle !p-0 disabled:opacity-30 disabled:cursor-not-allowed jr-btn-font-decrease`}
                                title={t('reader.pdfShrinkFont')}
                            >A−</button>
                            <button
                                onClick={() => canGrow && setFontStep(FONT_STEPS[fontIdx + 1])}
                                disabled={!canGrow}
                                className={`!w-7 !h-7 flex items-center justify-center !rounded transition-colors ${fontBtnCls} jr-item-idle !p-0 disabled:opacity-30 disabled:cursor-not-allowed jr-btn-font-increase`}
                                title={t('reader.pdfGrowFont')}
                            >A+</button>
                        </div>
                        <button onClick={onClose} className={`!ml-1 !w-7 !h-7 flex items-center justify-center !rounded-full hover:bg-black/10 dark:hover:bg-white/10 transition-colors jr-text-muted jr-item-idle !p-0 jr-btn-sidebar-close`}>✕</button>
                    </div>
                </div>
            </div>

            {/* Content */}
            <div className={`flex-1 overflow-y-auto overflow-x-hidden overscroll-contain jr-scrollbar ${mode === 'thumbs' ? '' : `jr-sidebar-font-${fontStep}`}`}>
                {mode === 'thumbs' ? (
                    <div className="py-2">
                        {Array.from({ length: totalPages }, (_, i) => (
                            <div key={i} ref={i === currentPage ? activeThumbRef : undefined}>
                                <PdfThumbnailItem
                                    pdfDoc={pdfDoc}
                                    pageNum={i + 1}
                                    isActive={i === currentPage}
                                    onClick={() => { onJump(i); if (isMobile) onClose(); }}
                                    theme={theme}
                                />
                            </div>
                        ))}
                    </div>
                ) : (
                    <div className="py-1.5">
                        {outline.map((entry, i) => {
                            const depth = entry.depth ?? 0;
                            return (
                                <button
                                    key={i}
                                    onClick={() => { onJump(entry.pageIndex); if (isMobile) onClose(); }}
                                    className={`reader-sidebar-list-item text-left py-2.5 pr-4 transition-all border-b border-transparent jr-border ${i === activeOutlineIdx ? 'jr-item-active' : 'jr-item-idle'}`}
                                    style={{
                                        paddingLeft: `${depth * 16 + 16}px`,
                                        ['--jr-toc-depth-padding' as any]: `${depth * 16 + 16}px`
                                    }}
                                    data-depth={depth}
                                    title={`${entry.label} — s.${entry.pageIndex + 1}`}
                                >
                                    <div className="flex items-start justify-between gap-3 min-w-0">
                                        <div className="flex items-start gap-2 min-w-0">
                                            {i === activeOutlineIdx && (
                                                <div className="shrink-0 w-1.5 h-1.5 rounded-full bg-blue-500 shadow-sm mt-1.5" />
                                            )}
                                            <span className="min-w-0 leading-snug break-words">{entry.label}</span>
                                        </div>
                                        <span className="shrink-0 text-[10px] font-semibold tabular-nums px-1.5 py-0.5 rounded mt-0.5 jr-badge-bg jr-text-muted">
                                            {entry.pageIndex + 1}
                                        </span>
                                    </div>
                                </button>
                            );
                        })}
                    </div>
                )}
            </div>
        </div>
    );
};

/* ──────────────────────────────────────────────────────────────────── */

/** One page in the continuous-scroll PDF view.
 *  Lazy-renders when near viewport; unrenders when far away to cap memory. */
const PdfScrollPage = React.memo<{
    pdfDoc: any;
    pageNum: number;   // 1-based
    canvasW: number;   // target CSS width
    canvasH: number;   // estimated CSS height (placeholder)
    theme: string;
    searchQuery: string;
    activeMatchIndex: number | null;
    pageIndex: number;
    cpObserver: IntersectionObserver | null;  // current-page observer from parent
    onRef: (el: HTMLDivElement | null, index: number) => void;
    annotationEnabled: boolean;
    forceRender: boolean;
    containerEl: HTMLDivElement | null;
    currentPage: number;
    centerTrigger: number;
}>(({ pdfDoc, pageNum, canvasW, canvasH, theme, searchQuery, activeMatchIndex, pageIndex, cpObserver, onRef, annotationEnabled, forceRender, containerEl, currentPage, centerTrigger }) => {
    const divRef = useRef<HTMLDivElement>(null);
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const hlCanvasRef = useRef<HTMLCanvasElement>(null);
    const textLayerRef = useRef<HTMLDivElement>(null);
    const renderRef = useRef<any>(null);
    const stateRef = useRef<{ page: any; viewport: any; dpr: number } | null>(null);
    const sqRef = useRef(searchQuery);
    const drawGenRef = useRef(0); // race-condition guard
    const minYRef = useRef<number | null>(null);
    const lastCenterTriggerRef = useRef(0);
    const currentPageRef = useRef(currentPage);
    const centerTriggerRef = useRef(centerTrigger);
    const containerElRef = useRef(containerEl);
    const activeMatchIndexRef = useRef(activeMatchIndex);

    useEffect(() => { sqRef.current = searchQuery; }, [searchQuery]);
    useEffect(() => { currentPageRef.current = currentPage; }, [currentPage]);
    useEffect(() => { centerTriggerRef.current = centerTrigger; }, [centerTrigger]);
    useEffect(() => { containerElRef.current = containerEl; }, [containerEl]);
    useEffect(() => { activeMatchIndexRef.current = activeMatchIndex; }, [activeMatchIndex]);

    // Center highlight when currentPage/centerTrigger changes (for already-rendered pages)
    useEffect(() => {
        if (pageIndex === currentPage && 
            containerEl && 
            centerTrigger > lastCenterTriggerRef.current && 
            minYRef.current !== null && 
            divRef.current) {
            const highlightTopInContainer = divRef.current.offsetTop + minYRef.current;
            const targetScrollTop = highlightTopInContainer - containerEl.clientHeight / 2;
            containerEl.scrollTo({
                top: Math.max(0, targetScrollTop),
                behavior: 'smooth'
            });
            lastCenterTriggerRef.current = centerTrigger;
        }
    }, [currentPage, centerTrigger, searchQuery, pageIndex, containerEl]);

    // isNear: true when within 150% viewport — triggers canvas render
    const [isNear, setIsNear] = useState(false);
    useEffect(() => {
        const el = divRef.current;
        if (!el) return;
        const obs = new IntersectionObserver(
            ([e]) => setIsNear(e.isIntersecting),
            { 
                root: containerEl,
                rootMargin: '150% 0px' 
            }
        );
        obs.observe(el);
        return () => obs.disconnect();
    }, [containerEl]);

    // Register with the parent's current-page observer
    useEffect(() => {
        const el = divRef.current;
        if (!el || !cpObserver) return;
        cpObserver.observe(el);
        return () => cpObserver.unobserve(el);
    }, [cpObserver]);

    // Expose div ref to parent (for scrollIntoView)
    const setRef = useCallback((el: HTMLDivElement | null) => {
        (divRef as React.MutableRefObject<HTMLDivElement | null>).current = el;
        onRef(el, pageIndex);
    }, [onRef, pageIndex]);

    // Highlight overlay.
    // Fixes: (1) race condition via generation counter, (2) cross-item query matching
    // by building full-page text and mapping match positions back to items.
    const drawHighlights = useCallback(async (query: string) => {
        const gen = ++drawGenRef.current;
        const state = stateRef.current;
        if (!state) return;

        const { page, viewport, dpr } = state;
        const normalize = (str: string): string => {
            return normalizeQuery(str);
        };

        const q = normalize(query);
        const activeMatchIndexValue = activeMatchIndexRef.current;

        // Do ALL async work before touching the canvas to avoid partial-clear flicker.
        let items: any[] = [];
        let ranges: [number, number][] = [];
        let normFullText = '';
        let hasMatches = false;

        if (q.length >= 2) {
            try {
                const tc = await page.getTextContent();
                if (gen !== drawGenRef.current) return; // superseded by newer call

                items = (tc.items as any[]).filter((it) => typeof it.str === 'string');

                // Build full page text and per-item character ranges (same logic as extraction).
                let charIdx = 0;
                let fullText = '';
                for (const item of items) {
                    const itemStr = item.str + (item.hasEOL ? ' ' : '');
                    ranges.push([charIdx, charIdx + itemStr.length]);
                    fullText += itemStr;
                    charIdx += itemStr.length;
                }
                normFullText = normalize(fullText);
                hasMatches = findMatchPositions(normFullText, q).length > 0;
            } catch { return; }
        }

        if (gen !== drawGenRef.current) return; // superseded

        // Safe to mutate canvas now.
        const hlCanvas = hlCanvasRef.current;
        if (!hlCanvas) return;
        hlCanvas.width = Math.round(viewport.width * dpr);
        hlCanvas.height = Math.round(viewport.height * dpr);
        hlCanvas.style.width = `${viewport.width}px`;
        hlCanvas.style.height = `${viewport.height}px`;
        const ctx = hlCanvas.getContext('2d')!;
        ctx.clearRect(0, 0, hlCanvas.width, hlCanvas.height);

        if (!hasMatches) {
            minYRef.current = null;
            return;
        }

        const matchedPositions = findMatchPositions(normFullText, q);

        // Loop 1: Draw all yellow (non-active) matches
        let occurrenceIdx = 0;
        for (const pos of matchedPositions) {
            const matchEnd = pos + q.length;
            const isActive = activeMatchIndexValue !== undefined && activeMatchIndexValue !== null && occurrenceIdx === activeMatchIndexValue;

            if (!isActive) {
                ctx.fillStyle = 'rgba(255, 213, 0, 0.45)';
                for (let i = 0; i < items.length; i++) {
                    const [s, e] = ranges[i];
                    if (s < matchEnd && e > pos) {
                        const item = items[i];
                        const itemLen = item.str.length;
                        const localStart = Math.max(0, Math.min(Math.max(pos, s) - s, itemLen));
                        const localEnd = Math.max(0, Math.min(Math.min(matchEnd, e) - s, itemLen));

                        const [a, b, , , tx, ty] = item.transform as number[];
                        const w = item.width as number;
                        const h = (item.height as number) > 0 ? item.height : Math.hypot(a, b);
                        const charWidth = itemLen > 0 ? w / itemLen : 0;
                        const startX = tx + charWidth * localStart;
                        const matchW = charWidth * (localEnd - localStart);

                        const [x1, y1] = viewport.convertToViewportPoint(startX, ty + h);
                        const [x2, y2] = viewport.convertToViewportPoint(startX + matchW, ty);
                        const rx = Math.min(x1, x2) * dpr;
                        const ry = Math.min(y1, y2) * dpr;
                        const rw = Math.abs(x2 - x1) * dpr;
                        const rh = Math.abs(y2 - y1) * dpr;
                        if (rw > 0 && rh > 0) ctx.fillRect(rx, ry, rw, rh);
                    }
                }
            }
            occurrenceIdx++;
        }

        // Loop 2: Draw the active orange match if present
        let minY = Infinity;
        if (activeMatchIndexValue !== undefined && activeMatchIndexValue !== null) {
            occurrenceIdx = 0;
            for (const pos of matchedPositions) {
                const matchEnd = pos + q.length;
                const isActive = occurrenceIdx === activeMatchIndexValue;

                if (isActive) {
                    ctx.fillStyle = 'rgba(255, 110, 0, 0.6)';
                    for (let i = 0; i < items.length; i++) {
                        const [s, e] = ranges[i];
                        if (s < matchEnd && e > pos) {
                            const item = items[i];
                            const itemLen = item.str.length;
                            const localStart = Math.max(0, Math.min(Math.max(pos, s) - s, itemLen));
                            const localEnd = Math.max(0, Math.min(Math.min(matchEnd, e) - s, itemLen));

                            const [a, b, , , tx, ty] = item.transform as number[];
                            const w = item.width as number;
                            const h = (item.height as number) > 0 ? item.height : Math.hypot(a, b);
                            const charWidth = itemLen > 0 ? w / itemLen : 0;
                            const startX = tx + charWidth * localStart;
                            const matchW = charWidth * (localEnd - localStart);

                            const [x1, y1] = viewport.convertToViewportPoint(startX, ty + h);
                            const [x2, y2] = viewport.convertToViewportPoint(startX + matchW, ty);
                            const rx = Math.min(x1, x2) * dpr;
                            const ry = Math.min(y1, y2) * dpr;
                            const rw = Math.abs(x2 - x1) * dpr;
                            const rh = Math.abs(y2 - y1) * dpr;
                            if (rw > 0 && rh > 0) ctx.fillRect(rx, ry, rw, rh);

                            const ryCSS = Math.min(y1, y2);
                            if (ryCSS < minY) {
                                minY = ryCSS;
                            }
                        }
                    }
                    break;
                }
                occurrenceIdx++;
            }
        }

        minYRef.current = minY !== Infinity ? minY : null;

        // Check if we need to center after drawing highlights
        if (pageIndex === currentPageRef.current && 
            containerElRef.current && 
            centerTriggerRef.current > lastCenterTriggerRef.current && 
            minY !== Infinity) {
            const div = divRef.current;
            if (div) {
                const highlightTopInContainer = div.offsetTop + minY;
                const targetScrollTop = highlightTopInContainer - containerElRef.current.clientHeight / 2;
                containerElRef.current.scrollTo({
                    top: Math.max(0, targetScrollTop),
                    behavior: 'smooth'
                });
                lastCenterTriggerRef.current = centerTriggerRef.current;
            }
        }
    }, [pageIndex]); // uses only refs — stable forever

    // Main render: fires when shouldRender or canvasW changes
    const shouldRender = isNear || forceRender;
    useEffect(() => {
        if (!shouldRender) {
            try { renderRef.current?.cancel(); } catch { /* noop */ }
            stateRef.current = null;
            return;
        }
        if (!canvasRef.current) return;
        let cancelled = false;
        (async () => {
            try { renderRef.current?.cancel(); } catch { /* noop */ }
            try {
                const page = await pdfDoc.getPage(pageNum);
                if (cancelled) return;
                const unscaled = page.getViewport({ scale: 1 });
                const scale = canvasW / unscaled.width;
                const viewport = page.getViewport({ scale });
                const dpr = Math.min(window.devicePixelRatio ?? 1, 2);
                const canvas = canvasRef.current!;
                canvas.width = Math.round(viewport.width * dpr);
                canvas.height = Math.round(viewport.height * dpr);
                canvas.style.width = `${viewport.width}px`;
                canvas.style.height = `${viewport.height}px`;
                const ctx = canvas.getContext('2d')!;
                ctx.scale(dpr, dpr);
                const task = page.render({ canvasContext: ctx, viewport });
                renderRef.current = task;
                await task.promise;
                if (!cancelled) {
                    stateRef.current = { page, viewport, dpr };
                    await drawHighlights(sqRef.current);

                    // Text layer — transparent selectable spans for annotation.
                    // --scale-factor must be set before TextLayer constructor because
                     // setLayerDimensions() uses it in calc() for width/height/font-size.
                    const textLayerDiv = textLayerRef.current;
                    if (textLayerDiv) {
                        textLayerDiv.innerHTML = '';
                        textLayerDiv.style.setProperty('--scale-factor', String(viewport.scale));
                        try {
                            const layer = new TextLayer({
                                textContentSource: page.streamTextContent(),
                                container: textLayerDiv,
                                viewport,
                            });
                            await layer.render();
                        } catch (e) {
                            dbg(`PDF text layer p${pageNum}:`, e);
                        }
                    }
                }
            } catch (e: any) {
                if (!cancelled && e?.name !== 'RenderingCancelledException')
                    dbg(`PDF p${pageNum}:`, e);
            }
        })();
        return () => {
            cancelled = true;
            try { renderRef.current?.cancel(); } catch { /* noop */ }
            if (textLayerRef.current) textLayerRef.current.innerHTML = '';
        };
    }, [shouldRender, pdfDoc, pageNum, canvasW, drawHighlights]);

    // Highlight-only effect (no re-render of PDF)
    useEffect(() => {
        if (stateRef.current) void drawHighlights(searchQuery);
    }, [searchQuery, activeMatchIndex, drawHighlights]);

    const isDark = theme === 'dark';
    const isSepia = theme === 'sepia';

    return (
        <div
            ref={setRef}
            data-page-index={pageIndex}
            style={{ width: canvasW, height: canvasH, position: 'relative', flexShrink: 0, overflow: 'hidden' }}
            className={`rounded shadow-md ${isDark ? 'shadow-black/60' : 'shadow-gray-500/30'}`}
        >
            {shouldRender ? (
                <>
                    <canvas ref={canvasRef} className="rounded" />
                    <canvas
                        ref={hlCanvasRef}
                        style={{ position: 'absolute', top: 0, left: 0, pointerEvents: 'none', borderRadius: '0.25rem' }}
                    />
                    <div
                        ref={textLayerRef}
                        className={`jr-pdf-text-layer${annotationEnabled ? ' jr-select-enabled' : ''}`}
                    />
                </>
            ) : (
                <div className={`w-full h-full rounded animate-pulse ${isDark ? 'bg-gray-800' : isSepia ? 'bg-amber-100' : 'bg-gray-200'}`} />
            )}
        </div>
    );
});

/* ──────────────────────────────────────────────────────────────────── */

/** Continuous-scroll PDF viewer — all pages stacked, lazy rendered. */
const PdfScrollView: React.FC<{
    pdfDoc: any;
    totalPages: number;
    currentPage: number;
    zoom: number;
    dualPage: boolean;
    theme: string;
    searchQuery: string;
    searchMatches: { pageIndex: number; matchIndex: number }[];
    searchMatchIdx: number;
    searchScrollKey: number;
    annotationEnabled: boolean;
    onPageChange: (page: number) => void;
}> = ({ pdfDoc, totalPages, currentPage, zoom, dualPage, theme, searchQuery, searchMatches, searchMatchIdx, searchScrollKey, annotationEnabled, onPageChange }) => {
    const containerRef = useRef<HTMLDivElement>(null);
    const pageRefs = useRef<(HTMLDivElement | null)[]>([]);
    const internalPageRef = useRef(-1);
    const isScrollingRef = useRef(false);
    const onChangeRef = useRef(onPageChange);
    useEffect(() => { onChangeRef.current = onPageChange; }, [onPageChange]);

    const [containerWidth, setContainerWidth] = useState(0);
    const [pageAspect, setPageAspect] = useState(1.414); // A4 fallback
    const [containerEl, setContainerEl] = useState<HTMLDivElement | null>(null);
    const isInitialScrollDone = useRef(false);
    const searchScrollActiveRef = useRef(false);
    const [centerTrigger, setCenterTrigger] = useState(0);

    useEffect(() => {
        setContainerEl(containerRef.current);
    }, []);

    useEffect(() => {
        const timer = setTimeout(() => {
            isInitialScrollDone.current = true;
        }, 2000);
        return () => clearTimeout(timer);
    }, []);

    // Track container width via ResizeObserver
    useEffect(() => {
        const el = containerRef.current;
        if (!el) return;
        setContainerWidth(el.clientWidth);
        const obs = new ResizeObserver(([e]) => setContainerWidth(e.contentRect.width));
        obs.observe(el);
        return () => obs.disconnect();
    }, []);

    // Get page-1 aspect ratio for placeholder sizing
    useEffect(() => {
        (async () => {
            const page = await pdfDoc.getPage(1);
            const vp = page.getViewport({ scale: 1 });
            setPageAspect(vp.height / vp.width);
        })();
    }, [pdfDoc]);

    // Shared IntersectionObserver to track which page is most visible
    const [cpObserver, setCpObserver] = useState<IntersectionObserver | null>(null);
    useEffect(() => {
        if (!containerEl) return;
        const ratioMap = new Map<number, number>();
        const obs = new IntersectionObserver((entries) => {
            entries.forEach(e => {
                const idx = parseInt((e.target as HTMLElement).dataset.pageIndex ?? '0', 10);
                ratioMap.set(idx, e.intersectionRatio);
            });
            if (isScrollingRef.current || !isInitialScrollDone.current) return;
            let maxRatio = 0, maxPage = internalPageRef.current;
            ratioMap.forEach((r, p) => { if (r > maxRatio) { maxRatio = r; maxPage = p; } });
            if (maxPage !== internalPageRef.current && maxRatio > 0.05) {
                internalPageRef.current = maxPage;
                onChangeRef.current(maxPage);
            }
        }, { 
            root: containerEl,
            threshold: [0, 0.1, 0.3, 0.5, 0.7, 1] 
        });
        setCpObserver(obs);
        return () => { obs.disconnect(); setCpObserver(null); };
    }, [containerEl]);

    // Target page scroll helper
    const scrollToPage = useCallback((page: number) => {
        const el = pageRefs.current[page];
        if (!el) return false;
        isScrollingRef.current = true;
        const diff = Math.abs(page - Math.max(0, internalPageRef.current));
        const isInitial = !isInitialScrollDone.current;
        const behavior = (isInitial || searchScrollActiveRef.current || diff > 5) 
            ? 'instant' as ScrollBehavior 
            : 'smooth';

        el.scrollIntoView({ behavior, block: 'start' });
        internalPageRef.current = page;
        
        setCenterTrigger(Date.now());

        setTimeout(() => { 
            isScrollingRef.current = false; 
            isInitialScrollDone.current = true;
        }, 700);
        return true;
    }, []);

    // Scroll to page when currentPage prop changes externally (nav buttons / keyboard / deeplink).
    // Also depends on containerWidth: page <div>s don't exist until ResizeObserver fires
    // (containerWidth goes from 0 → N), so the first scroll attempt would silently no-op
    // if we only depended on currentPage. Re-running when containerWidth becomes non-zero
    // retries the scroll after the DOM is populated.
    useEffect(() => {
        if (containerWidth === 0) return; // page elements not yet in DOM
        if (currentPage === internalPageRef.current) return;
        scrollToPage(currentPage);
    }, [currentPage, containerWidth, scrollToPage]);

    // Center highlight when search query changes
    useEffect(() => {
        if (searchQuery && searchQuery.trim().length >= 2) {
            setCenterTrigger(Date.now());
        }
    }, [searchQuery]);

    // Center highlight when search scroll key changes
    useEffect(() => {
        if (searchScrollKey > 0) {
            searchScrollActiveRef.current = true;
            isScrollingRef.current = true; // Block IntersectionObserver
            setCenterTrigger(Date.now());
            const timer = setTimeout(() => {
                searchScrollActiveRef.current = false;
                isScrollingRef.current = false;
            }, 800);
            return () => clearTimeout(timer);
        }
    }, [searchScrollKey]);

    const onPageRef = useCallback((el: HTMLDivElement | null, index: number) => {
        pageRefs.current[index] = el;
        // If the mounted page is the current target page, try to scroll to it
        if (el && index === currentPage && internalPageRef.current !== index) {
            scrollToPage(index);
        }
    }, [currentPage, scrollToPage]);

    // Single page: full container width × zoom
    // Dual page: half container width × zoom, with 2px gap between pages
    const usable = Math.max(0, containerWidth - 32);
    const canvasW = dualPage
        ? Math.round((usable / 2 - 1) * zoom)   // half minus 1px for the centre divider
        : Math.round(usable * zoom);
    const canvasH = Math.round(canvasW * pageAspect);

    const bg = theme === 'dark' ? 'bg-gray-900'
        : theme === 'sepia' ? 'bg-amber-50/80'
            : 'bg-gray-300';

    const pageEl = (i: number) => {
        const forceRender = Math.abs(i - currentPage) <= (dualPage ? 2 : 1);
        const activeMatch = searchMatches[searchMatchIdx];
        const activeMatchIndex = activeMatch && activeMatch.pageIndex === i ? activeMatch.matchIndex : null;
        return (
            <PdfScrollPage
                key={i}
                pdfDoc={pdfDoc}
                pageNum={i + 1}
                canvasW={canvasW}
                canvasH={canvasH}
                theme={theme}
                searchQuery={searchQuery}
                activeMatchIndex={activeMatchIndex}
                pageIndex={i}
                cpObserver={cpObserver}
                onRef={onPageRef}
                annotationEnabled={annotationEnabled}
                forceRender={forceRender}
                containerEl={containerEl}
                currentPage={currentPage}
                centerTrigger={centerTrigger}
            />
        );
    };

    return (
        <div ref={containerRef} className={`absolute inset-0 overflow-y-auto overflow-x-auto ${bg}`}>
            {containerWidth > 0 && canvasW > 0 && (
                <div className={`flex flex-col items-center gap-3 py-4 px-4 min-w-max`}>
                    {dualPage ? (
                        // Dual page: pairs of pages side by side, 2px gap
                        Array.from({ length: Math.ceil(totalPages / 2) }, (_, row) => {
                            const left = row * 2;
                            const right = left + 1;
                            return (
                                <div key={row} className="flex gap-0.5 items-start">
                                    {pageEl(left)}
                                    {right < totalPages ? pageEl(right) : (
                                        // Blank right half on odd-page books
                                        <div style={{ width: canvasW, height: canvasH }}
                                            className={`rounded ${theme === 'dark' ? 'bg-gray-800/40' : 'bg-gray-400/20'}`}
                                            />
                                    )}
                                </div>
                            );
                        })
                    ) : (
                        // Single page: one column
                        Array.from({ length: totalPages }, (_, i) => pageEl(i))
                    )}
                </div>
            )}
        </div>
    );
};

/* ──────────────────────────────────────────────────────────────────── */

/** TOC / Fihrist sidebar list. Used both in desktop aside and mobile drawer. */
const TocSidebar: React.FC<{
    toc: TocEntry[];
    currentPage: number;
    onJump: (pageIndex: number, fragmentId?: string) => void;
    onClose: () => void;
    isMobile?: boolean;
    theme: string;
}> = ({ toc, currentPage, onJump, onClose, isMobile, theme }) => {
    const { t, locale } = useTranslation();
    const activeRef = useRef<HTMLButtonElement>(null);
    const [fontStep, setFontStep] = useState<SidebarFontStep>('base');

    const activeIdx = useMemo(() =>
        toc.reduce((acc, entry, i) => (entry.pageIndex <= currentPage ? i : acc), 0),
        [toc, currentPage],
    );

    useEffect(() => {
        activeRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }, [activeIdx]);

    const isDark = theme === 'dark';
    const isSepia = theme === 'sepia';

    const headerBgHex = isDark ? '#0d182d' : isSepia ? '#f9e6a0' : '#f1f5f9';
    const sidebarBgHex = isDark ? '#142440' : isSepia ? '#FDF0BC' : '#f8fafc';

    const fontBtnCls = isDark ? 'hover:bg-white/10' : isSepia ? 'hover:bg-amber-800/20' : 'hover:bg-black/5';

    const fontIdx = FONT_STEPS.indexOf(fontStep);
    const canGrow = fontIdx < FONT_STEPS.length - 1;
    const canShrink = fontIdx > 0;

    return (
        <div
            className={`flex flex-col h-full overflow-hidden transition-colors duration-200 jr-sidebar`}
        >
            {/* Header */}
            <div className={`flex items-center border-b shrink-0 jr-header`}>
                <div className="flex flex-1 items-center justify-between">
                    <span className="px-4 py-3 text-[11px] font-extrabold uppercase tracking-widest leading-none whitespace-nowrap">{t('reader.tocHeader')}</span>
                    <div className="flex items-center gap-1 pr-1.5 pl-2 border-l border-black/5 dark:border-white/5">
                        <div className="jr-font-controls-container flex items-center gap-1 rounded-md !p-0.5">
                            <button
                                onClick={() => canShrink && setFontStep(FONT_STEPS[fontIdx - 1])}
                                disabled={!canShrink}
                                className={`!w-7 !h-7 flex items-center justify-center !rounded transition-colors ${fontBtnCls} jr-item-idle !p-0 disabled:opacity-30 disabled:cursor-not-allowed jr-btn-font-decrease`}
                                title={t('reader.pdfShrinkFont')}
                            >A−</button>
                            <button
                                onClick={() => canGrow && setFontStep(FONT_STEPS[fontIdx + 1])}
                                disabled={!canGrow}
                                className={`!w-7 !h-7 flex items-center justify-center !rounded transition-colors ${fontBtnCls} jr-item-idle !p-0 disabled:opacity-30 disabled:cursor-not-allowed jr-btn-font-increase`}
                                title={t('reader.pdfGrowFont')}
                            >A+</button>
                        </div>
                        <button
                            onClick={onClose}
                            className={`!ml-1 !w-7 !h-7 flex items-center justify-center !rounded-full hover:bg-black/10 dark:hover:bg-white/10 transition-colors jr-text-muted jr-item-idle !p-0 jr-btn-sidebar-close`}
                        >✕</button>
                    </div>
                </div>
            </div>

            {/* TOC List */}
            <div className={`flex-1 overflow-y-auto overflow-x-hidden overscroll-contain jr-scrollbar py-1.5 jr-sidebar-font-${fontStep}`}>
                {toc.map((entry, i) => {
                    const depth = entry.depth ?? 0;
                    return (
                        <button
                            key={i}
                            ref={i === activeIdx ? activeRef : undefined}
                            onClick={() => { onJump(entry.pageIndex, entry.fragmentId); if (isMobile) onClose(); }}
                            className={`reader-sidebar-list-item text-left py-2.5 pr-4 transition-all border-b border-transparent jr-border ${i === activeIdx ? 'jr-item-active' : 'jr-item-idle'}`}
                            style={{
                                paddingLeft: `${depth * 16 + 16}px`,
                                ['--jr-toc-depth-padding' as any]: `${depth * 16 + 16}px`
                            }}
                            data-depth={depth}
                            title={`${entry.label} — s.${entry.pageIndex + 1}`}
                        >
                            <div className="flex items-start justify-between gap-3 min-w-0">
                                <div className="flex items-start gap-2 min-w-0">
                                    {i === activeIdx && (
                                        <div className="shrink-0 w-1.5 h-1.5 rounded-full bg-blue-500 shadow-sm mt-1.5" />
                                    )}
                                    <span className="min-w-0 leading-normal break-words">{entry.label}</span>
                                </div>
                                <span className={`shrink-0 text-[10px] font-semibold tabular-nums px-1.5 py-0.5 rounded mt-0.5 jr-badge-bg jr-text-muted`}>
                                    {entry.pageIndex + 1}
                                </span>
                            </div>
                        </button>
                    );
                })}
            </div>
        </div>
    );
};

/* ──────────────────────────────────────────────────────────────────── */
/*  Continuous-scroll view for HTML / text formats (EPUB, DOCX, DOC, TXT) */
/*  Mirrors the PDF viewer's IntersectionObserver + scrollIntoView logic  */
/*  so all formats behave identically: pages stack vertically, scroll     */
/*  updates the page counter, external currentPage changes scroll to page. */
/* ──────────────────────────────────────────────────────────────────── */

const HtmlScrollView: React.FC<{
    pages: ReaderPage[];
    currentPage: number;
    searchQuery: string;
    searchMatches: { pageIndex: number; matchIndex: number }[];
    searchMatchIdx: number;
    searchScrollKey: number;
    jumpFragment: string;
    jumpFragmentKey: number;
    fontSizeClass: string;
    theme: string;
    annotations: ReaderAnnotation[];
    annotationEnabled: boolean;
    onPageChange: (page: number) => void;
    onLinkClick: (e: React.MouseEvent<HTMLDivElement>) => void;
    onRemoveAnnotation: (id: string) => void;
    notesHeader: (count: number) => string;
}> = ({ pages, currentPage, searchQuery, searchMatches, searchMatchIdx, searchScrollKey, jumpFragment, jumpFragmentKey, fontSizeClass, theme,
    annotations, annotationEnabled, onPageChange, onLinkClick, onRemoveAnnotation, notesHeader }) => {

        const containerRef = useRef<HTMLDivElement>(null);
        const [containerEl, setContainerEl] = useState<HTMLDivElement | null>(null);
        const pageRefs = useRef<(HTMLDivElement | null)[]>([]);
        const internalPageRef = useRef(-1);
        const isScrollingRef = useRef(false);
        const isInitialScrollDone = useRef(false);
        const searchScrollActiveRef = useRef(false); // blocks scrollToPage during search nav
        const onChangeRef = useRef(onPageChange);

        useEffect(() => { onChangeRef.current = onPageChange; }, [onPageChange]);
        useEffect(() => {
            setContainerEl(containerRef.current);
        }, []);
        useEffect(() => {
            const timer = setTimeout(() => {
                isInitialScrollDone.current = true;
            }, 2000);
            return () => clearTimeout(timer);
        }, []);

        const isDark = theme === 'dark';
        const isSepia = theme === 'sepia';

        // Target page scroll helper
        // searchScrollKey effect, highlight centering'i üstlendiği için scrollToPage
        // sadece sayfa başına jump yapar — yarışan scroll çağrıları engellendi.
        const scrollToPage = useCallback((page: number) => {
            const el = pageRefs.current[page];
            if (!el || !containerEl) return false;
            if (searchScrollActiveRef.current) return false;
            isScrollingRef.current = true;
            const diff = Math.abs(page - Math.max(0, internalPageRef.current));
            const targetTop = el.offsetTop;

            // Tek adımlı scroll — sadece sayfa başına (highlight centering searchScrollKey effect'de)
            setTimeout(() => {
                if (!containerEl) return;
                if (searchScrollActiveRef.current) return;
                containerEl.scrollTo({ top: targetTop, behavior: diff > 5 ? 'auto' : 'smooth' });
            }, 50);

            internalPageRef.current = page;
            setTimeout(() => {
                isScrollingRef.current = false;
                isInitialScrollDone.current = true;
            }, 700);
            return true;
        }, [containerEl]);

        // IntersectionObserver — updates currentPage as user scrolls through pages.
        useEffect(() => {
            if (!containerEl) return;
            const ratioMap = new Map<number, number>();
            const obs = new IntersectionObserver((entries) => {
                entries.forEach(e => {
                    const idx = parseInt((e.target as HTMLElement).dataset.pageIndex ?? '0', 10);
                    ratioMap.set(idx, e.intersectionRatio);
                });
                if (isScrollingRef.current || !isInitialScrollDone.current) return;
                let maxRatio = 0, maxPage = internalPageRef.current;
                ratioMap.forEach((r, p) => { if (r > maxRatio) { maxRatio = r; maxPage = p; } });
                if (maxPage !== internalPageRef.current && maxRatio > 0.05) {
                    internalPageRef.current = maxPage;
                    onChangeRef.current(maxPage);
                }
            }, { 
                root: containerEl,
                threshold: [0, 0.1, 0.3, 0.5, 0.7, 1] 
            });

            pageRefs.current.forEach((el) => { if (el) obs.observe(el); });
            return () => obs.disconnect();
        }, [pages.length, containerEl]);

        // Scroll to page when currentPage changes externally (nav buttons, TOC, deeplink, search).
        // Skip if search navigation is handling the scroll to avoid overriding highlight position.
        useEffect(() => {
            if (!containerEl) return;
            if (currentPage === internalPageRef.current) return;
            if (searchScrollActiveRef.current) {
                internalPageRef.current = currentPage;
                return;
            }
            scrollToPage(currentPage);
        }, [currentPage, containerEl, scrollToPage]);

        // searchScrollKey artışı = kullanıcı "›" veya "‹" tıkladı veya deep-link ile açıldı.
        // searchScrollActiveRef = true → currentPage effect's scrollToPage is skipped.
        // Ayrıca isScrollingRef = true yapılarak IntersectionObserver geçici olarak bloke edilir.
        useEffect(() => {
            if (searchScrollKey === 0) return;
            searchScrollActiveRef.current = true;

            const el = pageRefs.current[currentPage];
            if (!el || !containerEl) {
                searchScrollActiveRef.current = false;
                return;
            }

            const isDifferentPage = currentPage !== internalPageRef.current || !isInitialScrollDone.current;
            if (isDifferentPage) {
                isScrollingRef.current = true;
                containerEl.scrollTo({ top: el.offsetTop, behavior: 'auto' });
                internalPageRef.current = currentPage;
            }

            const delay = !isInitialScrollDone.current ? 250 : (isDifferentPage ? 150 : 50);
            const timer = setTimeout(() => {
                const hl = el.querySelector('.jr-search-hl-active') || el.querySelector('.jr-search-hl');
                if (hl && containerEl) {
                    isScrollingRef.current = true;
                    const scrollTarget = (hlElement: HTMLElement) => {
                        return hlElement.getBoundingClientRect().top
                             - containerEl.getBoundingClientRect().top
                             + containerEl.scrollTop;
                    };

                    const hlTop = scrollTarget(hl as HTMLElement);
                    containerEl.scrollTo({ top: Math.max(0, hlTop - 100), behavior: 'smooth' });

                    // İlk yüklemede, resim/font yerleşimi sonrası olası kaymaları düzeltmek için 200ms sonra kontrol et.
                    if (!isInitialScrollDone.current) {
                        setTimeout(() => {
                            const reHl = el.querySelector('.jr-search-hl-active') || el.querySelector('.jr-search-hl');
                            if (reHl && containerEl) {
                                const newHlTop = scrollTarget(reHl as HTMLElement);
                                if (Math.abs(newHlTop - hlTop) > 5) {
                                    containerEl.scrollTo({ top: Math.max(0, newHlTop - 100), behavior: 'smooth' });
                                }
                            }
                            searchScrollActiveRef.current = false;
                            setTimeout(() => {
                                isScrollingRef.current = false;
                            }, 800);
                        }, 200);
                    } else {
                        searchScrollActiveRef.current = false;
                        setTimeout(() => {
                            isScrollingRef.current = false;
                        }, 800);
                    }
                } else {
                    searchScrollActiveRef.current = false;
                    isScrollingRef.current = false;
                }
            }, delay);

            return () => clearTimeout(timer);
        // eslint-disable-next-line react-hooks/exhaustive-deps
        }, [searchScrollKey]);

        // TOC fragment jump: after page scroll, scroll to the specific id="..." element.
        useEffect(() => {
            if (jumpFragmentKey === 0 || !jumpFragment) return;
            const el = pageRefs.current[currentPage];
            if (!el || !containerEl) return;
            // Wait for scrollToPage to finish, then scroll to fragment element
            setTimeout(() => {
                const target = el.querySelector(`[id="${CSS.escape(jumpFragment)}"]`) as HTMLElement | null;
                if (target && containerEl) {
                    const top = target.getBoundingClientRect().top
                              - containerEl.getBoundingClientRect().top
                              + containerEl.scrollTop;
                    containerEl.scrollTo({ top: Math.max(0, top - 60), behavior: 'smooth' });
                }
            }, 200);
        // eslint-disable-next-line react-hooks/exhaustive-deps
        }, [jumpFragmentKey]);

        // Force repaint/reflow of content to prevent invisible text WebKit bug
        useEffect(() => {
            if (!containerEl) return;
            const timer = setTimeout(() => {
                if (searchScrollActiveRef.current) return; // Arama esnasında smooth scroll'u bölmemek için es geç
                // Reading offsetHeight triggers layout reflow
                const _ = containerEl.offsetHeight;
                
                // Micro-scroll toggles to force paint/composite update
                if (containerEl.scrollTop === 0) {
                    containerEl.scrollTop = 1;
                    containerEl.scrollTop = 0;
                } else {
                    containerEl.scrollTop += 1;
                    containerEl.scrollTop -= 1;
                }
            }, 80);
            return () => clearTimeout(timer);
        }, [containerEl, pages]);

        const onPageRef = useCallback((el: HTMLDivElement | null, index: number) => {
            pageRefs.current[index] = el;
            if (el && index === currentPage && internalPageRef.current !== index) {
                scrollToPage(index);
            }
        }, [currentPage, scrollToPage]);

        return (
            <div ref={containerRef} className="absolute inset-0 overflow-y-auto overscroll-contain jr-html-scroll-container">
                {pages.map((pageData, i) => {
                    const isMatch = searchMatches.some(m => m.pageIndex === i) && searchQuery.length >= 2;
                    const activeMatch = searchMatches[searchMatchIdx];
                    const activeMatchIndex = activeMatch && activeMatch.pageIndex === i ? activeMatch.matchIndex : null;
                    const rawHtml = isMatch
                        ? highlightHtml(pageData.htmlContent ?? '', searchQuery, activeMatchIndex)
                        : (pageData.htmlContent ?? '');
                    const html = DOMPurify.sanitize(rawHtml, {
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
                        ALLOWED_ATTR: ['href', 'src', 'alt', 'title', 'class', 'id', 'lang', 'dir', 'style'],
                        ALLOW_DATA_ATTR: false,
                    });
                    const pageAnnotations = annotationEnabled
                        ? annotations.filter(a => a.pageIndex === i)
                        : [];

                    return (
                        <div
                            key={i}
                            ref={el => onPageRef(el, i)}
                            data-page-index={i}
                            className="max-w-2xl mx-auto w-full px-6 md:px-10 py-10 jr-html-scroll-page"
                        >
                            {pageData.label && (
                                <p className={`text-xs font-medium uppercase tracking-widest mb-6 ${isDark ? 'text-gray-600' : isSepia ? 'text-amber-500' : 'text-gray-400'}`}>
                                    {pageData.label}
                                </p>
                            )}

                            {pageData.htmlContent ? (
                                <div
                                    className={`jr-epub ${fontSizeClass} font-serif`}
                                    dangerouslySetInnerHTML={{ __html: html }}
                                    onClick={onLinkClick}
                                />
                            ) : (
                                <div className={`${fontSizeClass} whitespace-pre-wrap font-serif`}>
                                    {pageData.content}
                                </div>
                            )}

                            {pageAnnotations.length > 0 && (
                                <div className="mt-10 pt-6 border-t border-gray-200/60 dark:border-gray-700/60">
                                    <h4 className={`text-xs font-semibold uppercase tracking-widest mb-3 ${isDark ? 'text-gray-500' : isSepia ? 'text-amber-600' : 'text-gray-400'}`}>
                                        {notesHeader(pageAnnotations.length)}
                                    </h4>
                                    <div className="space-y-3">
                                        {pageAnnotations.map(annot => (
                                            <div
                                                key={annot.id}
                                                className="p-3 rounded-lg border-l-4 text-sm"
                                                style={{ borderLeftColor: annot.color, backgroundColor: `${annot.color}18` }}
                                            >
                                                <div className="flex justify-between items-start gap-2">
                                                    <blockquote className={`italic text-sm ${isDark ? 'text-gray-400' : 'text-gray-600'}`}>
                                                        &ldquo;{annot.text}&rdquo;
                                                    </blockquote>
                                                    <button
                                                        onClick={() => onRemoveAnnotation(annot.id)}
                                                        className="text-red-400 hover:text-red-600 text-xs shrink-0 mt-0.5 jr-btn-annotation-remove"
                                                    >
                                                        ✕
                                                    </button>
                                                </div>
                                                {annot.note && (
                                                    <p className={`text-sm mt-1 ${isDark ? 'text-gray-200' : isSepia ? 'text-amber-900' : 'text-gray-800'}`}>
                                                        {annot.note}
                                                    </p>
                                                )}
                                            </div>
                                        ))}
                                    </div>
                                </div>
                            )}

                            {i < pages.length - 1 && (
                                <hr className={`mt-10 ${isDark ? 'border-gray-700' : isSepia ? 'border-amber-200' : 'border-gray-200'}`} />
                            )}
                        </div>
                    );
                })}
            </div>
        );
    };

/* ═══════════════════════════════════════════════════════════════════════ */
/*  Main ReaderModal                                                       */
/* ═══════════════════════════════════════════════════════════════════════ */

const ReaderModal: React.FC<ReaderModalProps> = ({
    itemId,
    fileUrl,
    format,
    title,
    volumes,
    itemType,
    onClose,
    pageMode = 'modal',
    initialPage,
    initialVolume,
    initialSearch,
    initialAnchor,
    encoding,
}) => {

    const isPageMode = pageMode === 'page';

    const { t } = useTranslation();

    /* ── Volume state ── */
    const [currentVolume, setCurrentVolume] = useState(() => {
        if (initialVolume !== undefined) return initialVolume;
        const urlParams = new URLSearchParams(window.location.search);
        const qVol = urlParams.get('volume');
        if (qVol !== null) {
            return (parseInt(qVol, 10) || 1) - 1;
        }
        const hash = window.location.hash.slice(1);
        const hashParams = new URLSearchParams(hash);
        const hVol = hashParams.get('volume');
        if (hVol !== null) {
            return (parseInt(hVol, 10) || 1) - 1;
        }
        return 0;
    });
    const activeFileUrl = volumes ? volumes[currentVolume]?.file_path ?? fileUrl : fileUrl;
    const _storedFormat = volumes ? (volumes[currentVolume]?.file_type as ReaderFormat) ?? format : format;
    // URL extension takes priority over stored file_type — mirrors ReaderEngine.loadBook() behaviour
    const activeFormat: ReaderFormat = detectFormatFromUrl(activeFileUrl) ?? _storedFormat;
    const activeEncoding = volumes ? volumes[currentVolume]?.encoding ?? encoding : encoding;

    const volLabel = (idx: number) =>
        itemType === 'magazine' ? `${t('reader.volLabelMagazine')} ${idx + 1}` : `${t('reader.volLabelBook')} ${idx + 1}`;

    /* ── Book loading ── */
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [pages, setPages] = useState<ReaderPage[]>([]);
    const [metadata, setMetadata] = useState<ReaderMetadata | null>(null);
    const [currentPage, setCurrentPage] = useState(() => {
        if (initialPage !== undefined) return initialPage;
        const urlParams = new URLSearchParams(window.location.search);
        const qPage = urlParams.get('page');
        if (qPage !== null) {
            return parseInt(qPage, 10) || 0;
        }
        const hash = window.location.hash.slice(1);
        const hashParams = new URLSearchParams(hash);
        const hPage = hashParams.get('page');
        if (hPage !== null) {
            return parseInt(hPage, 10) || 0;
        }
        return 0;
    });

    /* ── TOC / Sidebar ── */
    const [toc, setToc] = useState<TocEntry[]>([]);
    const [tocOpen, setTocOpen] = useState(false);
    const [pdfSidebarOpen, setPdfSidebarOpen] = useState(false);

    /* ── PDF doc ref + zoom + dual page ── */
    const pdfDocRef = useRef<any>(null);
    const [pdfDocVer, setPdfDocVer] = useState(0);
    const [zoom, setZoom] = useState(() => window.innerWidth >= 640 ? 0.75 : 1.0);
    const [dualPage, setDualPage] = useState(false);
    const dualPageRef = useRef(false); // readable inside event closures
    const touchStartY = useRef(0);

    // Keep ref in sync with state
    useEffect(() => { dualPageRef.current = dualPage; }, [dualPage]);

    /* ── Settings & annotations ── */
    const [settings, setSettings] = useState<ReaderPublicSettings>({
        annotation_enabled: true,
        copy_enabled: true,
        logo_url: '',
    });
    const [annotations, setAnnotations] = useState<ReaderAnnotation[]>([]);
    const [bookmarks, setBookmarks] = useState<ReaderBookmark[]>([]);
    const isDefaultLogo = !!(settings.logo_url && settings.logo_url.includes('assets/logo/jetreader.svg'));

    /* ── Annotation UI ── */
    const [selectedText, setSelectedText] = useState('');
    const [annotationNote, setAnnotationNote] = useState('');
    const [activeAnnotColor, setActiveAnnotColor] = useState(ANNOTATION_COLORS[0]);
    const [showAnnotationInput, setShowAnnotationInput] = useState(false);

    /* ── Display prefs ── */
    const [fontSize, setFontSize] = useState<'small' | 'medium' | 'large' | 'xlarge'>('medium');
    const [theme, setTheme] = useState<'light' | 'dark' | 'sepia'>('light');

    /* ── Search ── */
    const [showSearch, setShowSearch] = useState(!!initialSearch);
    const [searchQuery, setSearchQuery] = useState(initialSearch ?? '');
    const [searchMatches, setSearchMatches] = useState<{ pageIndex: number; matchIndex: number }[]>([]);
    const [searchDone, setSearchDone] = useState(false);
    const [searchMatchIdx, setSearchMatchIdx] = useState(0);
    // searchScrollKey: her next/prev tıklamasında artar; currentPage değişmese bile
    // HtmlScrollView'in highlight'a scroll yapmasını zorlar (IntersectionObserver race'ini bypass eder)
    const [searchScrollKey, setSearchScrollKey] = useState(0);
    const [tocJumpFragment, setTocJumpFragment] = useState('');
    const [tocJumpKey, setTocJumpKey] = useState(0);
    const [pdfTextCache, setPdfTextCache] = useState<string[] | null>(null);
    const [pdfTextExtracting, setPdfTextExtracting] = useState(false);
    const searchInputRef = useRef<HTMLInputElement>(null);

    /* ── Bottom panel ── */
    const [bottomTab, setBottomTab] = useState<'bookmarks' | 'annotations' | null>(null);

    /* ── Page jump input ── */
    const [pageInputVal, setPageInputVal] = useState('');

    const contentRef = useRef<HTMLDivElement>(null);

    /* ── Inject EPUB content styles once ── */
    useEffect(() => {
        const STYLE_ID = 'jetreader-epub-styles';
        if (document.getElementById(STYLE_ID)) return;
        const style = document.createElement('style');
        style.id = STYLE_ID;
        style.textContent = `
            .jr-epub h1,.jr-epub h2,.jr-epub h3,.jr-epub h4,.jr-epub h5,.jr-epub h6{font-weight:700;line-height:1.3;margin:1.4em 0 .6em}
            .jr-epub h1{font-size:1.7em}.jr-epub h2{font-size:1.4em}.jr-epub h3{font-size:1.2em}
            .jr-epub h4,.jr-epub h5,.jr-epub h6{font-size:1em}
            .jr-epub p{margin:.8em 0;line-height:1.75}
            .jr-epub a{color:#3b82f6;text-decoration:underline;text-underline-offset:2px}
            .jr-epub img{max-width:100%;height:auto;border-radius:4px;margin:.5em auto;display:block}
            .jr-epub blockquote{border-left:3px solid #9ca3af;padding:.5em 0 .5em 1.2em;margin:1em 0;color:#6b7280;font-style:italic}
            .jr-epub ul,.jr-epub ol{padding-left:1.6em;margin:.75em 0}
            .jr-epub li{margin:.25em 0;line-height:1.7}
            .jr-epub table{width:100%;border-collapse:collapse;margin:1em 0;font-size:.9em}
            .jr-epub td,.jr-epub th{border:1px solid #e5e7eb;padding:.4em .6em;text-align:left}
            .jr-epub th{background:#f9fafb;font-weight:600}
            .jr-epub hr{border:none;border-top:1px solid #e5e7eb;margin:1.5em 0}
            .jr-epub figure{margin:1em 0;text-align:center}
            .jr-epub figcaption{font-size:.85em;color:#6b7280;margin-top:.3em}
            .jr-epub sup,.jr-epub sub{font-size:.75em}
            .jr-epub em{font-style:italic}
            .jr-epub strong{font-weight:700}
            /* Dark theme overrides */
            [data-jr-theme="dark"] .jr-epub blockquote{border-color:#4b5563;color:#9ca3af}
            [data-jr-theme="dark"] .jr-epub td,[data-jr-theme="dark"] .jr-epub th{border-color:#374151}
            [data-jr-theme="dark"] .jr-epub th{background:#1f2937}
            [data-jr-theme="dark"] .jr-epub a{color:#60a5fa}
            [data-jr-theme="dark"] .jr-epub hr{border-color:#374151}
            /* Sepia overrides */
            [data-jr-theme="sepia"] .jr-epub blockquote{border-color:#b45309;color:#92400e}
            [data-jr-theme="sepia"] .jr-epub a{color:#b45309}
            [data-jr-theme="sepia"] .jr-epub td,[data-jr-theme="sepia"] .jr-epub th{border-color:#d6b896}
            [data-jr-theme="sepia"] .jr-epub th{background:#f9f0e0}
            /* Search highlight */
            .jr-search-hl{background:rgba(255,213,0,.55);border-radius:2px;padding:0 1px}
            [data-jr-theme="dark"] .jr-search-hl{background:rgba(255,186,0,.35);color:inherit}
            [data-jr-theme="sepia"] .jr-search-hl{background:rgba(210,140,0,.35);color:inherit}
            .jr-search-hl-active{background:rgba(255,110,0,0.85) !important;color:#fff !important}
            [data-jr-theme="dark"] .jr-search-hl-active{background:rgba(255,110,0,0.65) !important;color:#fff !important}
            [data-jr-theme="sepia"] .jr-search-hl-active{background:rgba(255,110,0,0.75) !important;color:#fff !important}
            /* Color picker swatches — use CSS variable so WP/Elementor button resets cannot override */
            .jr-btn-color-picker{background-color:var(--jr-swatch-bg,transparent) !important}
        `;
        document.head.appendChild(style);
    }, []);

    /* ── Add modal open class to html element for font-size normalization ── */
    useEffect(() => {
        if (!isPageMode) {
            document.documentElement.classList.add('jr-modal-open');
            return () => {
                document.documentElement.classList.remove('jr-modal-open');
            };
        }
    }, [isPageMode]);

    /* ── Load saved display preferences ── */
    useEffect(() => {
        try {
            const prefs = JSON.parse(localStorage.getItem('jetreader_prefs') ?? '{}');
            if (prefs.fontSize) setFontSize(prefs.fontSize);
            if (prefs.theme) setTheme(prefs.theme);
        } catch { /* noop */ }
    }, []);

    /* ── Save display preferences ── */
    useEffect(() => {
        try {
            localStorage.setItem('jetreader_prefs', JSON.stringify({ fontSize, theme }));
        } catch { /* noop */ }
    }, [fontSize, theme]);

    /* ── Track read count (fire-and-forget, runs once on mount) ── */
    useEffect(() => {
        const nonce = getNonce();
        const headers: Record<string, string> = {};
        if (nonce) {
            headers['X-WP-Nonce'] = nonce;
        }
        fetch(`${API_BASE}/items/${itemId}/read`, {
            method: 'POST',
            headers,
            keepalive: true,
        }).catch(() => {});
    }, []); // eslint-disable-line react-hooks/exhaustive-deps

    /* ── Load public settings from API ── */
    useEffect(() => {
        fetch(`${API_BASE}/public/settings`)
            .then((r) => r.json())
            .then((data) => {
                if (data && !data.code) {
                    setSettings({
                        annotation_enabled: data.annotation_enabled ?? true,
                        copy_enabled: data.copy_enabled ?? true,
                        logo_url: data.reader_logo_url ?? '',
                    });
                }
            })
            .catch(() => { });
    }, []);

    /* ── Load book ── */
    useEffect(() => {
        let cancelled = false;

        const load = async () => {
            setLoading(true);
            setError(null);
            setToc([]);
            setTocOpen(false);
            setPdfSidebarOpen(false);
            setZoom(window.innerWidth >= 640 ? 0.75 : 1.0);
            setDualPage(false);
            setPdfTextCache(null);
            pdfDocRef.current = null;

            try {
                const result = await ReaderEngine.loadBook(activeFileUrl, activeFormat, activeEncoding);
                if (cancelled) return;

                pdfDocRef.current = result.pdfDoc ?? null;
                if (result.pdfDoc) setPdfDocVer((v) => v + 1);

                setPages(result.pages);
                setMetadata(result.metadata);
                setToc(result.toc);
                const loadedFmt = result.metadata.format;
                // On mobile (<768px) the sidebar opens as a full-screen fixed drawer that
                // covers the entire reader on first load, which feels broken. Only auto-open
                // on desktop where it renders as a side panel inside the layout.
                const isDesktop = window.innerWidth >= 768;
                if (loadedFmt === 'epub') {
                    setTocOpen(result.toc.length > 0 && isDesktop);
                } else if (loadedFmt === 'pdf') {
                    setPdfSidebarOpen(isDesktop);
                } else if (result.toc.length > 0) {
                    setTocOpen(isDesktop);
                }

                // Deep-link page takes priority; otherwise restore saved reading position.
                // NOTE: initialPage === 0 is a valid deeplink (first page) — must not fall through to saved.
                const posKey = `jetreader_pos_${itemId}_v${currentVolume}`;
                const savedPos = localStorage.getItem(posKey);
                const saved = savedPos ? parseInt(savedPos, 10) : 0;
                let target = initialPage !== undefined ? initialPage : saved;
                if (loadedFmt === 'epub' && initialPage !== undefined && result.pages.length > 0) {
                    let targetCharOffset = initialPage * 1500;
                    let currentOffset = 0;
                    let mappedPage = 0;
                    for (let i = 0; i < result.pages.length; i++) {
                        let len = (result.pages[i].content ?? '').length;
                        if (currentOffset + len > targetCharOffset) {
                            mappedPage = i;
                            break;
                        }
                        currentOffset += len;
                        mappedPage = i;
                    }
                    target = mappedPage;
                }
                setCurrentPage(Math.max(0, Math.min(target, result.pages.length - 1)));
            } catch (err) {
                if (!cancelled) {
                    setError(err instanceof Error ? err.message : t('reader.failedToLoad'));
                }
            } finally {
                if (!cancelled) setLoading(false);
            }
        };

        load();
        return () => { cancelled = true; };
    }, [activeFileUrl, activeFormat, activeEncoding, currentVolume]); // eslint-disable-line react-hooks/exhaustive-deps

    /* ── Save reading position ── */
    useEffect(() => {
        if (loading || pages.length === 0) return;
        const posKey = `jetreader_pos_${itemId}_v${currentVolume}`;
        localStorage.setItem(posKey, String(currentPage));
    }, [currentPage, itemId, currentVolume, loading, pages.length]);

    /* ── Sync page-jump input with currentPage ── */
    useEffect(() => { setPageInputVal(String(currentPage + 1)); }, [currentPage]);

    /* ── Load bookmarks & notes ── */
    useEffect(() => {
        loadRemoteBookmarks();
        loadRemoteNotes();
    }, [itemId]); // eslint-disable-line react-hooks/exhaustive-deps

    const isLoggedIn = () => !!(window as any).jetreaderSettings?.isLoggedIn;

    const loadRemoteBookmarks = async () => {
        if (!isLoggedIn()) { loadLocalBookmarks(); return; }
        try {
            const res = await fetch(`${API_BASE}/bookmarks?item_id=${itemId}`, {
                headers: { 'X-WP-Nonce': getNonce() },
            });
            const data = await res.json();
            if (Array.isArray(data)) {
                setBookmarks(data.map((bm: any) => ({
                    id: `bm_remote_${bm.id}`,
                    remoteId: bm.id,
                    itemId: bm.item_id,
                    pageIndex: bm.position?.pageIndex ?? 0,
                    label: bm.label ?? '',
                    color: bm.color ?? '#FFD700',
                    createdAt: bm.created_at,
                })));
            }
        } catch { loadLocalBookmarks(); }
    };

    const loadRemoteNotes = async () => {
        if (!isLoggedIn()) { loadLocalAnnotations(); return; }
        try {
            const res = await fetch(`${API_BASE}/notes?item_id=${itemId}`, {
                headers: { 'X-WP-Nonce': getNonce() },
            });
            const data = await res.json();
            if (Array.isArray(data)) {
                setAnnotations(data.map((note: any) => ({
                    id: `note_remote_${note.id}`,
                    remoteId: note.id,
                    pageIndex: note.position?.pageIndex ?? 0,
                    text: note.quote ?? '',
                    note: note.content ?? '',
                    color: note.color ?? '#FFFF00',
                    createdAt: note.created_at,
                })));
            }
        } catch { loadLocalAnnotations(); }
    };

    /* ── LocalStorage helpers ── */
    const loadLocalBookmarks = () => {
        try {
            const raw = localStorage.getItem(`jetreader_bm_${itemId}`);
            if (raw) setBookmarks(JSON.parse(raw));
        } catch { /* noop */ }
    };

    const saveLocalBookmarks = (bms: ReaderBookmark[]) => {
        try { localStorage.setItem(`jetreader_bm_${itemId}`, JSON.stringify(bms)); }
        catch { /* noop */ }
    };

    const loadLocalAnnotations = () => {
        try {
            const raw = localStorage.getItem(`jetreader_annot_${itemId}`);
            if (raw) setAnnotations(JSON.parse(raw));
        } catch { /* noop */ }
    };

    const saveLocalAnnotations = (annots: ReaderAnnotation[]) => {
        try { localStorage.setItem(`jetreader_annot_${itemId}`, JSON.stringify(annots)); }
        catch { /* noop */ }
    };

    /* ── Bookmark CRUD ── */
    const addBookmark = async () => {
        const exists = bookmarks.find((b) => b.pageIndex === currentPage);
        if (exists) { removeBookmark(exists.id); return; }

        const local: ReaderBookmark = {
            id: `bm_${Date.now()}`,
            itemId,
            pageIndex: currentPage,
            label: pages[currentPage]?.label ?? `${t('readerEngine.pageLabel')} ${currentPage + 1}`,
            color: BOOKMARK_COLORS[0],
            createdAt: new Date().toISOString(),
        };
        const updated = [...bookmarks, local];
        setBookmarks(updated);
        saveLocalBookmarks(updated);

        if (!isLoggedIn()) return;
        try {
            const res = await fetch(`${API_BASE}/bookmarks`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'X-WP-Nonce': getNonce() },
                body: JSON.stringify({
                    item_id: itemId,
                    position: { pageIndex: currentPage },
                    label: local.label,
                    color: local.color,
                }),
            });
            const json = await res.json();
            if (json?.id) {
                setBookmarks((prev) =>
                    prev.map((b) => b.id === local.id ? { ...b, remoteId: json.id } : b),
                );
            }
        } catch { /* stays local */ }
    };

    const removeBookmark = async (id: string) => {
        const target = bookmarks.find((b) => b.id === id);
        const updated = bookmarks.filter((b) => b.id !== id);
        setBookmarks(updated);
        saveLocalBookmarks(updated);

        if (target?.remoteId) {
            try {
                await fetch(`${API_BASE}/bookmarks/${target.remoteId}`, {
                    method: 'DELETE', headers: { 'X-WP-Nonce': getNonce() },
                });
            } catch { /* noop */ }
        }
    };

    /* ── Annotation CRUD ── */
    const addAnnotation = async () => {
        if (!selectedText) return;

        const local: ReaderAnnotation = {
            id: `annot_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
            pageIndex: currentPage,
            text: selectedText,
            note: annotationNote,
            color: activeAnnotColor,
            createdAt: new Date().toISOString(),
        };
        const updated = [...annotations, local];
        setAnnotations(updated);
        saveLocalAnnotations(updated);
        setShowAnnotationInput(false);
        setSelectedText('');
        setAnnotationNote('');
        window.getSelection()?.removeAllRanges();

        if (!isLoggedIn()) return;
        try {
            const res = await fetch(`${API_BASE}/notes`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'X-WP-Nonce': getNonce() },
                body: JSON.stringify({
                    item_id: itemId,
                    type: 'highlight',
                    content: annotationNote,
                    quote: selectedText,
                    position: { pageIndex: currentPage },
                    color: activeAnnotColor,
                }),
            });
            const json = await res.json();
            if (json?.id) {
                setAnnotations((prev) =>
                    prev.map((a) => a.id === local.id ? { ...a, remoteId: json.id } : a),
                );
            }
        } catch { /* stays local */ }
    };

    const removeAnnotation = async (id: string) => {
        const target = annotations.find((a) => a.id === id);
        const updated = annotations.filter((a) => a.id !== id);
        setAnnotations(updated);
        saveLocalAnnotations(updated);

        if (target?.remoteId) {
            try {
                await fetch(`${API_BASE}/notes/${target.remoteId}`, {
                    method: 'DELETE', headers: { 'X-WP-Nonce': getNonce() },
                });
            } catch { /* noop */ }
        }
    };

    /* ── Search ── */

    // Triggered automatically after a PDF finishes loading (pdfDocVer increments).
    // Runs silently in background so search is instant when user opens it.
    // Optimized to run page loading/text extraction in parallel batches of 20 pages for maximum speed.
    useEffect(() => {
        if (activeFormat !== 'pdf') return;
        const pdf = pdfDocRef.current;
        if (!pdf) return;

        const cacheKey = `${itemId}-${activeFileUrl}`;
        
        // 1. Bellek içi önbelleği kontrol et (anlık kapatıp açmalarda hız için)
        if (pdfTextGlobalCache.has(cacheKey)) {
            const cached = pdfTextGlobalCache.get(cacheKey)!;
            setPdfTextCache(cached);
            setPdfTextExtracting(false);
            return;
        }

        let cancelled = false;

        // 2. Sayfa yenilense de korunan IndexedDB önbelleğini asenkron sorgula
        (async () => {
            const dbCached = await getCachedPdfText(cacheKey);
            if (cancelled) return;

            if (dbCached) {
                setPdfTextCache(dbCached);
                setGlobalPdfCache(cacheKey, dbCached);
                setPdfTextExtracting(false);
                return;
            }

            // 3. Cache Miss: İndeksleme durumunu başlat
            setPdfTextExtracting(true);
            setPdfTextCache(null);

            const texts: string[] = [];
            try {
                const total = pdf.numPages;
                const batchSize = 20;

                for (let i = 1; i <= total; i += batchSize) {
                    if (cancelled) return;
                    const promises = [];
                    const limit = Math.min(i + batchSize - 1, total);

                    for (let j = i; j <= limit; j++) {
                        promises.push((async (pageNum) => {
                            const page = await pdf.getPage(pageNum);
                            const tc = await page.getTextContent();
                            const str = (tc.items as any[])
                                .filter((it) => typeof it.str === 'string')
                                .map((it) => it.str + (it.hasEOL ? ' ' : ''))
                                .join('');
                            return { pageNum, str };
                        })(j));
                    }

                    const batchResults = await Promise.all(promises);
                    for (const res of batchResults) {
                        texts[res.pageNum - 1] = res.str;
                    }
                }

                if (!cancelled) {
                    setPdfTextCache(texts);
                    setGlobalPdfCache(cacheKey, texts);
                    // IndexedDB veri tabanına kalıcı olarak kaydet
                    void setCachedPdfText(cacheKey, texts);
                }
            } catch (err) {
                dbg('PDF text extraction error:', err);
                if (!cancelled) setPdfTextCache([]); // boş dizi = taranmış ama başarısız / taranacak metin yok
            } finally {
                if (!cancelled) setPdfTextExtracting(false);
            }
        })();

        return () => { cancelled = true; };
    }, [pdfDocVer, activeFormat, itemId, activeFileUrl]); // eslint-disable-line react-hooks/exhaustive-deps

    const handleSearch = useCallback((targetPage?: number | React.SyntheticEvent) => {
        const q = normalizeQuery(searchQuery);
        if (q.length < 2) return;

        let matches: { pageIndex: number; matchIndex: number; charOffset?: number }[] = [];

        if (activeFormat === 'pdf') {
            if (!pdfTextCache) return; // still extracting
            for (let i = 0; i < pdfTextCache.length; i++) {
                const text = normalizeQuery(pdfTextCache[i]);
                const matchedPositions = findMatchPositions(text, q);
                let matchIndex = 0;
                for (const pos of matchedPositions) {
                    matches.push({ pageIndex: i, matchIndex, charOffset: pos });
                    matchIndex++;
                }
            }
        } else {
            // Lazy cached DOM Parsing & exact matching to keep search instant and avoid freezes.
            for (let i = 0; i < pages.length; i++) {
                const page = pages[i] as any;
                const plainText = page.content ?? '';
                // Collapsed space normalization pre-check
                if (normalizeQuery(plainText).indexOf(q) === -1) {
                    continue;
                }

                let virt = page._virtualText;
                let virtNorm = page._virtNorm;
                if (virt === undefined) {
                    const htmlContent = page.htmlContent ?? '';
                    try {
                        const d = new DOMParser().parseFromString(`<div>${htmlContent}</div>`, 'text/html');
                        let v = '';
                        const collect = (n: Node) => {
                            if (n.nodeType === Node.TEXT_NODE) v += n.textContent ?? '';
                            else Array.from(n.childNodes).forEach(collect);
                        };
                        collect(d.body);
                        virt = v;
                        const mapped = normalizeAndMap(v);
                        virtNorm = mapped.normalized;
                        page._indexMap = mapped.indexMap;
                    } catch {
                        virt = plainText;
                        virtNorm = normalizeQuery(plainText);
                        page._indexMap = Array.from({ length: plainText.length }, (_, k) => k);
                    }
                    page._virtualText = virt;
                    page._virtNorm = virtNorm;
                }

                const matchedPositions = findMatchPositions(virtNorm, q);
                let matchIndex = 0;
                for (const pos of matchedPositions) {
                    matches.push({ pageIndex: i, matchIndex, charOffset: pos });
                    matchIndex++;
                }
            }
        }

        setSearchMatches(matches);
        setSearchDone(true);

        const actualTargetPage = typeof targetPage === 'number' ? targetPage : undefined;
        let exactTargetPage = actualTargetPage !== undefined ? actualTargetPage : (initialPage !== undefined ? initialPage : -1);

        let anchorLoc: { pageIndex: number; charOffset: number } | null = null;
        if (initialAnchor) {
            anchorLoc = findAnchorPage(initialAnchor, pages, pdfTextCache, activeFormat);
            if (anchorLoc) {
                exactTargetPage = anchorLoc.pageIndex;
            }
        }

        if (activeFormat === 'epub' && exactTargetPage !== -1 && pages.length > 0 && !anchorLoc) {
            let targetCharOffset = exactTargetPage * 1500;
            let currentOffset = 0;
            let mappedPage = 0;
            for (let i = 0; i < pages.length; i++) {
                let len = (pages[i].content ?? '').length;
                if (currentOffset + len > targetCharOffset) {
                    mappedPage = i;
                    break;
                }
                currentOffset += len;
                mappedPage = i;
            }
            exactTargetPage = mappedPage;
        }

        // Target match index closest to anchor location if found
        let bestMatchIdx = -1;
        if (anchorLoc) {
            const pageMatches = matches.filter(m => m.pageIndex === anchorLoc!.pageIndex);
            if (pageMatches.length > 0) {
                const normAnchor = normalizeQuery(initialAnchor!);
                const qInAnchor = normAnchor.indexOf(q);
                const targetCharOffset = anchorLoc.charOffset + (qInAnchor !== -1 ? qInAnchor : 0);

                let closestMatch = pageMatches[0];
                let minDiff = Math.abs((closestMatch.charOffset ?? 0) - targetCharOffset);
                for (let i = 1; i < pageMatches.length; i++) {
                    const diff = Math.abs((pageMatches[i].charOffset ?? 0) - targetCharOffset);
                    if (diff < minDiff) {
                        minDiff = diff;
                        closestMatch = pageMatches[i];
                    }
                }
                bestMatchIdx = matches.findIndex(m => m.pageIndex === closestMatch.pageIndex && m.matchIndex === closestMatch.matchIndex);
            }
        }

        if (bestMatchIdx !== -1) {
            setSearchMatchIdx(bestMatchIdx);
            setCurrentPage(exactTargetPage);
            setSearchScrollKey(k => k + 1);
        } else {
            const idxOfTarget = exactTargetPage !== -1 ? matches.findIndex(m => m.pageIndex === exactTargetPage) : -1;
            if (idxOfTarget !== -1) {
                setSearchMatchIdx(idxOfTarget);
                setCurrentPage(exactTargetPage);
                setSearchScrollKey(k => k + 1);
            } else {
                if (matches.length > 0) {
                    // No match on the exact target page (common for DOCX where DB page_num
                    // and reader page indices can differ).  Navigate to the match whose page
                    // is closest to the target so the user lands near the right content
                    // rather than always jumping to the very first match in the document.
                    let nearestIdx = 0;
                    if (exactTargetPage !== -1) {
                        nearestIdx = matches.reduce((best, _m, i) => {
                            const bestDist = Math.abs(matches[best].pageIndex - exactTargetPage);
                            const curDist  = Math.abs(matches[i].pageIndex   - exactTargetPage);
                            return curDist < bestDist ? i : best;
                        }, 0);
                    }
                    setSearchMatchIdx(nearestIdx);
                    setCurrentPage(matches[nearestIdx].pageIndex);
                    setSearchScrollKey(k => k + 1);
                } else if (actualTargetPage !== undefined && actualTargetPage >= 0) {
                    // Zero matches (encoding/format mismatch): navigate to approximate page.
                    setCurrentPage(actualTargetPage);
                }
            }
        }
    }, [searchQuery, pages, activeFormat, pdfTextCache, initialPage, initialAnchor, setSearchScrollKey]);

    // Auto-run search when reader opens with initialSearch / initialAnchor set.
    // For PDFs: wait for pdfTextCache (background text extraction). For others: wait for pages.
    const didAutoSearch = useRef(false);
    useEffect(() => {
        const hasTarget = initialSearch || initialAnchor;
        if (!hasTarget || didAutoSearch.current || loading) return;
        if (activeFormat === 'pdf' && pdfTextCache === null) return;
        if (activeFormat !== 'pdf' && pages.length === 0) return;
        didAutoSearch.current = true;

        if (initialSearch) {
            // Primary: search with the user's original query term.
            handleSearch(initialPage);
        } else if (initialAnchor) {
            // Anchor-only fallback: set the query to the anchor text and search.
            // This fires when the deeplink came from a "Go" button but no searchTerm
            // was set, or after the primary search found zero matches.
            setSearchQuery(initialAnchor);
        }
    }, [loading, pages.length, pdfTextCache, activeFormat, initialSearch, initialAnchor, initialPage, handleSearch, setSearchQuery]); // eslint-disable-line react-hooks/exhaustive-deps

    const searchNext = () => {
        if (searchMatches.length === 0) return;
        const next = (searchMatchIdx + 1) % searchMatches.length;
        setSearchMatchIdx(next);
        setCurrentPage(searchMatches[next].pageIndex);
        // currentPage aynı kalsa bile (IntersectionObserver zaten o sayfadaysa)
        // HtmlScrollView'deki searchScrollKey effect highlight'a zorla scroll yapar
        setSearchScrollKey(k => k + 1);
    };

    const searchPrev = () => {
        if (searchMatches.length === 0) return;
        const prev = (searchMatchIdx - 1 + searchMatches.length) % searchMatches.length;
        setSearchMatchIdx(prev);
        setCurrentPage(searchMatches[prev].pageIndex);
        setSearchScrollKey(k => k + 1);
    };

    const openSearch = () => {
        setShowSearch(true);
        setTimeout(() => searchInputRef.current?.focus(), 50);
    };

    const closeSearch = () => {
        setShowSearch(false);
        setSearchQuery('');
        setSearchMatches([]);
        setSearchDone(false);
        setSearchMatchIdx(0);
    };

    /* ── Keyboard shortcuts ── */
    const handleKeyDown = useCallback(
        (e: KeyboardEvent) => {
            // Search
            if ((e.ctrlKey || e.metaKey) && e.key === 'f') {
                e.preventDefault();
                showSearch ? closeSearch() : openSearch();
                return;
            }
            if (e.key === 'Escape') {
                if (showAnnotationInput) { setShowAnnotationInput(false); return; }
                if (showSearch) { closeSearch(); return; }
                if (tocOpen && window.innerWidth < 768) { setTocOpen(false); return; }
                onClose();
                return;
            }
            // Navigation (respects dual-page step)
            if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
                const s = dualPageRef.current ? 2 : 1;
                setCurrentPage((p) => Math.min(p + s, pages.length - 1));
            }
            if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
                const s = dualPageRef.current ? 2 : 1;
                setCurrentPage((p) => Math.max(p - s, 0));
            }
            // Bookmark
            if ((e.ctrlKey || e.metaKey) && e.key === 'b') {
                e.preventDefault();
                addBookmark();
            }
        },
        // eslint-disable-next-line react-hooks/exhaustive-deps
        [pages.length, onClose, showSearch, showAnnotationInput, tocOpen],
    );

    useEffect(() => {
        window.addEventListener('keydown', handleKeyDown);
        return () => window.removeEventListener('keydown', handleKeyDown);
    }, [handleKeyDown]);

    // PDF now uses PdfScrollView which handles scroll natively.
    // No custom wheel handler needed for PDF.

    /* ── Back navigation ── */
    const handleGoBack = useCallback(() => {
        try {
            const ref = document.referrer;
            if (ref && new URL(ref).origin === window.location.origin) {
                window.history.back();
            } else {
                window.location.href = window.location.origin + '/';
            }
        } catch {
            window.location.href = window.location.origin + '/';
        }
    }, []);

    /* ── Text selection → annotation ── */
    const handleTextSelection = useCallback(() => {
        if (!settings.annotation_enabled) return;
        const selection = window.getSelection();
        if (!selection || selection.isCollapsed) { setShowAnnotationInput(false); return; }
        const text = selection.toString().trim();
        if (text.length < 2) return;
        setSelectedText(text);
        setAnnotationNote('');
        setShowAnnotationInput(true);
    }, [settings.annotation_enabled]);

    const handleCopy = useCallback(
        (e: React.ClipboardEvent<HTMLDivElement>) => {
            if (!settings.copy_enabled) e.preventDefault();
        },
        [settings.copy_enabled],
    );

    const handleContextMenu = useCallback(
        (e: React.MouseEvent<HTMLDivElement>) => {
            if (!settings.copy_enabled) e.preventDefault();
        },
        [settings.copy_enabled],
    );

    /* ── Intercept EPUB internal link clicks ── */
    const handleEpubLinkClick = (e: React.MouseEvent<HTMLDivElement>) => {
        const anchor = (e.target as HTMLElement).closest('a');
        if (!anchor) return;
        e.preventDefault();
        const href = anchor.getAttribute('href') ?? '';
        if (href.startsWith('http://') || href.startsWith('https://')) {
            window.open(href, '_blank', 'noopener,noreferrer');
        }
        // Internal EPUB links are silently suppressed (paged reader model)
    };

    /* ═════════════════════════════════════════════════════════════════ */
    /*  Theme helpers                                                    */
    /* ═════════════════════════════════════════════════════════════════ */

    const isDark = theme === 'dark';
    const isSepia = theme === 'sepia';

    const containerBg = isDark ? 'bg-gray-950 text-gray-100'
        : isSepia ? 'bg-[#f4ecd8] text-[#5c4a1e]'
            : 'bg-white text-gray-900';
    const containerBgHex = isDark ? '#030712' : isSepia ? '#f4ecd8' : '#ffffff';

    const toolbarBg = isDark ? 'bg-gray-900/95 border-gray-800'
        : isSepia ? 'bg-amber-100/95 border-amber-300'
            : 'bg-gray-50/95 border-gray-200';
    const toolbarBgHex = isDark ? '#111827' : isSepia ? '#fef3c7' : '#f9fafb';

    const sidebarBg = isDark ? '!bg-[#142440] !border-[#1e3250]'
        : isSepia ? '!bg-[#FDF0BC] !border-[#e8d69a]'
            : '!bg-[#f8fafc] !border-gray-200';

    const controlBtn = isDark
        ? 'bg-gray-800 border-gray-700 text-gray-200 hover:bg-gray-700'
        : isSepia
            ? 'bg-amber-50 border-amber-300 text-amber-900 hover:bg-amber-100'
            : 'bg-white border-gray-300 text-gray-700 hover:bg-gray-50';

    const inputCls = isDark
        ? 'bg-gray-800 border-gray-600 text-gray-100 placeholder-gray-500'
        : isSepia
            ? 'bg-amber-50 border-amber-300 text-amber-900 placeholder-amber-400'
            : 'bg-white border-gray-300 text-gray-800 placeholder-gray-400';

    const textColor = isDark ? 'text-gray-200' : isSepia ? 'text-amber-950' : 'text-gray-800';

    const fontSizeMap: Record<string, string> = {
        small: 'jr-font-size-small',
        medium: 'jr-font-size-medium',
        large: 'jr-font-size-large',
        xlarge: 'jr-font-size-xlarge',
    };

    const currentPageAnnotations = annotations.filter((a) => a.pageIndex === currentPage);
    const currentPageBookmark = bookmarks.find((b) => b.pageIndex === currentPage);

    /* ═════════════════════════════════════════════════════════════════ */
    /*  Content renderers                                                */
    /* ═════════════════════════════════════════════════════════════════ */

    const renderAnnotationCards = () => {
        if (!settings.annotation_enabled || currentPageAnnotations.length === 0) return null;
        return (
            <div className="mt-10 pt-6 border-t border-gray-200/60 dark:border-gray-700/60">
                <h4 className={`text-xs font-semibold uppercase tracking-widest mb-3 ${isDark ? 'text-gray-500' : isSepia ? 'text-amber-600' : 'text-gray-400'}`}>
                    {t('reader.notesHeader')} ({currentPageAnnotations.length})
                </h4>
                <div className="space-y-3">
                    {currentPageAnnotations.map((annot) => (
                        <div
                            key={annot.id}
                            className="p-3 rounded-lg border-l-4 text-sm"
                            style={{ borderLeftColor: annot.color, backgroundColor: `${annot.color}18` }}
                        >
                            <div className="flex justify-between items-start gap-2">
                                <blockquote className={`italic text-sm ${isDark ? 'text-gray-400' : 'text-gray-600'}`}>
                                    &ldquo;{annot.text}&rdquo;
                                </blockquote>
                                <button
                                    onClick={() => removeAnnotation(annot.id)}
                                    className="text-red-400 hover:text-red-600 text-xs shrink-0 mt-0.5 jr-btn-annotation-remove"
                                >
                                    ✕
                                </button>
                            </div>
                            {annot.note && (
                                <p className={`text-sm mt-1 ${isDark ? 'text-gray-200' : isSepia ? 'text-amber-900' : 'text-gray-800'}`}>
                                    {annot.note}
                                </p>
                            )}
                        </div>
                    ))}
                </div>
            </div>
        );
    };

    const renderContent = () => {
        const pageData = pages[currentPage];
        if (!pageData) return null;

        // PDF — continuous scroll view
        if (activeFormat === 'pdf' && pdfDocRef.current) {
            return (
                <PdfScrollView
                    key={pdfDocVer}
                    pdfDoc={pdfDocRef.current}
                    totalPages={pages.length}
                    currentPage={currentPage}
                    zoom={zoom}
                    dualPage={dualPage}
                    theme={theme}
                    searchQuery={searchMatches.length > 0 ? searchQuery : ''}
                    searchMatches={searchMatches}
                    searchMatchIdx={searchMatchIdx}
                    searchScrollKey={searchScrollKey}
                    annotationEnabled={settings.annotation_enabled}
                    onPageChange={setCurrentPage}
                />
            );
        }

        // EPUB / DOCX / DOC / TXT — continuous scroll view (same UX as PDF)
        return (
            <HtmlScrollView
                pages={pages}
                currentPage={currentPage}
                searchQuery={searchQuery}
                searchMatches={searchMatches}
                searchMatchIdx={searchMatchIdx}
                searchScrollKey={searchScrollKey}
                jumpFragment={tocJumpFragment}
                jumpFragmentKey={tocJumpKey}
                fontSizeClass={fontSizeMap[fontSize]}
                theme={theme}
                annotations={annotations}
                annotationEnabled={settings.annotation_enabled}
                onPageChange={setCurrentPage}
                onLinkClick={handleEpubLinkClick}
                onRemoveAnnotation={removeAnnotation}
                notesHeader={(count) => `${t('reader.notesHeader')} (${count})`}
            />
        );
    };

    /* ═════════════════════════════════════════════════════════════════ */
    /*  RENDER                                                           */
    /* ═════════════════════════════════════════════════════════════════ */

    const readerUi = (
        <motion.div
            initial={false}
            animate={{ opacity: 1 }}
            data-jr-theme={theme}
            className={`jetreader-modal-root fixed inset-0 z-[2147483647] flex flex-col ${containerBg}`}
            style={{ backgroundColor: containerBgHex }}
        >
            {/* ══════════════════════════════════════════════════════ */}
            {/*  TOOLBAR                                               */}
            {/* ══════════════════════════════════════════════════════ */}
            <div className={`shrink-0 flex flex-col border-b ${toolbarBg}`} style={{ backgroundColor: toolbarBgHex }}>

                {/* Mobile-only logo bar — sits above the controls row, no competition with buttons */}
                {settings.logo_url && (
                    <div className={`sm:hidden flex items-center px-3 pt-2 pb-1 border-b ${isDark ? 'border-gray-800' : isSepia ? 'border-amber-200' : 'border-gray-100'}`}>
                        <a
                            onClick={handleGoBack}
                            href="#"
                            title={t('reader.backTitle')}
                            className="flex items-center"
                        >
                            {isDefaultLogo ? (
                                <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 180 40" className="h-7 w-auto" style={{ maxHeight: '28px' }}>
                                    <path d="M12 10v16a3 3 0 0 0 3 3h12a3 3 0 0 0 3-3V14a3 3 0 0 0-3-3H19" 
                                          fill="none" 
                                          stroke="#8A2BE2" 
                                          strokeWidth="3.5" 
                                          strokeLinecap="round" 
                                          strokeLinejoin="round"/>
                                    <path d="M18 19h6M18 23h4" stroke="#8A2BE2" strokeWidth="2.5" strokeLinecap="round" opacity="0.7"/>
                                    <text x="45" y="26" fontFamily="system-ui, -apple-system, sans-serif" fontSize="21" fontWeight="800" fill={isDark ? "#FFFFFF" : "#111827"} letterSpacing="-0.5">
                                        Jet<tspan fontWeight="400" fill="#8A2BE2">Reader</tspan>
                                    </text>
                                </svg>
                            ) : (
                                <img
                                    src={settings.logo_url}
                                    alt="Logo"
                                    className="max-h-[28px] w-auto object-contain"
                                />
                            )}
                        </a>
                    </div>
                )}

                {/* Top row — 3-column grid for true centering */}
                <div className="grid items-center px-3 py-2.5 gap-2" style={{ gridTemplateColumns: 'minmax(0,1fr) auto minmax(0,1fr)' }}>

                    {/* ── LEFT: logo (desktop) + close + title + volume ── */}
                    <div className="flex items-center gap-2 min-w-0">
                        {settings.logo_url && (
                            <a
                                onClick={handleGoBack}
                                href="#"
                                className="hidden sm:flex shrink-0 items-center"
                                title={t('reader.backTitle')}
                            >
                                {isDefaultLogo ? (
                                    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 180 40" className="h-9 w-auto" style={{ maxHeight: '36px' }}>
                                        <path d="M12 10v16a3 3 0 0 0 3 3h12a3 3 0 0 0 3-3V14a3 3 0 0 0-3-3H19" 
                                              fill="none" 
                                              stroke="#8A2BE2" 
                                              strokeWidth="3.5" 
                                              strokeLinecap="round" 
                                              strokeLinejoin="round"/>
                                        <path d="M18 19h6M18 23h4" stroke="#8A2BE2" strokeWidth="2.5" strokeLinecap="round" opacity="0.7"/>
                                        <text x="45" y="26" fontFamily="system-ui, -apple-system, sans-serif" fontSize="21" fontWeight="800" fill={isDark ? "#FFFFFF" : "#111827"} letterSpacing="-0.5">
                                            Jet<tspan fontWeight="400" fill="#8A2BE2">Reader</tspan>
                                        </text>
                                    </svg>
                                ) : (
                                    <img
                                        src={settings.logo_url}
                                        alt="Logo"
                                        className="max-h-[36px] w-auto object-contain"
                                    />
                                )}
                            </a>
                        )}

                        {!isPageMode && (
                            <button
                                onClick={onClose}
                                className={`shrink-0 w-8 h-8 flex items-center justify-center rounded-lg border text-sm transition-colors jr-btn-close ${controlBtn}`}
                                title={t('reader.closeTitle')}
                            >
                                ✕
                            </button>
                        )}

                        {/* Search — mobile only (left position) */}
                        <button
                            onClick={showSearch ? closeSearch : openSearch}
                            className={`sm:hidden shrink-0 w-[38px] h-8 flex items-center justify-center rounded-lg border text-sm transition-colors jr-btn-search jr-btn-search-mobile ${showSearch ? (isDark ? 'bg-blue-700 border-blue-600 text-white' : 'bg-blue-600 border-blue-600 text-white') : controlBtn
                                }`}
                            title={t('reader.searchTitle')}
                        >
                            <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" /></svg>
                        </button>

                        <h2 className={`jr-reader-title hidden sm:block text-sm font-semibold truncate shrink ${isDark ? 'text-gray-200' : isSepia ? 'text-amber-900' : 'text-gray-800'}`}>
                            {title || metadata?.title}
                        </h2>

                        {/* Back button — icon only on mobile, icon + label on desktop */}
                        <button
                            onClick={handleGoBack}
                            className={`shrink-0 flex items-center gap-1 h-8 px-2 rounded-lg border text-xs font-medium transition-colors jr-btn-back ${controlBtn}`}
                            title={t('reader.backTitle')}
                        >
                            <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><polyline points="15 18 9 12 15 6" /></svg>
                            <span className="hidden sm:inline">{t('reader.backBtn')}</span>
                        </button>

                        {volumes && volumes.length >= 2 && (
                            <div className={`jr-vol-divider flex items-center gap-1.5 pl-2 ml-0.5 border-l shrink-0 ${isDark ? 'border-gray-700' : isSepia ? 'border-amber-300' : 'border-gray-300'}`}>
                                <span className={`hidden sm:inline text-[10px] font-semibold tracking-wide ${isDark ? 'text-gray-500' : isSepia ? 'text-amber-600' : 'text-gray-400'}`}>
                                    {itemType === 'magazine' ? t('reader.volLabelMagazine').toUpperCase() : t('reader.volLabelBook').toUpperCase()}
                                </span>
                                <select
                                    value={currentVolume}
                                    onChange={(e) => setCurrentVolume(Number(e.target.value))}
                                    className={`jr-select-volume h-8 text-xs font-medium border rounded-lg pl-2 pr-6 cursor-pointer appearance-none transition-colors focus:outline-none focus:ring-2 ${
                                        isDark
                                            ? 'hover:border-gray-400 focus:ring-blue-500'
                                            : isSepia
                                                ? 'hover:border-amber-500 focus:ring-amber-400'
                                                : 'hover:border-gray-400 focus:ring-blue-500'
                                    } ${inputCls}`}
                                    style={{ backgroundImage: `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='6' viewBox='0 0 10 6'%3E%3Cpath d='M0 0l5 6 5-6z' fill='%23888'/%3E%3C/svg%3E")`, backgroundRepeat: 'no-repeat', backgroundPosition: 'right 6px center' }}
                                >
                                    {volumes.map((_, idx) => (
                                        <option key={idx} value={idx}>{volLabel(idx)}</option>
                                    ))}
                                </select>
                            </div>
                        )}
                    </div>

                    {/* ── CENTER: Zoom controls (PDF) ── */}
                    {activeFormat === 'pdf' ? (() => {
                        // Preset zoom steps — like Chrome's PDF viewer
                        const ZOOM_PRESETS = [0.3, 0.4, 0.5, 0.75, 1.0, 1.25, 1.5, 2.0];
                        // Find next lower / higher preset relative to current zoom
                        const prevPreset = [...ZOOM_PRESETS].reverse().find(v => v < zoom - 0.01);
                        const nextPreset = ZOOM_PRESETS.find(v => v > zoom + 0.01);
                        const zoomLabel = zoom === 1.0
                            ? t('reader.fit')
                            : `${Math.round(zoom * 100)}%`;
                        return (
                            <div className="flex items-center gap-0.5 shrink-0">
                                <button
                                    onClick={() => prevPreset !== undefined && setZoom(prevPreset)}
                                    disabled={prevPreset === undefined}
                                    className={`w-7 h-7 flex items-center justify-center rounded border text-base font-bold transition-colors disabled:opacity-30 jr-btn-zoom-out ${controlBtn}`}
                                    title={t('reader.zoomOut')}
                                >−</button>
                                <button
                                    onClick={() => setZoom(1.0)}
                                    className={`jr-btn-zoom-fit h-7 px-2 min-w-[58px] text-xs font-semibold border rounded transition-colors text-center ${zoom === 1.0
                                        ? isDark ? 'bg-blue-700 border-blue-600 text-white' : isSepia ? 'bg-amber-600 border-amber-600 text-white' : 'bg-blue-600 border-blue-600 text-white'
                                        : controlBtn
                                        }`}
                                    title={t('reader.zoomFit')}
                                >{zoomLabel}</button>
                                <button
                                    onClick={() => nextPreset !== undefined && setZoom(nextPreset)}
                                    disabled={nextPreset === undefined}
                                    className={`w-7 h-7 flex items-center justify-center rounded border text-base font-bold transition-colors disabled:opacity-30 jr-btn-zoom-in ${controlBtn}`}
                                    title={t('reader.zoomIn')}
                                >+</button>
                            </div>
                        );
                    })() : (
                        <div /> /* empty center for non-PDF */
                    )}

                    {/* ── RIGHT: controls ── */}
                    <div className="flex items-center gap-1.5 justify-end">

                        {/* Search — desktop only (right position) */}
                        <button
                            onClick={showSearch ? closeSearch : openSearch}
                            className={`hidden sm:flex w-[38px] h-8 items-center justify-center rounded-lg border text-sm transition-colors jr-btn-search jr-btn-search-desktop ${showSearch ? (isDark ? 'bg-blue-700 border-blue-600 text-white' : 'bg-blue-600 border-blue-600 text-white') : controlBtn
                                }`}
                            title={t('reader.searchTitle')}
                        >
                            <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" /></svg>
                        </button>

                        {/* PDF sidebar toggle */}
                        {activeFormat === 'pdf' && (
                            <button
                                onClick={() => setPdfSidebarOpen((v) => !v)}
                                className={`w-[38px] h-8 flex items-center justify-center rounded-lg border text-sm transition-colors jr-btn-sidebar ${pdfSidebarOpen ? (isDark ? 'bg-blue-700 border-blue-600 text-white' : 'bg-blue-600 border-blue-600 text-white') : controlBtn
                                    }`}
                                title={t('reader.pdfSidebarToggle')}
                            >
                                <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><line x1="3" y1="6" x2="21" y2="6" /><line x1="3" y1="12" x2="21" y2="12" /><line x1="3" y1="18" x2="21" y2="18" /></svg>
                            </button>
                        )}

                        {/* Dual page toggle — desktop only, PDF only */}
                        {activeFormat === 'pdf' && (
                            <button
                                onClick={() => {
                                    setDualPage((v) => {
                                        // dual ON → sığdır (%100); dual OFF → %50
                                        setZoom(v ? (window.innerWidth >= 640 ? 0.75 : 1.0) : 1.0);
                                        return !v;
                                    });
                                }}
                                className={`hidden sm:flex w-[38px] h-8 items-center justify-center rounded-lg border transition-colors jr-btn-dualpage ${dualPage
                                    ? (isDark ? 'bg-blue-700 border-blue-600 text-white' : 'bg-blue-600 border-blue-600 text-white')
                                    : controlBtn
                                    }`}
                                title={dualPage ? t('reader.singlePageView') : t('reader.dualPageView')}
                            >
                                <svg xmlns="http://www.w3.org/2000/svg" width="16" height="14" viewBox="0 0 22 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                                    <rect x="1" y="1" width="9" height="13" rx="1" />
                                    <rect x="12" y="1" width="9" height="13" rx="1" />
                                </svg>
                            </button>
                        )}

                        {/* EPUB TOC toggle */}
                        {activeFormat !== 'pdf' && toc.length > 0 && (
                            <button
                                onClick={() => setTocOpen((v) => !v)}
                                className={`w-[38px] h-8 flex items-center justify-center rounded-lg border text-sm transition-colors jr-btn-toc ${tocOpen ? (isDark ? 'bg-blue-700 border-blue-600 text-white' : 'bg-blue-600 border-blue-600 text-white') : controlBtn
                                    }`}
                                title={t('reader.tocHeader')}
                            >
                                <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><line x1="3" y1="6" x2="21" y2="6" /><line x1="3" y1="12" x2="21" y2="12" /><line x1="3" y1="18" x2="21" y2="18" /></svg>
                            </button>
                        )}

                        {/* Font size (EPUB/TXT/DOCX only) */}
                        {activeFormat !== 'pdf' && (
                            <select
                                value={fontSize}
                                onChange={(e) => setFontSize(e.target.value as typeof fontSize)}
                                className={`jr-select-font h-8 text-xs font-medium border rounded-lg pl-2 pr-6 cursor-pointer appearance-none transition-colors focus:outline-none focus:ring-2 ${
                                    isDark
                                        ? 'hover:border-gray-400 focus:ring-blue-500'
                                        : isSepia
                                            ? 'hover:border-amber-500 focus:ring-amber-400'
                                            : 'hover:border-gray-400 focus:ring-blue-500'
                                } ${inputCls}`}
                                style={{ backgroundImage: `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='6' viewBox='0 0 10 6'%3E%3Cpath d='M0 0l5 6 5-6z' fill='%23888'/%3E%3C/svg%3E")`, backgroundRepeat: 'no-repeat', backgroundPosition: 'right 6px center' }}
                                title={t('reader.fontSizeTitle')}
                            >
                                <option value="small">{t('reader.small')}</option>
                                <option value="medium">{t('reader.medium')}</option>
                                <option value="large">{t('reader.large')}</option>
                                <option value="xlarge">{t('reader.xlarge')}</option>
                            </select>
                        )}

                        {/* Theme */}
                        <select
                            value={theme}
                            onChange={(e) => setTheme(e.target.value as typeof theme)}
                            className={`jr-select-theme h-8 text-xs font-medium border rounded-lg pl-2 pr-6 cursor-pointer appearance-none transition-colors focus:outline-none focus:ring-2 ${
                                isDark
                                    ? 'hover:border-gray-400 focus:ring-blue-500'
                                    : isSepia
                                        ? 'hover:border-amber-500 focus:ring-amber-400'
                                        : 'hover:border-gray-400 focus:ring-blue-500'
                            } ${inputCls}`}
                            style={{ backgroundImage: `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='6' viewBox='0 0 10 6'%3E%3Cpath d='M0 0l5 6 5-6z' fill='%23888'/%3E%3C/svg%3E")`, backgroundRepeat: 'no-repeat', backgroundPosition: 'right 6px center' }}
                            title={t('reader.themeTitle')}
                        >
                            <option value="light">{t('reader.light')}</option>
                            <option value="dark">{t('reader.dark')}</option>
                            <option value="sepia">{t('reader.sepia')}</option>
                        </select>
                    </div>
                </div>

                {/* Search bar (visible when showSearch) */}
                <AnimatePresence mode="wait">
                    {showSearch && (
                        <motion.div
                            initial={{ height: 0, opacity: 0 }}
                            animate={{ height: 'auto', opacity: 1 }}
                            exit={{ height: 0, opacity: 0 }}
                            className={`overflow-hidden border-t ${isDark ? 'border-gray-800' : isSepia ? 'border-amber-300' : 'border-gray-200'}`}
                        >
                            <div className="flex items-center gap-2 px-3 py-2">

                                {/* Input */}
                                <input
                                    ref={searchInputRef}
                                    value={searchQuery}
                                    onChange={(e) => { setSearchQuery(e.target.value); setSearchDone(false); setSearchMatches([]); }}
                                    onKeyDown={(e) => {
                                        if (e.key === 'Enter') handleSearch();
                                        if (e.key === 'Escape') closeSearch();
                                    }}
                                    placeholder={
                                        pdfTextExtracting
                                            ? t('reader.searchIndexing')
                                            : t('reader.searchPlaceholderText')
                                    }
                                    disabled={pdfTextExtracting}
                                    className={`flex-1 min-w-0 text-xs border rounded-lg px-3 py-1.5 ${inputCls} outline-none focus:ring-2 focus:ring-blue-500/50 disabled:opacity-50`}
                                />

                                {/* Scanned PDF notice */}
                                {activeFormat === 'pdf' && !pdfTextExtracting && pdfTextCache !== null && pdfTextCache.join('').length < 50 && (
                                    <span className={`text-xs shrink-0 ${isDark ? 'text-amber-400' : 'text-amber-600'}`}>
                                        {t('reader.scannedPdf')}
                                    </span>
                                )}

                                {/* Indexing pulse */}
                                {pdfTextExtracting && (
                                    <span className={`text-xs shrink-0 animate-pulse ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>
                                        {t('reader.indexing')}
                                    </span>
                                )}

                                {/* Ara button */}
                                {!pdfTextExtracting && (
                                    <button
                                        onClick={handleSearch}
                                        className={`shrink-0 px-3 py-1.5 text-xs rounded-lg border font-medium transition-colors jr-btn-search-submit ${controlBtn}`}
                                    >
                                        {t('common.search')}
                                    </button>
                                )}

                                {/* ‹ N/M › navigation */}
                                {searchMatches.length > 0 && (
                                    <div className="flex items-center gap-1 shrink-0">
                                        <button
                                            onClick={searchPrev}
                                            className={`w-6 h-6 flex items-center justify-center rounded border text-sm leading-none jr-btn-search-prev ${controlBtn}`}
                                            title={t('reader.prevBtn')}
                                        >
                                            ‹
                                        </button>
                                        <span className={`text-xs font-mono min-w-[36px] text-center ${isDark ? 'text-gray-300' : 'text-gray-600'}`}>
                                            {searchMatchIdx + 1}/{searchMatches.length}
                                        </span>
                                        <button
                                            onClick={searchNext}
                                            className={`w-6 h-6 flex items-center justify-center rounded border text-sm leading-none jr-btn-search-next ${controlBtn}`}
                                            title={t('reader.nextBtn')}
                                        >
                                            ›
                                        </button>
                                    </div>
                                )}

                                {/* Not found */}
                                {!pdfTextExtracting && searchDone && searchMatches.length === 0 && (
                                    <span className="text-xs shrink-0 text-red-400">{t('reader.searchNotFound')}</span>
                                )}

                                {/* Close */}
                                <button
                                    onClick={closeSearch}
                                    className={`shrink-0 w-7 h-7 flex items-center justify-center rounded border text-xs jr-btn-search-close ${controlBtn}`}
                                >
                                    ✕
                                </button>
                            </div>
                        </motion.div>
                    )}
                </AnimatePresence>
            </div>

            {/* ══════════════════════════════════════════════════════ */}
            {/*  BODY: TOC + CONTENT                                  */}
            {/* ══════════════════════════════════════════════════════ */}
            <div className="flex flex-1 overflow-hidden relative">

                {/* Desktop sidebar — PDF panel or EPUB TOC */}
                {activeFormat === 'pdf' && pdfSidebarOpen && pdfDocRef.current && (
                    <aside className={`hidden md:flex flex-col w-[335px] shrink-0 border-r overflow-hidden ml-1.5 rounded-tr-lg rounded-br-lg jr-border`}>
                        <PdfSidebar
                            pdfDoc={pdfDocRef.current}
                            totalPages={pages.length}
                            currentPage={currentPage}
                            outline={toc}
                            onJump={setCurrentPage}
                            onClose={() => setPdfSidebarOpen(false)}
                            theme={theme}
                        />
                    </aside>
                )}
                {activeFormat !== 'pdf' && toc.length > 0 && tocOpen && (
                    <aside className={`hidden md:flex flex-col w-[335px] shrink-0 border-r overflow-hidden ml-1.5 rounded-tr-lg rounded-br-lg jr-border`}>
                        <TocSidebar
                            toc={toc}
                            currentPage={currentPage}
                            onJump={(pageIndex, fragmentId) => {
                                setCurrentPage(pageIndex);
                                if (fragmentId) { setTocJumpFragment(fragmentId); setTocJumpKey(k => k + 1); }
                            }}
                            onClose={() => setTocOpen(false)}
                            theme={theme}
                        />
                    </aside>
                )}

                {/* Content area — PDF zoom=1: fit+no-scroll; PDF zoom>1: overflow-auto; others: scrollable */}
                <div
                    className={`flex-1 relative jr-scrollbar ${activeFormat === 'pdf'
                        ? zoom === 1.0 ? 'overflow-hidden' : 'overflow-auto'
                        : 'overflow-hidden'
                        }`}
                    onMouseUp={handleTextSelection}
                    onCopy={handleCopy}
                    onContextMenu={handleContextMenu}
                    style={{ userSelect: (settings.copy_enabled || settings.annotation_enabled) ? 'text' : 'none' }}
                    ref={contentRef}
                >
                    {/* Loading */}
                    {loading && (
                        <div className="flex items-center justify-center h-full">
                            <div className="text-center">
                                <div className="w-10 h-10 border-2 border-blue-500 border-t-transparent rounded-full animate-spin mx-auto mb-4" />
                                <p className={`text-sm ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>
                                    {t('reader.loadingBook')}
                                </p>
                            </div>
                        </div>
                    )}

                    {/* Error */}
                    {!loading && error && (
                        <div className="flex items-center justify-center h-full">
                            <div className="text-center">
                                <svg xmlns="http://www.w3.org/2000/svg" width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className="mx-auto mb-3 text-yellow-500" aria-hidden="true"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" /><line x1="12" y1="9" x2="12" y2="13" /><line x1="12" y1="17" x2="12.01" y2="17" /></svg>
                                <p className="text-red-500 text-sm max-w-sm">{error}</p>
                                <button onClick={onClose} className="mt-4 text-sm underline opacity-60 hover:opacity-100 jr-btn-error-close">
                                    {t('reader.close')}
                                </button>
                            </div>
                        </div>
                    )}

                    {/* No content */}
                    {!loading && !error && pages.length === 0 && (
                        <div className="flex items-center justify-center h-full">
                            <div className="text-center">
                                <svg xmlns="http://www.w3.org/2000/svg" width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className="mx-auto mb-3 opacity-40" aria-hidden="true"><path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z" /><path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z" /></svg>
                                <p className={`text-sm ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>{t('reader.noContent')}</p>
                            </div>
                        </div>
                    )}

                    {/* Content */}
                    {!loading && !error && pages.length > 0 && renderContent()}
                </div>

                {/* Mobile PDF sidebar drawer */}
                <AnimatePresence mode="wait">
                    {activeFormat === 'pdf' && pdfSidebarOpen && pdfDocRef.current && (
                        <>
                            <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
                                className="md:hidden fixed inset-0 bg-black/50 z-10"
                                onClick={() => setPdfSidebarOpen(false)}
                            />
                            <motion.aside initial={{ x: '-100%' }} animate={{ x: 0 }} exit={{ x: '-100%' }}
                                transition={{ type: 'spring', damping: 28, stiffness: 220 }}
                                className={`md:hidden fixed top-0 left-0 h-full w-[335px] z-20 flex flex-col shadow-2xl border-r ${sidebarBg}`}
                            >
                                <PdfSidebar
                                    pdfDoc={pdfDocRef.current}
                                    totalPages={pages.length}
                                    currentPage={currentPage}
                                    outline={toc}
                                    onJump={setCurrentPage}
                                    onClose={() => setPdfSidebarOpen(false)}
                                    isMobile
                                    theme={theme}
                                />
                            </motion.aside>
                        </>
                    )}
                </AnimatePresence>

                {/* Mobile EPUB TOC drawer */}
                <AnimatePresence mode="wait">
                    {activeFormat !== 'pdf' && toc.length > 0 && tocOpen && (
                        <>
                            <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
                                className="md:hidden fixed inset-0 bg-black/50 z-10"
                                onClick={() => setTocOpen(false)}
                            />
                            <motion.aside initial={{ x: '-100%' }} animate={{ x: 0 }} exit={{ x: '-100%' }}
                                transition={{ type: 'spring', damping: 28, stiffness: 220 }}
                                className={`md:hidden fixed top-0 left-0 h-full w-[335px] z-20 flex flex-col shadow-2xl border-r ${sidebarBg}`}
                            >
                                <TocSidebar
                                    toc={toc}
                                    currentPage={currentPage}
                                    onJump={(pageIndex, fragmentId) => {
                                        setCurrentPage(pageIndex);
                                        if (fragmentId) { setTocJumpFragment(fragmentId); setTocJumpKey(k => k + 1); }
                                    }}
                                    onClose={() => setTocOpen(false)}
                                    isMobile
                                    theme={theme}
                                />
                            </motion.aside>
                        </>
                    )}
                </AnimatePresence>
            </div>

            {/* ══════════════════════════════════════════════════════ */}
            {/*  BOTTOM BAR                                           */}
            {/* ══════════════════════════════════════════════════════ */}
            {!loading && !error && pages.length > 0 && (
                <div className={`shrink-0 border-t ${toolbarBg}`} style={{ backgroundColor: toolbarBgHex }}>

                    {/* Navigation row */}
                    <div className="flex items-center gap-2 px-3 py-2">

                        {/* Prev */}
                        <button
                            onClick={() => setCurrentPage((p) => Math.max(p - (dualPage ? 2 : 1), 0))}
                            disabled={currentPage === 0}
                            className={`flex items-center justify-center min-w-[36px] sm:px-3 py-2 sm:py-1.5 text-xs border rounded-lg transition-all active:scale-95 disabled:opacity-30 disabled:cursor-not-allowed jr-btn-prev ${controlBtn}`}
                            aria-label={t('reader.prevBtn')}
                        >
                            <span className="hidden sm:inline-flex items-center gap-1.5 transition-opacity hover:opacity-80">
                                <span className="text-sm font-bold">←</span>
                                <span>{t('common.previous')}</span>
                            </span>
                            <span className="sm:hidden text-lg font-bold">←</span>
                        </button>

                        {/* Centered Indicator / Input */}
                        <div className={`flex items-center gap-2 px-3 py-1.5 rounded-full border border-black/5 dark:border-white/10 shadow-sm ${isDark ? 'bg-black/40' : 'bg-white/60'}`}>
                            <div className="flex items-center gap-1">
                                <input
                                    type="text"
                                    value={pageInputVal}
                                    onChange={(e) => setPageInputVal(e.target.value)}
                                    onBlur={() => {
                                        const v = parseInt(pageInputVal, 10) - 1;
                                        if (!isNaN(v) && v >= 0 && v < pages.length) {
                                            setCurrentPage(v);
                                        } else {
                                            setPageInputVal(String(currentPage + 1));
                                        }
                                    }}
                                    onKeyDown={(e) => {
                                        if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
                                    }}
                                    className={`jr-page-input w-8 sm:w-12 text-center text-xs font-extrabold bg-transparent border-none p-0 outline-none ${textColor}`}
                                />
                                <span className={`text-[10px] sm:text-xs opacity-50 font-bold ${textColor}`}>
                                    / {pages.length}
                                </span>
                            </div>
                        </div>

                        {/* Next */}
                        <button
                            onClick={() => setCurrentPage((p) => Math.min(p + (dualPage ? 2 : 1), pages.length - 1))}
                            disabled={currentPage >= pages.length - 1}
                            className={`flex items-center justify-center min-w-[36px] sm:px-3 py-2 sm:py-1.5 text-xs border rounded-lg transition-all active:scale-95 disabled:opacity-30 disabled:cursor-not-allowed jr-btn-next ${controlBtn}`}
                            aria-label={t('reader.nextBtn')}
                        >
                            <span className="hidden sm:inline-flex items-center gap-1.5 transition-opacity hover:opacity-80">
                                <span>{t('common.next')}</span>
                                <span className="text-sm font-bold">→</span>
                            </span>
                            <span className="sm:hidden text-lg font-bold">→</span>
                        </button>

                        {/* Progress bar */}
                        <div className={`flex-1 mx-2 h-1.5 rounded-full overflow-hidden ${isDark ? 'bg-gray-800' : isSepia ? 'bg-amber-200' : 'bg-gray-200'}`}>
                            <div
                                className={`h-full rounded-full transition-all duration-300 ${isSepia ? 'bg-amber-700' : 'bg-blue-500'}`}
                                style={{ width: `${((currentPage + 1) / pages.length) * 100}%` }}
                            />
                        </div>

                        {/* Action buttons */}
                        <div className="flex items-center gap-1 shrink-0">
                            <button
                                onClick={addBookmark}
                                className={`px-2.5 py-1 text-xs border rounded-lg transition-colors jr-btn-bookmark-toggle ${currentPageBookmark
                                    ? 'bg-yellow-400/20 border-yellow-500/50 text-yellow-600'
                                    : controlBtn
                                    }`}
                                title={t('reader.bookmarkToggle')}
                            >
                                <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill={currentPageBookmark ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z" /></svg>
                            </button>
                            <button
                                onClick={() => setBottomTab(bottomTab === 'bookmarks' ? null : 'bookmarks')}
                                className={`px-2 py-1 text-xs border rounded-lg transition-colors jr-btn-bookmarks-tab ${bottomTab === 'bookmarks' ? (isDark ? 'bg-blue-700 border-blue-600 text-white' : 'bg-blue-600 border-blue-600 text-white') : controlBtn}`}
                                title={t('reader.showBookmarks')}
                            >
                                <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z" /><line x1="7" y1="8" x2="17" y2="8" /></svg>
                                {bookmarks.length > 0 && ` ${bookmarks.length}`}
                            </button>
                            <button
                                onClick={() => setBottomTab(bottomTab === 'annotations' ? null : 'annotations')}
                                className={`px-2 py-1 text-xs border rounded-lg transition-colors jr-btn-annotations-tab ${bottomTab === 'annotations' ? (isDark ? 'bg-blue-700 border-blue-600 text-white' : 'bg-blue-600 border-blue-600 text-white') : controlBtn}`}
                                title={t('reader.showAnnotations')}
                            >
                                <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" /><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" /></svg>
                                {annotations.length > 0 && ` ${annotations.length}`}
                            </button>
                        </div>
                    </div>

                    {/* Slide-up bookmarks / annotations panel */}
                    <AnimatePresence mode="wait">
                        {bottomTab && (
                            <motion.div
                                initial={{ height: 0, opacity: 0 }}
                                animate={{ height: 'auto', opacity: 1 }}
                                exit={{ height: 0, opacity: 0 }}
                                className={`overflow-hidden border-t ${isDark ? 'border-gray-800 bg-gray-900' : isSepia ? 'border-amber-200 bg-amber-50' : 'border-gray-200 bg-white'}`}
                            >
                                <div className="max-h-52 overflow-y-auto px-4 py-3">
                                    {bottomTab === 'bookmarks' && (
                                        <>
                                            <h4 className={`text-[10px] font-bold uppercase tracking-widest mb-2 ${isDark ? 'text-gray-500' : 'text-gray-400'}`}>
                                                {t('reader.bookmarksHeader')} ({bookmarks.length})
                                            </h4>
                                            {bookmarks.length === 0 && (
                                                <p className={`text-xs ${isDark ? 'text-gray-600' : 'text-gray-400'}`}>
                                                    {t('reader.noBookmarks')}
                                                </p>
                                            )}
                                            <div className="flex flex-wrap gap-2">
                                                {bookmarks.map((bm) => (
                                                    <div
                                                        key={bm.id}
                                                        className="flex items-center gap-1.5 px-2.5 py-1 text-xs rounded-full cursor-pointer border transition-colors hover:opacity-80"
                                                        style={{ borderColor: bm.color, backgroundColor: `${bm.color}18` }}
                                                        onClick={() => setCurrentPage(bm.pageIndex)}
                                                        title={bm.label}
                                                    >
                                                        <span>{t('reader.pageAbbr')} {bm.pageIndex + 1}</span>
                                                        {bm.label && (
                                                            <span className={`max-w-[80px] truncate hidden sm:inline ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>
                                                                — {bm.label}
                                                            </span>
                                                        )}
                                                        <button
                                                            onClick={(e) => { e.stopPropagation(); removeBookmark(bm.id); }}
                                                            className="text-red-400 hover:text-red-600 ml-0.5 jr-btn-bookmark-remove"
                                                        >✕</button>
                                                    </div>
                                                ))}
                                            </div>
                                        </>
                                    )}

                                    {bottomTab === 'annotations' && (
                                        <>
                                            <h4 className={`text-[10px] font-bold uppercase tracking-widest mb-2 ${isDark ? 'text-gray-500' : 'text-gray-400'}`}>
                                                {t('reader.notesHeader')} ({annotations.length})
                                            </h4>
                                            {annotations.length === 0 && (
                                                <p className={`text-xs ${isDark ? 'text-gray-600' : 'text-gray-400'}`}>
                                                    {t('reader.noAnnotations')}
                                                </p>
                                            )}
                                            <div className="space-y-2">
                                                {annotations.map((annot) => (
                                                    <div
                                                        key={annot.id}
                                                        className="flex items-start gap-2 p-2 text-xs rounded-lg cursor-pointer transition-colors hover:opacity-80"
                                                        style={{ borderLeft: `3px solid ${annot.color}` }}
                                                        onClick={() => setCurrentPage(annot.pageIndex)}
                                                    >
                                                        <div className="flex-1 min-w-0">
                                                            <blockquote className={`italic truncate ${isDark ? 'text-gray-400' : 'text-gray-600'}`}>
                                                                &ldquo;{annot.text}&rdquo;
                                                            </blockquote>
                                                            {annot.note && (
                                                                <p className={`mt-0.5 ${isDark ? 'text-gray-200' : 'text-gray-800'}`}>
                                                                    {annot.note}
                                                                </p>
                                                            )}
                                                            <p className={`mt-0.5 ${isDark ? 'text-gray-600' : 'text-gray-400'}`}>
                                                                {t('readerEngine.pageLabel')} {annot.pageIndex + 1}
                                                            </p>
                                                        </div>
                                                        <button
                                                            onClick={(e) => { e.stopPropagation(); removeAnnotation(annot.id); }}
                                                            className="text-red-400 hover:text-red-600 shrink-0 jr-btn-annotation-remove"
                                                        >✕</button>
                                                    </div>
                                                ))}
                                            </div>
                                        </>
                                    )}
                                </div>
                            </motion.div>
                        )}
                    </AnimatePresence>
                </div>
            )}

            {/* ══════════════════════════════════════════════════════ */}
            {/*  ANNOTATION INPUT POPUP                               */}
            {/* ══════════════════════════════════════════════════════ */}
            <AnimatePresence mode="wait">
                {showAnnotationInput && settings.annotation_enabled && (
                    <motion.div
                        initial={{ opacity: 0, y: 16, scale: 0.97 }}
                        animate={{ opacity: 1, y: 0, scale: 1 }}
                        exit={{ opacity: 0, y: 16, scale: 0.97 }}
                        className={`fixed bottom-24 left-1/2 -translate-x-1/2 shadow-2xl border rounded-2xl p-4 w-[360px] max-w-[95vw] z-[10001] ${isDark ? 'bg-gray-900 border-gray-700' : isSepia ? 'bg-amber-50 border-amber-300' : 'bg-white border-gray-200'
                            }`}
                    >
                        <p className={`text-[10px] font-semibold uppercase tracking-wider mb-1.5 ${isDark ? 'text-gray-500' : 'text-gray-400'}`}>
                            {t('reader.selectedText')}
                        </p>
                        <blockquote className={`text-sm italic rounded-lg p-2.5 mb-3 leading-relaxed ${isDark ? 'bg-gray-800 text-gray-300' : isSepia ? 'bg-amber-100 text-amber-900' : 'bg-gray-100 text-gray-700'}`}>
                            &ldquo;{selectedText}&rdquo;
                        </blockquote>

                        <textarea
                            value={annotationNote}
                            onChange={(e) => setAnnotationNote(e.target.value)}
                            placeholder={t('reader.addNotePlaceholder')}
                            className={`w-full text-sm border rounded-lg p-2.5 mb-3 resize-none outline-none focus:ring-2 focus:ring-blue-500/40 ${inputCls}`}
                            rows={2}
                        />

                        <div className="flex items-center gap-2 mb-3">
                            {ANNOTATION_COLORS.map((color) => (
                                <button
                                    key={color}
                                    onClick={() => setActiveAnnotColor(color)}
                                    className={`w-6 h-6 rounded-full border-2 transition-transform hover:scale-110 jr-btn-color-picker ${activeAnnotColor === color ? 'scale-125 border-gray-800 dark:border-white shadow-md' : 'border-transparent'
                                        }`}
                                    style={{ '--jr-swatch-bg': color } as React.CSSProperties}
                                />
                            ))}
                        </div>

                        <div className="flex gap-2">
                            <button
                                onClick={addAnnotation}
                                className="flex-1 py-2 text-sm bg-blue-600 text-white rounded-xl hover:bg-blue-700 transition-colors font-medium jr-btn-annotation-save"
                            >
                                {t('common.save')}
                            </button>
                            <button
                                onClick={() => {
                                    setShowAnnotationInput(false);
                                    setSelectedText('');
                                    setAnnotationNote('');
                                    window.getSelection()?.removeAllRanges();
                                }}
                                className={`flex-1 py-2 text-sm rounded-xl transition-colors font-medium jr-btn-annotation-cancel ${isDark ? 'bg-gray-700 text-gray-200 hover:bg-gray-600' : isSepia ? 'bg-amber-100 text-amber-900 hover:bg-amber-200' : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
                                    }`}
                            >
                                {t('reader.cancelAnnotation')}
                            </button>
                        </div>
                    </motion.div>
                )}
            </AnimatePresence>
        </motion.div>
    );

    // Modal mode portals to a dedicated wrapper div inside document.body.
    // We use a stable wrapper (created once, reused across open/close cycles)
    // so React never fights with WordPress themes, plugins, or browser
    // extensions that may mutate document.body children directly.
    const [portalRoot] = useState(() => {
        if (isPageMode) return null;
        let el = document.getElementById('jetreader-portal-root');
        if (!el) {
            el = document.createElement('div');
            el.id = 'jetreader-portal-root';
            document.body.appendChild(el);
        }
        return el;
    });

    // Clean up the portal root on final unmount (e.g. SPA navigation).
    useEffect(() => {
        return () => {
            const el = document.getElementById('jetreader-portal-root');
            if (el && el.childNodes.length === 0) {
                el.remove();
            }
        };
    }, []);

    return isPageMode ? readerUi : portalRoot ? createPortal(readerUi, portalRoot) : readerUi;
};

export default ReaderModal;
