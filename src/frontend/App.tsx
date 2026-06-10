import React, { useEffect, useState, lazy, Suspense } from 'react';
import {
    QueryClient,
    QueryClientProvider,
    useQuery,
} from '@tanstack/react-query';
import { motion, AnimatePresence } from 'framer-motion';
import type { ReaderFormat } from '../reader/ReaderEngine';

const ReaderModal = lazy( () => import( '../reader/ReaderModal' ) );
import { I18nProvider, useTranslation } from '../i18n/I18nContext';
import { WORLD_LANGUAGES } from '../data/world-languages';
import { LangCombobox } from '../admin/LangCombobox';

function getLangDisplayName( code: string, uiLocale: string ): string {
    if ( ! code ) return '';
    const langEntry = WORLD_LANGUAGES.find( ( l ) => l.code === code );
    if ( ! langEntry ) return code.toUpperCase();
    try {
        const dn = new Intl.DisplayNames( [ uiLocale, 'en' ], { type: 'language' } );
        const result = dn.of( langEntry.code );
        if ( result && result !== langEntry.code ) return result;
    } catch {}
    return langEntry.name;
}

const queryClient = new QueryClient( {
    defaultOptions: { queries: { staleTime: 1000 * 60 * 3, retry: 1 } },
} );

/* ------------------------------------------------------------------ */
/*  Constants                                                          */
/* ------------------------------------------------------------------ */

const API_BASE = ( ( window as any ).jetreaderSettings?.apiUrl ?? '/wp-json/jetreader/v1' ).replace( /\/$/, '' );

const CONTENT_TYPES = [
    { key: '' as const,         icon: '📋' },
    { key: 'book' as const,     icon: '📚' },
    { key: 'article' as const,  icon: '📄' },
    { key: 'magazine' as const, icon: '🗞️' },
    { key: 'qa' as const,       icon: '💬' },
];

type ContentTypeKey = '' | 'book' | 'article' | 'magazine' | 'qa';

function getTypeLabel( key: ContentTypeKey | '', t: ( k: string ) => string ): string {
    const map: Record<string, string> = {
        '':         t( 'frontend.typeTabsAll' ),
        'book':     t( 'frontend.typeTabsBooks' ),
        'article':  t( 'frontend.typeTabsArticles' ),
        'magazine': t( 'frontend.typeTabsMagazines' ),
        'qa':       t( 'frontend.typeTabsQA' ),
    };
    return map[ key ] ?? key;
}

const CARD_SIZE: Record<string, string> = {
    small:  'h-24',
    medium: 'h-36',
    large:  'h-52',
    xlarge: 'h-72',
    xxlarge: 'h-[308px]',
};


function getNonce(): string {
    return ( window as any ).jetreaderSettings?.nonce
        || ( window as any ).wpApiSettings?.nonce
        || '';
}

function resolveFileFormat( item: LibraryItem ): ReaderFormat {
    const t = ( item.file_type || '' ).toLowerCase();
    if ( t === 'epub' ) return 'epub';
    if ( t === 'pdf' )  return 'pdf';
    if ( t === 'txt' )  return 'txt';
    if ( t === 'docx' ) return 'docx';
    return 'pdf';
}

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

interface VolumeEntry {
    vol: number;
    file_path: string;
    file_type: string;
    cover_image: string;
    page_count?: number;
    encoding?: string;
}

interface LibraryItem {
    id: number;
    type: string;
    title: string;
    slug: string;
    description: string;
    cover_image: string;
    file_path: string;
    file_type: string;
    language: string;
    author: string;
    translator?: string;
    publisher: string;
    publication_year: number;
    reading_time: number;
    page_count?: number;
    featured: boolean;
    view_count: number;
    volumes?: VolumeEntry[] | null;
    cpt_url?: string;
    created_at: string;
    metadata?: {
        encoding?: string;
    } | null;
}

interface PaginatedResponse {
    items: LibraryItem[];
    total: number;
    page: number;
    per_page: number;
    pages: number;
}

interface Category  { id: number; name: string; slug: string; type: string; }
interface Author    { id: number; name: string; slug: string; }
interface Publisher { id: number; name: string; slug: string; }

interface PublicSettings {
    annotation_enabled: boolean;
    copy_enabled: boolean;
    download_enabled: boolean;
    items_per_page: number;
    grid_columns: number;
    show_sidebar: boolean;
    show_filter_category: boolean;
    show_filter_language: boolean;
    show_filter_year: boolean;
    show_filter_author: boolean;
    show_filter_publisher: boolean;
    show_filter_translator: boolean;
    show_filter_featured: boolean;
    show_filter_type: boolean;
    library_image_size:     string;
    library_image_fit:      string;
    library_card_min_width: number;
    library_show_read_button: boolean;
    library_show_info_button: boolean;
    library_show_search: boolean;
    show_card_image: boolean;
    show_card_title: boolean;
    show_card_author: boolean;
    show_card_translator: boolean;
    show_card_publisher: boolean;
    show_card_year: boolean;
    show_card_type: boolean;
    show_card_language?: boolean;
    show_card_page_count?: boolean;
    library_card_radius?: string;
    library_card_border?: string;
    library_card_shadow?: string;
    library_card_hover?: string;
    library_card_align?: string;
    library_card_layout?: string;
    show_detail_image?: boolean;
    show_detail_title?: boolean;
    show_detail_author?: boolean;
    show_detail_translator?: boolean;
    show_detail_publisher?: boolean;
    show_detail_year?: boolean;
    show_detail_type?: boolean;
    show_detail_language?: boolean;
    show_detail_page_count?: boolean;
    reader_font_size?: string;
    reader_theme?: string;
}

interface ActiveFilters {
    categoryIds: number[];
    language: string;
    yearFrom: string;
    yearTo: string;
    authorNames: string[];
    publisherNames: string[];
    translator: string;
    featured: boolean;
    type: ContentTypeKey | '';
}

const DEFAULT_FILTERS: ActiveFilters = {
    categoryIds: [],
    language: '',
    yearFrom: '',
    yearTo: '',
    authorNames: [],
    publisherNames: [],
    translator: '',
    featured: false,
    type: '',
};

/* ------------------------------------------------------------------ */
/*  Content-search types                                               */
/* ------------------------------------------------------------------ */

interface ContentMatch {
    excerpt: string;
    page_num: number;
    volume_idx: number;
}

interface ContentSearchResult {
    item_id: number;
    title: string;
    cover_url: string;
    type: string;
    author?: string;
    publisher?: string;
    file_type?: string;
    year?: string | number;
    cpt_url: string;
    matches: ContentMatch[];
    total_matches?: number;
    match_type: 'content' | 'title' | 'author' | 'publisher';
}

/* ------------------------------------------------------------------ */
/*  Hooks                                                              */
/* ------------------------------------------------------------------ */

function usePublicSettings() {
    return useQuery<PublicSettings>( {
        queryKey: [ 'public-settings' ],
        queryFn: async () => {
            const res = await fetch( `${API_BASE}/public/settings` );
            return res.json();
        },
        staleTime: 1000 * 60 * 10,
    } );
}

function useCategories( type?: string ) {
    return useQuery<Category[]>( {
        queryKey: [ 'categories', type || '' ],
        queryFn: async () => {
            const url = type ? `${API_BASE}/categories?type=${ encodeURIComponent( type ) }` : `${API_BASE}/categories`;
            const res = await fetch( url );
            return res.json();
        },
        staleTime: 1000 * 60 * 10,
    } );
}

function useAuthors() {
    return useQuery<Author[]>( {
        queryKey: [ 'authors' ],
        queryFn: async () => {
            const res = await fetch( `${API_BASE}/authors` );
            return res.json();
        },
        staleTime: 1000 * 60 * 10,
    } );
}

function usePublishers() {
    return useQuery<Publisher[]>( {
        queryKey: [ 'publishers' ],
        queryFn: async () => {
            const res = await fetch( `${API_BASE}/publishers` );
            return res.json();
        },
        staleTime: 1000 * 60 * 10,
    } );
}

function useContentSearch( q: string ) {
    return useQuery<{ results: ContentSearchResult[] }>( {
        queryKey: [ 'content-search', q ],
        queryFn: async () => {
            if ( q.length < 2 ) return { results: [] };
            const res = await fetch(
                `${API_BASE}/content-search?q=${ encodeURIComponent( q ) }&limit=20`,
                { headers: { 'X-WP-Nonce': getNonce() } }
            );
            return res.json();
        },
        enabled: q.length >= 2,
        staleTime: 1000 * 60 * 5,
    } as any );
}

// Single quotes / apostrophes → ' (U+0027) — includes Arabic romanization ʾ/ʿ
const _APOS_RE   = /[‘’‚‛ʼʻ＇`´ʾʿ]/g;
// Double quotes → " (U+0022)
const _DQUOTE_RE = /[“”„‟«»]/g;
// Dashes → - (U+002D): en-dash, em-dash, minus sign, fullwidth dash variants
const _DASH_RE   = /[‐‑‒–—―−﹘﹣－]/g;
// Full-width ASCII punctuation → ASCII  (U+FFxx − 0xFEE0 = ASCII code)
const _FWIDTH_RE = /[！？．，；：（）]/g;

/**
 * Normalise a string for highlight comparison: NFC + Turkish İ/ı → i +
 * all typographic variants (apostrophes, double quotes, dashes, full-width) → ASCII.
 * Every substitution is 1:1 BMP code-unit, so normText.length === text.length always.
 */
function _normHL( s: string ): string {
    return s
        .normalize( 'NFC' )
        .replace( /İ/g, 'i' )
        .replace( _APOS_RE,   "'" )
        .replace( _DQUOTE_RE, '"' )
        .replace( _DASH_RE,   '-' )
        .replace( _FWIDTH_RE, ( m ) => String.fromCodePoint( m.codePointAt( 0 )! - 0xFEE0 ) )
        .toLowerCase()
        .replace( /ı/g, 'i' );
}

/** Highlight every occurrence of `term` in `text` with a yellow mark.
 *  Case-insensitive, apostrophe-variant-insensitive, Turkish-aware. */
function highlightTerm( text: string, term: string ): React.ReactNode {
    if ( ! term || ! text ) return text;
    const normTerm = _normHL( term );
    const normText = _normHL( text );
    if ( ! normTerm || normText.length !== text.length ) return text;

    const hits: [ number, number ][] = [];
    let i = 0;
    while ( i < normText.length ) {
        const idx = normText.indexOf( normTerm, i );
        if ( idx === -1 ) break;
        hits.push( [ idx, idx + normTerm.length ] );
        i = idx + 1;
    }
    if ( ! hits.length ) return text;

    const out: React.ReactNode[] = [];
    let pos = 0;
    hits.forEach( ( [ s, e ], ki ) => {
        if ( s > pos ) out.push( text.slice( pos, s ) );
        out.push(
            <mark key={ ki } className="bg-yellow-200 dark:bg-yellow-800 rounded-sm px-0.5 not-italic">
                { text.slice( s, e ) }
            </mark>
        );
        pos = e;
    } );
    if ( pos < text.length ) out.push( text.slice( pos ) );
    return out;
}


/* ------------------------------------------------------------------ */
/*  FilterSidebar                                                      */
/* ------------------------------------------------------------------ */

const SidebarSection: React.FC<{ title: string; children: React.ReactNode; defaultOpen?: boolean }> = ( { title, children, defaultOpen = true } ) => {
    const [ open, setOpen ] = useState( defaultOpen );
    return (
        <div style={ { borderBottom: '1px solid var(--jr-sidebar-divider, rgba(0,0,0,0.07))', paddingBottom: '12px', marginBottom: '12px' } }
             className="last:border-b-0 last:pb-0 last:mb-0">
            <button
                onClick={ () => setOpen( ( v ) => ! v ) }
                style={ { width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'space-between', border: 'none', background: 'none', cursor: 'pointer', padding: '4px 0', marginBottom: open ? '8px' : 0 } }
            >
                <span style={ { fontSize: '11px', fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--jr-p600, #4f46e5)' } }>
                    { title }
                </span>
                <span style={ { fontSize: '10px', color: 'var(--jr-p400, #818cf8)', transition: 'transform 0.2s', display: 'inline-block', transform: open ? 'rotate(0deg)' : 'rotate(-90deg)' } }>
                    ▼
                </span>
            </button>
            { open && children }
        </div>
    );
};

interface SidebarProps {
    settings: PublicSettings;
    categories: Category[];
    authors: Author[];
    publishers: Publisher[];
    filters: ActiveFilters;
    forcedType: ContentTypeKey | null;
    onFilterChange: ( partial: Partial<ActiveFilters> ) => void;
    onClear: () => void;
    onMobileClose?: () => void;
}

const inputStyle: React.CSSProperties = {
    width: '100%',
    fontSize: '13px',
    border: '1px solid rgba(0,0,0,0.12)',
    borderRadius: '8px',
    padding: '6px 10px',
    background: 'var(--jr-sidebar-input-bg, rgba(0,0,0,0.03))',
    color: 'inherit',
    outline: 'none',
    boxSizing: 'border-box',
};

const FilterSidebar: React.FC<SidebarProps> = ( {
    settings, categories, authors, publishers, filters, onFilterChange, onClear, onMobileClose,
} ) => {
    const { t, availableLanguages, locale } = useTranslation();

    const toggleCategory = ( id: number ) => {
        const next = filters.categoryIds.includes( id )
            ? filters.categoryIds.filter( ( c ) => c !== id )
            : [ ...filters.categoryIds, id ];
        onFilterChange( { categoryIds: next } );
    };

    const toggleAuthorName = ( name: string ) => {
        const next = filters.authorNames.includes( name )
            ? filters.authorNames.filter( ( n ) => n !== name )
            : [ ...filters.authorNames, name ];
        onFilterChange( { authorNames: next } );
    };

    const togglePublisherName = ( name: string ) => {
        const next = filters.publisherNames.includes( name )
            ? filters.publisherNames.filter( ( n ) => n !== name )
            : [ ...filters.publisherNames, name ];
        onFilterChange( { publisherNames: next } );
    };

    const activeCount = [
        filters.categoryIds.length > 0,
        !! filters.language,
        !! filters.yearFrom || !! filters.yearTo,
        filters.authorNames.length > 0,
        filters.publisherNames.length > 0,
        !! filters.translator,
        filters.featured,
    ].filter( Boolean ).length;

    return (
        <div style={ { display: 'flex', flexDirection: 'column', height: '100%' } }>

            { /* Header */ }
            <div style={ { display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '16px', paddingBottom: '12px', borderBottom: '2px solid var(--jr-p100, #e0e7ff)' } }>
                <span style={ { fontWeight: 700, fontSize: '13px', color: 'var(--jr-p700, #3730a3)', letterSpacing: '0.01em', display: 'flex', alignItems: 'center', gap: '6px' } }>
                    { t( 'frontend.filters' ) }
                    { activeCount > 0 && (
                        <span style={ { background: 'var(--jr-p500, #6366f1)', color: '#fff', fontSize: '11px', fontWeight: 800, borderRadius: '99px', padding: '1px 7px', lineHeight: '18px' } }>
                            { activeCount }
                        </span>
                    ) }
                </span>
                <div style={ { display: 'flex', gap: '8px', alignItems: 'center' } }>
                    { activeCount > 0 && (
                        <button
                            onClick={ onClear }
                            style={ { fontSize: '11px', color: 'var(--jr-p600, #4f46e5)', background: 'none', border: 'none', cursor: 'pointer', padding: 0, textDecoration: 'underline' } }
                        >
                            { t( 'frontend.clearAll' ) }
                        </button>
                    ) }
                    { onMobileClose && (
                        <button
                            onClick={ onMobileClose }
                            style={ { background: 'rgba(0,0,0,0.06)', border: 'none', borderRadius: '50%', width: '26px', height: '26px', cursor: 'pointer', fontSize: '13px', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--jr-p600, #4f46e5)' } }
                        >✕</button>
                    ) }
                </div>
            </div>

            <div style={ { flex: 1, overflowY: 'auto' } }>

                { /* Category multi-select */ }
                { settings.show_filter_category && categories.length > 0 && (
                    <SidebarSection title={ t( 'frontend.sidebarCategory' ) }>
                        <div className="scrollbar-palette" style={ { display: 'flex', flexDirection: 'column', gap: '4px', maxHeight: '180px', overflowY: 'auto', paddingRight: '4px' } }>
                            { categories.map( ( cat ) => {
                                const isSelected = filters.categoryIds.includes( cat.id );
                                return (
                                    <label
                                        key={ cat.id }
                                        style={ {
                                            display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer',
                                            padding: '5px 8px', borderRadius: '7px',
                                            background: isSelected ? 'var(--jr-p50, #eef2ff)' : 'transparent',
                                            border: isSelected ? '1px solid var(--jr-p200, #c7d2fe)' : '1px solid transparent',
                                            transition: 'background 0.15s, border-color 0.15s',
                                        } }
                                    >
                                        <input
                                            type="checkbox"
                                            checked={ isSelected }
                                            onChange={ () => toggleCategory( cat.id ) }
                                            style={ { accentColor: 'var(--jr-p600, #4f46e5)', width: '14px', height: '14px', flexShrink: 0 } }
                                        />
                                        <span style={ { fontSize: '13px', fontWeight: isSelected ? 600 : 400, color: isSelected ? 'var(--jr-p700, #3730a3)' : 'inherit' } }>
                                            { cat.name }
                                        </span>
                                    </label>
                                );
                            } ) }
                        </div>
                    </SidebarSection>
                ) }

                { /* Author multi-select */ }
                { settings.show_filter_author && authors.length > 0 && (
                    <SidebarSection title={ t( 'frontend.sidebarAuthor' ) }>
                        <div className="scrollbar-palette" style={ { display: 'flex', flexDirection: 'column', gap: '4px', maxHeight: '180px', overflowY: 'auto', paddingRight: '4px' } }>
                            { authors.map( ( a ) => {
                                const isSelected = filters.authorNames.includes( a.name );
                                return (
                                    <label
                                        key={ a.id }
                                        style={ {
                                            display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer',
                                            padding: '5px 8px', borderRadius: '7px',
                                            background: isSelected ? 'var(--jr-p50, #eef2ff)' : 'transparent',
                                            border: isSelected ? '1px solid var(--jr-p200, #c7d2fe)' : '1px solid transparent',
                                            transition: 'background 0.15s, border-color 0.15s',
                                        } }
                                    >
                                        <input
                                            type="checkbox"
                                            checked={ isSelected }
                                            onChange={ () => toggleAuthorName( a.name ) }
                                            style={ { accentColor: 'var(--jr-p600, #4f46e5)', width: '14px', height: '14px', flexShrink: 0 } }
                                        />
                                        <span style={ { fontSize: '13px', fontWeight: isSelected ? 600 : 400, color: isSelected ? 'var(--jr-p700, #3730a3)' : 'inherit' } }>
                                            { a.name }
                                        </span>
                                    </label>
                                );
                            } ) }
                        </div>
                    </SidebarSection>
                ) }

                { /* Publisher multi-select */ }
                { settings.show_filter_publisher && publishers.length > 0 && (
                    <SidebarSection title={ t( 'frontend.sidebarPublisher' ) }>
                        <div className="scrollbar-palette" style={ { display: 'flex', flexDirection: 'column', gap: '4px', maxHeight: '180px', overflowY: 'auto', paddingRight: '4px' } }>
                            { publishers.map( ( p ) => {
                                const isSelected = filters.publisherNames.includes( p.name );
                                return (
                                    <label
                                        key={ p.id }
                                        style={ {
                                            display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer',
                                            padding: '5px 8px', borderRadius: '7px',
                                            background: isSelected ? 'var(--jr-p50, #eef2ff)' : 'transparent',
                                            border: isSelected ? '1px solid var(--jr-p200, #c7d2fe)' : '1px solid transparent',
                                            transition: 'background 0.15s, border-color 0.15s',
                                        } }
                                    >
                                        <input
                                            type="checkbox"
                                            checked={ isSelected }
                                            onChange={ () => togglePublisherName( p.name ) }
                                            style={ { accentColor: 'var(--jr-p600, #4f46e5)', width: '14px', height: '14px', flexShrink: 0 } }
                                        />
                                        <span style={ { fontSize: '13px', fontWeight: isSelected ? 600 : 400, color: isSelected ? 'var(--jr-p700, #3730a3)' : 'inherit' } }>
                                            { p.name }
                                        </span>
                                    </label>
                                );
                            } ) }
                        </div>
                    </SidebarSection>
                ) }

                { /* Translator filter (text input — manually entered) */ }
                { settings.show_filter_translator && (
                    <SidebarSection title={ t( 'frontend.sidebarTranslator' ) } defaultOpen={ false }>
                        <input
                            type="text"
                            placeholder={ t( 'frontend.translatorPlaceholder' ) }
                            value={ filters.translator }
                            onChange={ ( e ) => onFilterChange( { translator: e.target.value } ) }
                            style={ inputStyle }
                        />
                    </SidebarSection>
                ) }

                { settings.show_filter_language && (
                    <SidebarSection title={ t( 'frontend.sidebarLanguage' ) } defaultOpen={ false }>
                        <LangCombobox
                            value={ filters.language }
                            onChange={ ( code ) => onFilterChange( { language: code } ) }
                            uiLocale={ locale }
                            placeholder={ t( 'frontend.allLanguages' ) }
                            searchPlaceholder={ t( 'itemForm.languageSearchPlaceholder' ) || '🔍' }
                        />
                    </SidebarSection>
                ) }

                { /* Year range filter */ }
                { settings.show_filter_year && (
                    <SidebarSection title={ t( 'frontend.sidebarYear' ) } defaultOpen={ false }>
                        <div style={ { display: 'flex', alignItems: 'center', gap: '6px' } }>
                            <input
                                type="number"
                                placeholder={ t( 'frontend.yearFrom' ) }
                                value={ filters.yearFrom }
                                onChange={ ( e ) => onFilterChange( { yearFrom: e.target.value } ) }
                                min={ 1000 }
                                max={ new Date().getFullYear() }
                                className="jr-filter-year-input"
                                style={ { width: 0, flex: 1 } }
                            />
                            <span style={ { fontSize: '12px', color: '#9ca3af', flexShrink: 0 } }>–</span>
                            <input
                                type="number"
                                placeholder={ t( 'frontend.yearTo' ) }
                                value={ filters.yearTo }
                                onChange={ ( e ) => onFilterChange( { yearTo: e.target.value } ) }
                                min={ 1000 }
                                max={ new Date().getFullYear() }
                                className="jr-filter-year-input"
                                style={ { width: 0, flex: 1 } }
                            />
                        </div>
                    </SidebarSection>
                ) }

                { /* Featured filter */ }
                { settings.show_filter_featured && (
                    <SidebarSection title={ t( 'frontend.sidebarFeatured' ) } defaultOpen={ false }>
                        <label style={ { display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer', fontSize: '13px' } }>
                            <input
                                type="checkbox"
                                checked={ filters.featured }
                                onChange={ ( e ) => onFilterChange( { featured: e.target.checked } ) }
                                style={ { accentColor: 'var(--jr-p600, #4f46e5)', width: '14px', height: '14px' } }
                            />
                            { t( 'frontend.featuredOnly' ) }
                        </label>
                    </SidebarSection>
                ) }
            </div>
        </div>
    );
};

/* ------------------------------------------------------------------ */
/*  Active filter chips                                               */
/* ------------------------------------------------------------------ */

const ActiveFilterChips: React.FC<{
    filters: ActiveFilters;
    categories: Category[];
    onRemove: ( key: keyof ActiveFilters ) => void;
    onRemoveCategoryId: ( id: number ) => void;
    onRemoveAuthorName: ( name: string ) => void;
    onRemovePublisherName: ( name: string ) => void;
}> = ( { filters, categories, onRemove, onRemoveCategoryId, onRemoveAuthorName, onRemovePublisherName } ) => {
    const { t, locale } = useTranslation();

    const chipStyle: React.CSSProperties = {
        display: 'inline-flex', alignItems: 'center', gap: '4px',
        background: 'var(--jr-p50, #eef2ff)', color: 'var(--jr-p700, #4338ca)',
        fontSize: '11px', padding: '3px 10px', borderRadius: '999px',
        border: '1px solid var(--jr-p200, #c7d2fe)',
    };
    const btnStyle: React.CSSProperties = {
        border: 'none', background: 'none', cursor: 'pointer',
        color: 'var(--jr-p400, #818cf8)', fontSize: '11px', lineHeight: 1,
        padding: '0 0 0 2px',
    };

    const chips: { label: string; onDismiss: () => void }[] = [];

    filters.categoryIds.forEach( ( id ) => {
        const cat = categories.find( ( c ) => c.id === id );
        chips.push( {
            label: `${ t( 'frontend.filterChipCategory' ) } ${ cat?.name ?? id }`,
            onDismiss: () => onRemoveCategoryId( id ),
        } );
    } );
    if ( filters.language ) chips.push( { label: `${ t( 'frontend.filterChipLang' ) } ${ getLangDisplayName( filters.language, locale ) }`, onDismiss: () => onRemove( 'language' ) } );
    if ( filters.yearFrom ) chips.push( { label: `${ t( 'frontend.filterChipFrom' ) } ${ filters.yearFrom }`, onDismiss: () => onRemove( 'yearFrom' ) } );
    if ( filters.yearTo )   chips.push( { label: `${ t( 'frontend.filterChipTo' ) } ${ filters.yearTo }`,     onDismiss: () => onRemove( 'yearTo' ) } );
    filters.authorNames.forEach( ( name ) =>
        chips.push( { label: `${ t( 'frontend.filterChipAuthor' ) } ${ name }`, onDismiss: () => onRemoveAuthorName( name ) } )
    );
    filters.publisherNames.forEach( ( name ) =>
        chips.push( { label: `${ t( 'frontend.filterChipPublisher' ) || 'Publisher:' } ${ name }`, onDismiss: () => onRemovePublisherName( name ) } )
    );
    if ( filters.translator )  chips.push( { label: `${ t( 'frontend.filterChipTranslator' ) || 'Translator:' } ${ filters.translator }`, onDismiss: () => onRemove( 'translator' ) } );
    if ( filters.featured ) chips.push( { label: t( 'frontend.filterChipFeatured' ), onDismiss: () => onRemove( 'featured' ) } );

    if ( chips.length === 0 ) return null;

    return (
        <div style={ { display: 'flex', flexWrap: 'wrap', gap: '6px', marginBottom: '16px' } }>
            { chips.map( ( chip, i ) => (
                <span key={ i } style={ chipStyle }>
                    { chip.label }
                    <button style={ btnStyle } onClick={ chip.onDismiss }>✕</button>
                </span>
            ) ) }
        </div>
    );
};

/* ------------------------------------------------------------------ */
/*  Item card                                                         */
/* ------------------------------------------------------------------ */

const ItemCard: React.FC<{
    item: LibraryItem;
    onRead: () => void;
    onInfo: () => void;
    imageSize?: string;
    imageFit?:  string;
    showReadButton?: boolean;
    showInfoButton?: boolean;
    showCardImage?: boolean;
    showCardTitle?: boolean;
    showCardAuthor?: boolean;
    showCardTranslator?: boolean;
    showCardPublisher?: boolean;
    showCardYear?: boolean;
    showCardType?: boolean;
    showCardLanguage?: boolean;
    showCardPageCount?: boolean;
    cardRadius?: string;
    cardBorder?: string;
    cardShadow?: string;
    cardHover?: string;
    cardAlign?: string;
    cardLayout?: string;
}> = ( {
    item, onRead, onInfo,
    imageSize = 'large', imageFit = 'cover',
    showReadButton = true, showInfoButton = true,
    showCardImage = true, showCardTitle = true,
    showCardAuthor = true, showCardTranslator = false,
    showCardPublisher = false, showCardYear = true, showCardType = true,
    showCardLanguage = false, showCardPageCount = true,
    cardRadius = 'medium', cardBorder = 'subtle', cardShadow = 'subtle',
    cardHover = 'zoom', cardAlign = 'left', cardLayout = 'vertical',
} ) => {
    const { t, locale } = useTranslation();
    const isQA    = item.type === 'qa';
    const hasFile = !! item.file_path;
    const typeIcon = { book: '📖', article: '📄', magazine: '🗞️', qa: '💬' }[ item.type ] ?? '📖';
    const coverH   = CARD_SIZE[ imageSize ] ?? 'h-52';
    const fitClass   = imageFit === 'contain' ? 'object-contain' : imageFit === 'fill' ? 'object-fill' : 'object-cover';
    const scaleClass = imageFit === 'cover' ? 'group-hover:scale-[1.03] transition-transform duration-500 ease-out' : '';
 
    // Collect visible meta badges
    const metaBadges: { label: string; key: string }[] = [];
    if ( showCardType && item.file_type ) {
        metaBadges.push( { label: item.file_type.toUpperCase(), key: 'format' } );
    }
    if ( showCardYear && item.publication_year > 0 ) {
        metaBadges.push( { label: String( item.publication_year ), key: 'year' } );
    }
    if ( showCardLanguage && item.language ) {
        metaBadges.push( { label: getLangDisplayName( item.language, locale ), key: 'lang' } );
    }
    if ( showCardPageCount && item.page_count && item.page_count > 0 ) {
        metaBadges.push( { label: `${ item.page_count } ${ t( 'reader.pages' ) }`, key: 'page_count' } );
    }
    if ( item.volumes && item.volumes.length > 1 ) {
        metaBadges.push( { label: `${ item.volumes.length } ${ item.type === 'magazine' ? t( 'frontend.volumeMagazine' ) : t( 'frontend.volumeBook' ) }`, key: 'volumes' } );
    }
    const hasSubtitleLine = showCardPublisher && item.publisher || showCardTranslator && item.translator;
    const hasReadingTime  = item.reading_time > 0;

    const prefetchRef = React.useRef<NodeJS.Timeout | null>( null );

    const handleMouseEnter = () => {
        if ( hasFile && ! isQA && item.file_path.trim() !== '' ) {
            prefetchRef.current = setTimeout( () => {
                import( '../reader/ReaderEngine' ).then( ( { ReaderEngine } ) => {
                    ReaderEngine.prefetchBook( item.file_path, ( item.file_type || '' ).toLowerCase() as ReaderFormat, item.metadata?.encoding );
                } ).catch( () => {} );
            }, 1000 );
        }
    };

    const handleMouseLeave = () => {
        if ( prefetchRef.current ) {
            clearTimeout( prefetchRef.current );
            prefetchRef.current = null;
        }
    };

    useEffect( () => {
        return () => {
            if ( prefetchRef.current ) clearTimeout( prefetchRef.current );
        };
    }, [] );

    // Navigate to CPT permalink if available; fall back to modal.
    const handleRead = () => {
        if ( item.cpt_url ) {
            window.location.href = item.cpt_url;
        } else {
            onRead();
        }
    };

    const radiusClass = `jr-radius-${ cardRadius }`;
    const borderClass = `jr-border-${ cardBorder }`;
    const shadowClass = `jr-shadow-${ cardShadow }`;
    const hoverClass  = `jr-hover-${ cardHover }`;
    const alignClass  = `jr-align-${ cardAlign }`;
    const layoutClass = cardLayout === 'horizontal' ? 'flex flex-row items-stretch' : 'flex flex-col';

    const isHorizontal = cardLayout === 'horizontal';
    const coverW = imageSize === 'small' ? 'w-20 min-w-[80px]' : imageSize === 'medium' ? 'w-28 min-w-[112px]' : imageSize === 'xlarge' ? 'w-48 min-w-[192px]' : imageSize === 'xxlarge' ? 'w-56 min-w-[224px]' : 'w-36 min-w-[144px]';

    return (
        <motion.div
            layout
            initial={ { opacity: 0, y: 16 } }
            animate={ { opacity: 1, y: 0 } }
            exit={ { opacity: 0, scale: 0.96 } }
            transition={ { duration: 0.22 } }
            className={ `jr-card group h-full transition-all duration-300 ${ layoutClass } ${ radiusClass } ${ borderClass } ${ shadowClass } ${ hoverClass } ${ alignClass }`.replace(/\s+/g, ' ').trim() }
            onMouseEnter={ handleMouseEnter }
            onMouseLeave={ handleMouseLeave }
        >
            { /* ── Cover / Image Section ── */ }
            { showCardImage && (
                isQA ? (
                    <div className={ `${ isHorizontal ? `${ coverW } h-auto min-h-full` : 'h-24' } bg-gradient-to-br from-amber-400 to-orange-500 flex items-center justify-center shrink-0 relative overflow-hidden` }>
                        <span className="text-3xl opacity-80">💬</span>
                        { item.featured && (
                            <span className="absolute top-1.5 right-1.5 bg-yellow-400/90 backdrop-blur-sm text-yellow-900 text-[10px] font-bold px-2 py-0.5 rounded-full shadow-sm flex items-center gap-0.5">
                                ⭐
                            </span>
                        ) }
                    </div>
                ) : (
                    <div className={ `relative ${ isHorizontal ? `${ coverW } h-auto min-h-full` : coverH } bg-gradient-to-br from-slate-100 to-slate-200 dark:from-slate-800 dark:to-slate-700 overflow-hidden flex items-center justify-center shrink-0` }>
                        { item.cover_image ? (
                            <img
                                src={ item.cover_image }
                                alt={ item.title }
                                loading="lazy"
                                className={ `w-full h-full ${ fitClass } ${ scaleClass }`.trim() }
                            />
                        ) : (
                            <div className="text-slate-400 dark:text-slate-300 text-center p-3 select-none">
                                <span className="text-4xl opacity-60">{ typeIcon }</span>
                                <p className="mt-1.5 text-[11px] font-medium line-clamp-2 opacity-70">{ item.title }</p>
                            </div>
                        ) }
                        { /* Overlay on hover */ }
                        <div className="absolute inset-0 bg-gradient-to-t from-black/5 to-transparent opacity-0 group-hover:opacity-100 transition-opacity duration-300 pointer-events-none" />
                        { /* Top type badge */ }
                        { showCardType && (
                            <div className="absolute top-2 left-2">
                                <span className="bg-white/90 dark:bg-black/60 backdrop-blur-sm text-slate-700 dark:text-slate-200 text-[10px] font-semibold px-2 py-0.5 rounded-full shadow-sm flex items-center gap-1">
                                    <span className="text-[11px] leading-none">{ typeIcon }</span>
                                </span>
                            </div>
                        ) }
                        { item.featured && (
                            <span className="absolute top-2 right-2 bg-yellow-400/90 backdrop-blur-sm text-yellow-900 text-[10px] font-bold px-2 py-0.5 rounded-full shadow-sm flex items-center gap-0.5">
                                ⭐
                            </span>
                        ) }
                    </div>
                )
            ) }

            { /* ── Card Body ── */ }
            <div className="p-3.5 flex flex-col gap-2 flex-1 bg-transparent min-w-0">
                { /* Type badge if image hidden */ }
                { showCardType && ! showCardImage && (
                    <div className={ `flex items-center gap-1.5 ${ cardAlign === 'center' ? 'justify-center' : '' }` }>
                        <span className="text-[10px] bg-primary-100 dark:bg-primary-900/50 text-primary-700 dark:text-primary-300 px-2 py-0.5 rounded-full font-semibold uppercase tracking-wide flex items-center gap-1">
                            <span className="text-[11px] leading-none">{ typeIcon }</span>
                            <span>{ item.type }</span>
                        </span>
                        { item.featured && (
                            <span className="text-[10px] bg-yellow-100 dark:bg-yellow-900/50 text-yellow-700 dark:text-yellow-300 px-1.5 py-0.5 rounded-full font-medium">⭐</span>
                        ) }
                    </div>
                ) }

                { /* Title */ }
                { showCardTitle && (
                    <h3 className={ `font-bold text-gray-900 dark:text-white line-clamp-2 text-[14px] leading-tight tracking-tight ${ cardAlign === 'center' ? 'text-center' : '' }` }>
                        { item.title }
                    </h3>
                ) }

                { /* Author */ }
                { showCardAuthor && item.author && (
                    <p className={ `text-[12px] text-gray-500 dark:text-gray-400 truncate flex items-center gap-1 ${ cardAlign === 'center' ? 'justify-center' : '' }` }>
                        <svg className="w-3 h-3 shrink-0 text-gray-400 dark:text-gray-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2">
                            <path strokeLinecap="round" strokeLinejoin="round" d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z" />
                        </svg>
                        <span className="truncate">{ item.author }</span>
                    </p>
                ) }

                { /* Publisher + Translator combo */ }
                { hasSubtitleLine && (
                    <p className={ `text-[11px] text-gray-400 dark:text-gray-500 truncate flex items-center gap-1.5 flex-wrap ${ cardAlign === 'center' ? 'justify-center' : '' }` }>
                        { showCardPublisher && item.publisher && (
                            <span className="truncate italic flex items-center gap-0.5">
                                <svg className="w-2.5 h-2.5 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2">
                                    <path strokeLinecap="round" strokeLinejoin="round" d="M19 21V5a2 2 0 00-2-2H7a2 2 0 00-2 2v16m14 0h2m-2 0h-5m-9 0H3m2 0h5M9 7h1m-1 4h1m4-4h1m-1 4h1m-5 10v-5a1 1 0 011-1h2a1 1 0 011 1v5m-4 0h4" />
                                </svg>
                                { item.publisher }
                            </span>
                        ) }
                        { showCardPublisher && item.publisher && showCardTranslator && item.translator && (
                            <span className="text-gray-300 dark:text-gray-600 select-none">·</span>
                        ) }
                        { showCardTranslator && item.translator && (
                            <span className="truncate flex items-center gap-0.5">
                                <svg className="w-2.5 h-2.5 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2">
                                    <path strokeLinecap="round" strokeLinejoin="round" d="M3 5h12M9 3v2m1.048 9.5A18.022 18.022 0 016.412 9m6.088 9h7M11 21l5-10 5 10M12.751 5C11.783 10.77 8.07 15.61 3 18.129" />
                                </svg>
                                { item.translator }
                            </span>
                        ) }
                    </p>
                ) }

                { /* Meta Badges Row */ }
                { metaBadges.length > 0 && (
                    <div className={ `flex items-center gap-1.5 flex-wrap ${ cardAlign === 'center' ? 'justify-center' : '' }` }>
                        { metaBadges.map( ( b ) => (
                            <span
                                key={ b.key }
                                className={ `
                                    text-[10px] font-semibold px-1.5 py-0.5 rounded-md
                                    ${ b.key === 'format'
                                        ? 'bg-blue-50 dark:bg-blue-950/40 text-blue-600 dark:text-blue-400 border border-blue-200 dark:border-blue-800/50'
                                        : b.key === 'year'
                                        ? 'bg-amber-50 dark:bg-amber-950/40 text-amber-700 dark:text-amber-400 border border-amber-200 dark:border-amber-800/50'
                                        : b.key === 'lang'
                                        ? 'bg-emerald-50 dark:bg-emerald-950/40 text-emerald-600 dark:text-emerald-400 border border-emerald-200 dark:border-emerald-800/50'
                                        : 'bg-purple-50 dark:bg-purple-950/40 text-purple-600 dark:text-purple-400 border border-purple-200 dark:border-purple-800/50'
                                    }
                                `.replace(/\s+/g, ' ').trim() }
                            >
                                { b.label }
                            </span>
                        ) ) }
                        { hasReadingTime && (
                            <span className={ `text-[10px] font-medium text-gray-400 dark:text-gray-500 flex items-center gap-0.5 ${ cardAlign === 'center' ? '' : 'ml-auto' }` }>
                                <svg className="w-2.5 h-2.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2">
                                    <path strokeLinecap="round" strokeLinejoin="round" d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
                                </svg>
                                { item.reading_time }m
                            </span>
                        ) }
                    </div>
                ) }

                { /* QA description */ }
                { isQA && item.description && (
                    <p className={ `text-[11px] text-gray-500 dark:text-gray-400 line-clamp-2 leading-relaxed mt-0.5 ${ cardAlign === 'center' ? 'text-center' : '' }` }>
                        { item.description }
                    </p>
                ) }

                { /* Spacer */ }
                <div className="flex-1 min-h-0" />

                { /* Action Buttons */ }
                { ( showReadButton || showInfoButton ) && (
                    <div className={ `flex gap-1.5 mt-1 ${ cardAlign === 'center' ? 'justify-center w-full' : '' }` }>
                        { showReadButton && hasFile && ! isQA && item.file_path.trim() !== '' && (
                            <button
                                onClick={ handleRead }
                                className="jrc-btn-read flex-1 inline-flex items-center justify-center gap-1 text-xs font-semibold py-2 px-3 rounded-xl transition-all duration-200 active:scale-95"
                                style={ {
                                    background: 'var(--jr-p600, #4f46e5)',
                                    color: '#fff',
                                    boxShadow: '0 1px 3px rgba(0,0,0,0.08)',
                                } }
                                onMouseEnter={ ( e ) => {
                                    e.currentTarget.style.background = 'var(--jr-p700, #4338ca)';
                                    e.currentTarget.style.boxShadow = '0 4px 14px rgba(99,102,241,0.35)';
                                } }
                                onMouseLeave={ ( e ) => {
                                    e.currentTarget.style.background = 'var(--jr-p600, #4f46e5)';
                                    e.currentTarget.style.boxShadow = '0 1px 3px rgba(0,0,0,0.08)';
                                } }
                            >
                                <svg className="w-3.5 h-3.5 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2">
                                    <path strokeLinecap="round" strokeLinejoin="round" d="M12 6.253v13m0-13C10.832 5.477 9.246 5 7.5 5S4.168 5.477 3 6.253v13C4.168 18.477 5.754 18 7.5 18s3.332.477 4.5 1.253m0-13C13.168 5.477 14.754 5 16.5 5c1.747 0 3.332.477 4.5 1.253v13C19.832 18.477 18.247 18 16.5 18c-1.746 0-3.332.477-4.5 1.253" />
                                </svg>
                                { isQA ? t( 'frontend.cardView' ) : t( 'frontend.cardRead' ) }
                            </button>
                        ) }
                        { showInfoButton && (
                            <button
                                onClick={ onInfo }
                                className="jrc-btn-info flex-1 inline-flex items-center justify-center gap-1 text-xs font-semibold py-2 px-3 rounded-xl transition-all duration-200 active:scale-95"
                                style={ {
                                    background: 'transparent',
                                    color: 'var(--jr-p600, #4f46e5)',
                                    border: '1.5px solid var(--jr-p200, #c7d2fe)',
                                } }
                                onMouseEnter={ ( e ) => {
                                    e.currentTarget.style.background = 'var(--jr-p50, #eef2ff)';
                                    e.currentTarget.style.borderColor = 'var(--jr-p200, #c7d2fe)';
                                } }
                                onMouseLeave={ ( e ) => {
                                    e.currentTarget.style.background = 'transparent';
                                    e.currentTarget.style.borderColor = 'var(--jr-p200, #c7d2fe)';
                                } }
                            >
                                <svg className="w-3.5 h-3.5 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2">
                                    <path strokeLinecap="round" strokeLinejoin="round" d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                                </svg>
                                { isQA ? t( 'frontend.cardView' ) : t( 'frontend.cardInfo' ) }
                            </button>
                        ) }
                    </div>
                ) }
            </div>
        </motion.div>
    );
};

/* ------------------------------------------------------------------ */
/*  Skeleton                                                           */
/* ------------------------------------------------------------------ */

const SkeletonGrid: React.FC<{ cols: number; cardMinWidth?: number }> = ( { cols, cardMinWidth = 180 } ) => {
    const gridStyle: React.CSSProperties = {
        display: 'grid',
        gridTemplateColumns: `repeat(auto-fill, minmax(${ cardMinWidth }px, 1fr))`,
        gap: '1.25rem',
    };
    return (
    <div style={ gridStyle }>
        { Array.from( { length: cols * 2 } ).map( ( _, i ) => (
            <div key={ i } className="jr-card overflow-hidden">
                <div className="jr-skeleton h-44 w-full" />
                <div className="p-4 space-y-2">
                    <div className="jr-skeleton h-3.5 w-3/4" />
                    <div className="jr-skeleton h-3 w-1/2" />
                    <div className="jr-skeleton h-8 w-full mt-3 rounded-lg" />
                </div>
            </div>
        ) ) }
    </div>
    );
};

/* ------------------------------------------------------------------ */
/*  Info modal                                                         */
/* ------------------------------------------------------------------ */

const TYPE_EMOJI: Record<string, string> = { book: '📚', article: '📄', magazine: '🗞️', qa: '💬' };

const InfoModal: React.FC<{
    item: LibraryItem;
    onClose: () => void;
    onRead: ( selectedVolumeIdx?: number ) => void;
    showReadButton?: boolean;
    downloadEnabled?: boolean;
    settings?: PublicSettings;
}> = ( { item, onClose, onRead, showReadButton = true, downloadEnabled = false, settings } ) => {
    const { t, locale } = useTranslation();
    const [ selectedVolIdx, setSelectedVolIdx ] = React.useState<number | null>( null );

    // Fire-and-forget view ping — no await, no UI impact, keepalive ensures
    // delivery even if the user closes the modal immediately.
    React.useEffect( () => {
        const nonce = getNonce();
        const headers: Record<string, string> = {};
        if ( nonce ) {
            headers['X-WP-Nonce'] = nonce;
        }
        fetch( `${ API_BASE }/items/${ item.id }/view`, {
            method: 'POST',
            headers,
            keepalive: true,
        } ).catch( () => {} );
    }, [] ); // eslint-disable-line react-hooks/exhaustive-deps

    React.useEffect( () => {
        if ( item.file_path && item.type !== 'qa' && item.file_path.trim() !== '' ) {
            import( '../reader/ReaderEngine' ).then( ( { ReaderEngine } ) => {
                ReaderEngine.prefetchBook( item.file_path, ( item.file_type || '' ).toLowerCase() as ReaderFormat, item.metadata?.encoding );
            } ).catch( () => {} );
        }
    }, [ item.file_path, item.file_type, item.type ] );

    const isMultiVol = !! ( item.volumes && item.volumes.length > 1 );

    const handleRead = () => {
        const volIdx = item.volumes && item.volumes.length > 0
            ? ( selectedVolIdx !== null ? selectedVolIdx : 0 )
            : -1;
        const volParam = volIdx >= 0 ? `#volume=${ volIdx + 1 }` : '';
        if ( item.cpt_url ) {
            window.location.href = item.cpt_url + volParam;
        } else {
            onRead( volIdx >= 0 ? volIdx : undefined );
        }
    };

    const metaFields = ( [
        settings?.show_detail_year !== false ? [ t( 'frontend.infoModalYear' ),      item.publication_year > 0 ? String( item.publication_year ) : null ] : null,
        settings?.show_detail_type !== false ? [ t( 'frontend.infoModalFormat' ),     item.file_type ? item.file_type.toUpperCase() : null ] : null,
        settings?.show_detail_language !== false ? [ t( 'frontend.infoModalLanguage' ),   item.language ? getLangDisplayName( item.language, locale ) : null ] : null,
        settings?.show_detail_publisher !== false ? [ t( 'frontend.infoModalPublisher' ),  item.publisher || null ] : null,
        settings?.show_detail_page_count !== false ? [ t( 'frontend.infoModalPages' ),  item.page_count && item.page_count > 0 ? `${ item.page_count } ${ t( 'reader.pages' ) }` : null ] : null,
        item.volumes && item.volumes.length > 1
            ? [ t( 'frontend.infoModalVolumes' ), `${ item.volumes.length } ${ t( 'frontend.infoModalVolumesCount' ) }` ]
            : null,
    ] as ( [ string, string | null ] | null )[] )
        .filter( ( p ): p is [ string, string ] => !! p && !! p[1] );

    const hasFile    = !! item.file_path;
    const showDl     = downloadEnabled && ( isMultiVol ? ( selectedVolIdx !== null && !! item.volumes?.[selectedVolIdx]?.file_path ) : hasFile );
    const dlHref     = isMultiVol && selectedVolIdx !== null ? ( item.volumes?.[selectedVolIdx]?.file_path ?? '' ) : item.file_path;
    const hasActions = ( showReadButton && hasFile ) || downloadEnabled;

    return (
        <motion.div
            initial={ { opacity: 0 } } animate={ { opacity: 1 } } exit={ { opacity: 0 } }
            className="fixed inset-0 z-[9999] flex items-center justify-center p-3 sm:p-6"
            style={ { backgroundColor: 'rgba(0,0,0,0.72)', backdropFilter: 'blur(4px)' } }
            onClick={ onClose }
        >
            <motion.div
                initial={ { scale: 0.94, opacity: 0, y: 24 } }
                animate={ { scale: 1, opacity: 1, y: 0 } }
                exit={ { scale: 0.94, opacity: 0, y: 24 } }
                transition={ { type: 'spring', stiffness: 340, damping: 30 } }
                className="jr-info-modal"
                style={ {
                    position: 'relative',
                    background: 'var(--jr-modal-bg, #fff)',
                    borderRadius: '20px',
                    boxShadow: '0 24px 60px rgba(0,0,0,0.22), 0 4px 16px rgba(0,0,0,0.12)',
                    width: '100%',
                    maxWidth: '980px',
                    maxHeight: '90vh',
                    display: 'flex',
                    flexDirection: 'column',
                    overflow: 'hidden',
                } }
                onClick={ ( e ) => e.stopPropagation() }
            >
                { /* ── Close button (always top-right) ── */ }
                <button
                    onClick={ onClose }
                    aria-label="Close"
                    style={ {
                        position: 'absolute',
                        top: '14px',
                        right: '14px',
                        zIndex: 10,
                        width: '32px',
                        height: '32px',
                        borderRadius: '50%',
                        border: 'none',
                        background: 'rgba(0,0,0,0.12)',
                        color: '#fff',
                        cursor: 'pointer',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        fontSize: '14px',
                        lineHeight: 1,
                        transition: 'background 0.15s',
                    } }
                    onMouseEnter={ ( e ) => ( e.currentTarget.style.background = 'rgba(0,0,0,0.28)' ) }
                    onMouseLeave={ ( e ) => ( e.currentTarget.style.background = 'rgba(0,0,0,0.12)' ) }
                >✕</button>

                { /* ── Body: image + content ── */ }
                <div style={ { display: 'flex', flexDirection: 'row', flex: 1, minHeight: 0, overflow: 'hidden' } }
                     className="jr-info-body">

                    { /* ── Left: Cover image ── */ }
                    { settings?.show_detail_image !== false && (
                        <div style={ {
                            width: '390px',
                            minWidth: '390px',
                            flexShrink: 0,
                            position: 'relative',
                            overflow: 'hidden',
                            background: 'linear-gradient(135deg, #1e293b 0%, #334155 100%)',
                            borderRadius: '20px 0 0 20px',
                        } } className="jr-info-cover">
                            { item.cover_image ? (
                                <img
                                    src={ item.cover_image }
                                    alt={ item.title }
                                    style={ {
                                        width: '100%',
                                        height: '100%',
                                        objectFit: 'contain',
                                        objectPosition: 'center center',
                                        display: 'block',
                                    } }
                                />
                            ) : (
                                <div style={ {
                                    width: '100%',
                                    height: '100%',
                                    display: 'flex',
                                    flexDirection: 'column',
                                    alignItems: 'center',
                                    justifyContent: 'center',
                                    gap: '12px',
                                    minHeight: '320px',
                                } }>
                                    <span style={ { fontSize: '72px', lineHeight: 1 } }>{ TYPE_EMOJI[ item.type ] ?? '📄' }</span>
                                </div>
                            ) }
                        </div>
                    ) }

                    { /* ── Right: Info + description + actions ── */ }
                    <div style={ {
                        flex: 1,
                        minWidth: 0,
                        display: 'flex',
                        flexDirection: 'column',
                        overflow: 'hidden',
                    } }>
                        { /* Scrollable content area */ }
                        <div style={ {
                            flex: 1,
                            overflowY: 'auto',
                            padding: '32px 28px 24px 28px',
                        } } className="jr-info-scroll">

                            { /* Title */ }
                            { settings?.show_detail_title !== false && (
                                <h2 style={ {
                                    margin: '0 0 10px 0',
                                    fontSize: 'clamp(17px, 2.2vw, 22px)',
                                    fontWeight: 800,
                                    lineHeight: 1.25,
                                    color: 'var(--jr-modal-title, #0f172a)',
                                    letterSpacing: '-0.01em',
                                    paddingRight: '24px',
                                } }>{ item.title }</h2>
                            ) }

                            { /* Author + Translator */ }
                            { ( ( item.author && settings?.show_detail_author !== false ) || ( item.translator && settings?.show_detail_translator !== false ) ) && (
                                <div style={ { marginBottom: '20px', display: 'flex', flexDirection: 'column', gap: '4px' } }>
                                    { item.author && settings?.show_detail_author !== false && (
                                        <p style={ { margin: 0, fontSize: '14px', color: 'var(--jr-modal-meta, #64748b)', display: 'flex', alignItems: 'center', gap: '6px' } }>
                                            <span style={ { fontSize: '12px' } }>✍️</span>
                                            <span>{ t( 'frontend.infoModalBy' ) } <strong style={ { fontWeight: 600, color: 'var(--jr-modal-text, #334155)' } }>{ item.author }</strong></span>
                                        </p>
                                    ) }
                                    { item.translator && settings?.show_detail_translator !== false && (
                                        <p style={ { margin: 0, fontSize: '13px', color: 'var(--jr-modal-meta, #64748b)', display: 'flex', alignItems: 'center', gap: '6px' } }>
                                            <span style={ { fontSize: '12px' } }>🌐</span>
                                            <span>{ t( 'frontend.infoModalTranslator' ) }: <strong style={ { fontWeight: 600, color: 'var(--jr-modal-text, #334155)' } }>{ item.translator }</strong></span>
                                        </p>
                                    ) }
                                </div>
                            ) }

                            { /* Meta badges */ }
                            { metaFields.length > 0 && (
                                <div style={ {
                                    display: 'flex',
                                    flexWrap: 'wrap',
                                    gap: '8px',
                                    marginBottom: '20px',
                                } }>
                                    { metaFields.map( ( [ label, value ] ) => (
                                        <div key={ label } style={ {
                                            background: 'var(--jr-modal-badge-bg, #f1f5f9)',
                                            borderRadius: '8px',
                                            padding: '6px 12px',
                                            display: 'flex',
                                            flexDirection: 'column',
                                            gap: '1px',
                                            minWidth: '60px',
                                        } }>
                                            <span style={ { fontSize: '10px', fontWeight: 700, letterSpacing: '0.07em', textTransform: 'uppercase', color: 'var(--jr-modal-meta, #94a3b8)' } }>{ label }</span>
                                            <span style={ { fontSize: '13px', fontWeight: 700, color: 'var(--jr-modal-text, #1e293b)' } }>{ value }</span>
                                        </div>
                                    ) ) }
                                </div>
                            ) }

                            { /* Volumes list */ }
                            { item.volumes && item.volumes.length > 1 && (
                                <div style={ { marginBottom: '20px' } }>
                                    <p style={ { margin: '0 0 8px 0', fontSize: '11px', fontWeight: 700, letterSpacing: '0.07em', textTransform: 'uppercase', color: 'var(--jr-modal-meta, #94a3b8)', display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap' } }>
                                        <span>{ item.type === 'magazine' ? t( 'frontend.infoModalVolumesListMagazine' ) : t( 'frontend.infoModalVolumesListBook' ) }</span>
                                        { downloadEnabled && (
                                            <span style={ { fontSize: '11px', fontWeight: 500, letterSpacing: 0, textTransform: 'none', color: 'var(--jr-p400, #818cf8)' } }>
                                                { t( 'frontend.infoModalDownloadHint' ) }
                                            </span>
                                        ) }
                                    </p>
                                    <div style={ { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(140px, 1fr))', gap: '8px' } }>
                                        { item.volumes.map( ( vol, idx ) => {
                                            const isSelected = selectedVolIdx === idx;
                                            return (
                                                <div
                                                    key={ idx }
                                                    onClick={ () => setSelectedVolIdx( isSelected ? null : idx ) }
                                                    style={ {
                                                        background: isSelected ? 'var(--jr-p100, #e0e7ff)' : 'var(--jr-modal-badge-bg, #f1f5f9)',
                                                        border: isSelected ? '2px solid var(--jr-p400, #818cf8)' : '2px solid transparent',
                                                        borderRadius: '10px',
                                                        padding: '8px 12px',
                                                        display: 'flex',
                                                        alignItems: 'center',
                                                        gap: '8px',
                                                        fontSize: '12px',
                                                        fontWeight: 600,
                                                        color: isSelected ? 'var(--jr-p700, #4338ca)' : 'var(--jr-modal-text, #334155)',
                                                        cursor: 'pointer',
                                                        transition: 'background 0.15s, border-color 0.15s',
                                                    } }
                                                >
                                                    <span style={ { fontSize: '14px', flexShrink: 0 } }>{ item.type === 'magazine' ? '🗞️' : '📖' }</span>
                                                    <div style={ { display: 'flex', flexDirection: 'column', minWidth: 0, flex: 1, lineHeight: 1.25 } }>
                                                        <span style={ { whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' } }>
                                                            { item.type === 'magazine' ? `${ t( 'frontend.infoModalVolItemMagazine' ) } ${ idx + 1 }` : `${ t( 'frontend.infoModalVolItemBook' ) } ${ idx + 1 }` }
                                                        </span>
                                                        { vol.page_count && vol.page_count > 0 ? (
                                                            <span style={ { fontSize: '10px', fontWeight: 500, color: isSelected ? 'var(--jr-p600, #4f46e5)' : 'var(--jr-modal-meta, #94a3b8)', marginTop: '2px' } }>
                                                                { vol.page_count } { t( 'reader.pages' ) }
                                                            </span>
                                                        ) : null }
                                                    </div>
                                                    { vol.file_type && (
                                                        <span style={ {
                                                            fontSize: '10px',
                                                            fontWeight: 700,
                                                            color: isSelected ? 'var(--jr-p500, #6366f1)' : 'var(--jr-modal-meta, #94a3b8)',
                                                            textTransform: 'uppercase',
                                                            fontFamily: 'monospace',
                                                            flexShrink: 0,
                                                            marginLeft: '4px'
                                                        } }>
                                                            { vol.file_type }
                                                        </span>
                                                    ) }
                                                </div>
                                            );
                                        } ) }
                                    </div>
                                </div>
                            ) }

                            { /* Separator */ }
                            { item.description && ( metaFields.length > 0 || item.author || item.translator ) && (
                                <hr style={ { border: 'none', borderTop: '1px solid var(--jr-modal-divider, #e2e8f0)', margin: '0 0 16px 0' } } />
                            ) }

                            { /* Description — pre-line preserves paragraph/line breaks */ }
                            { item.description && (
                                <p style={ {
                                    margin: 0,
                                    fontSize: '14px',
                                    lineHeight: 1.72,
                                    color: 'var(--jr-modal-desc, #475569)',
                                    whiteSpace: 'pre-line',
                                } }>{ item.description }</p>
                            ) }
                        </div>

                        { /* ── Action bar ── */ }
                        <div style={ {
                            padding: '16px 28px 24px 28px',
                            borderTop: '1px solid var(--jr-modal-divider, #e2e8f0)',
                            display: 'flex',
                            gap: '10px',
                            flexWrap: 'wrap',
                            alignItems: 'center',
                        } }>
                            { showReadButton && hasFile && item.type !== 'qa' && item.file_path.trim() !== '' && (
                                <button
                                    onClick={ handleRead }
                                    className="jr-btn-primary"
                                    style={ { flex: '0 0 auto' } }
                                >{ t( 'frontend.infoModalReadNow' ) }</button>
                            ) }
                            { downloadEnabled && (
                                isMultiVol && selectedVolIdx === null ? (
                                    <button
                                        disabled
                                        className="jr-btn-secondary"
                                        style={ { flex: '0 0 auto', opacity: 0.4, cursor: 'not-allowed' } }
                                    >{ t( 'frontend.infoModalDownload' ) }</button>
                                ) : showDl ? (
                                    <a
                                        href={ dlHref }
                                        download
                                        target="_blank"
                                        rel="noopener noreferrer"
                                        className="jr-btn-secondary"
                                        style={ { flex: '0 0 auto', textDecoration: 'none', display: 'inline-flex', alignItems: 'center', justifyContent: 'center' } }
                                    >{ t( 'frontend.infoModalDownload' ) }</a>
                                ) : null
                            ) }
                            <button
                                onClick={ onClose }
                                className="jr-btn-secondary"
                                style={ { flex: '0 0 auto', marginLeft: 'auto' } }
                            >{ t( 'frontend.infoModalClose' ) }</button>
                        </div>
                    </div>
                </div>
            </motion.div>

            { /* ── Responsive: stack vertically on small screens ── */ }
            <style>{ `
                @media (max-width: 680px) {
                    .jr-info-body { flex-direction: column !important; }
                    .jr-info-cover {
                        width: 100% !important;
                        min-width: unset !important;
                        min-height: 260px !important;
                        border-radius: 20px 20px 0 0 !important;
                    }
                    .jr-info-scroll { padding: 20px 18px 16px !important; }
                }
                @media (prefers-color-scheme: dark) {
                    .jr-info-modal {
                        --jr-modal-bg: #1e293b;
                        --jr-modal-title: #f1f5f9;
                        --jr-modal-text: #cbd5e1;
                        --jr-modal-meta: #64748b;
                        --jr-modal-desc: #94a3b8;
                        --jr-modal-badge-bg: #0f172a;
                        --jr-modal-divider: #334155;
                    }
                }
                .dark .jr-info-modal {
                    --jr-modal-bg: #1e293b;
                    --jr-modal-title: #f1f5f9;
                    --jr-modal-text: #cbd5e1;
                    --jr-modal-meta: #64748b;
                    --jr-modal-desc: #94a3b8;
                    --jr-modal-badge-bg: #0f172a;
                    --jr-modal-divider: #334155;
                }
            ` }</style>
        </motion.div>
    );
};

/* ------------------------------------------------------------------ */
/*  Pagination                                                         */
/* ------------------------------------------------------------------ */

const Pagination: React.FC<{
    page: number;
    pages: number;
    total: number;
    perPage: number;
    onChange: ( p: number ) => void;
}> = ( { page, pages, total, perPage, onChange } ) => {
    const { t } = useTranslation();
    if ( pages <= 1 ) return null;

    const range: ( number | '…' )[] = [];
    for ( let i = 1; i <= pages; i++ ) {
        if ( i === 1 || i === pages || ( i >= page - 2 && i <= page + 2 ) ) {
            range.push( i );
        } else if ( range[ range.length - 1 ] !== '…' ) {
            range.push( '…' );
        }
    }

    return (
        <div className="flex flex-col sm:flex-row items-center justify-between gap-3 mt-8 pt-6 border-t border-gray-200 dark:border-gray-700">
            <p className="text-sm text-gray-500 dark:text-gray-400 order-2 sm:order-1">
                { ( page - 1 ) * perPage + 1 }–{ Math.min( page * perPage, total ) } { t( 'frontend.paginatedOf' ) } { total } { t( 'frontend.paginatedItems' ) }
            </p>
            <div className="flex items-center gap-1 order-1 sm:order-2">
                <button
                    onClick={ () => onChange( page - 1 ) }
                    disabled={ page <= 1 }
                    className="px-3 py-1.5 text-sm rounded-lg border border-gray-300 dark:border-gray-600 hover:bg-gray-100 dark:hover:bg-gray-700 disabled:opacity-40 disabled:cursor-not-allowed transition-colors bg-white dark:bg-gray-800 text-gray-700 dark:text-gray-300"
                >
                    ‹
                </button>
                { range.map( ( r, i ) =>
                    r === '…'
                        ? <span key={ `e${i}` } className="px-2 text-gray-400 text-sm">…</span>
                        : (
                            <button
                                key={ r }
                                onClick={ () => onChange( r as number ) }
                                className={ `min-w-[2.25rem] px-2 py-1.5 text-sm rounded-lg border transition-colors ${
                                    r === page
                                        ? 'bg-primary-600 text-white border-primary-600 font-medium'
                                        : 'border-gray-300 dark:border-gray-600 hover:bg-gray-100 dark:hover:bg-gray-700 bg-white dark:bg-gray-800 text-gray-700 dark:text-gray-300'
                                }` }
                            >
                                { r }
                            </button>
                        )
                ) }
                <button
                    onClick={ () => onChange( page + 1 ) }
                    disabled={ page >= pages }
                    className="px-3 py-1.5 text-sm rounded-lg border border-gray-300 dark:border-gray-600 hover:bg-gray-100 dark:hover:bg-gray-700 disabled:opacity-40 disabled:cursor-not-allowed transition-colors bg-white dark:bg-gray-800 text-gray-700 dark:text-gray-300"
                >
                    ›
                </button>
            </div>
        </div>
    );
};

/* ------------------------------------------------------------------ */
/*  Main library content                                               */
/* ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ */
/*  Content-search results list                                        */
/* ------------------------------------------------------------------ */

const TYPE_ICONS: Record<string, string> = {
    book: '📚', article: '📄', magazine: '🗞️', qa: '💬',
};

const ContentSearchResultList: React.FC<{ searchTerm: string }> = ( { searchTerm } ) => {
    const { t, locale }        = useTranslation();
    const { data, isLoading }  = useContentSearch( searchTerm );
    const results              = data?.results ?? [];
    const [ selectedTab, setSelectedTab ] = React.useState<string>( '' );

    if ( isLoading ) {
        return (
            <div className="py-16 flex flex-col items-center gap-3">
                <div className="w-8 h-8 border-2 border-primary-500 border-t-transparent rounded-full animate-spin" />
                <p className="text-sm text-gray-400 dark:text-gray-500">{ t( 'search.searching' ) }</p>
            </div>
        );
    }

    if ( results.length === 0 ) {
        return (
            <div className="text-center py-16">
                <svg xmlns="http://www.w3.org/2000/svg" width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className="mx-auto text-gray-300 dark:text-gray-600 mb-3" aria-hidden="true"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
                <p className="text-gray-500 dark:text-gray-400 text-sm">
                    { t( 'frontend.emptyNoResults' ) } &ldquo;{ searchTerm }&rdquo;
                </p>
            </div>
        );
    }

    const isTr = locale?.startsWith( 'tr' );
    const titleLabel = t( 'search.titleResults' ) || ( isTr ? 'Kitaplar & Belgeler' : 'Books & Documents' );
    const authorLabel = t( 'search.authorResults' ) || t( 'frontend.sidebarAuthor' ) || ( isTr ? 'Yazarlar' : 'Authors' );
    const publisherLabel = t( 'search.publisherResults' ) || t( 'frontend.sidebarPublisher' ) || ( isTr ? 'Yayınevleri' : 'Publishers' );

    const contentResults   = results.filter( ( r ) => r.match_type === 'content' );
    const titleResults     = results.filter( ( r ) => r.match_type === 'title' );
    const authorResults    = results.filter( ( r ) => r.match_type === 'author' );
    const publisherResults = results.filter( ( r ) => r.match_type === 'publisher' );

    const activeTabs = [];
    if ( contentResults.length > 0 ) {
        activeTabs.push( { key: 'content', label: t( 'search.contentResults' ) || ( isTr ? 'İçerik Sonuçları' : 'Content Results' ), count: contentResults.length, data: contentResults } );
    }
    if ( titleResults.length > 0 ) {
        activeTabs.push( { key: 'titles', label: titleLabel, count: titleResults.length, data: titleResults } );
    }
    if ( authorResults.length > 0 ) {
        activeTabs.push( { key: 'authors', label: authorLabel, count: authorResults.length, data: authorResults } );
    }
    if ( publisherResults.length > 0 ) {
        activeTabs.push( { key: 'publishers', label: publisherLabel, count: publisherResults.length, data: publisherResults } );
    }

    const currentTab = activeTabs.find( ( t ) => t.key === selectedTab ) || activeTabs[0];
    const activeTab = currentTab?.key ?? '';

    return (
        <div className="flex flex-col gap-4 text-left">
            { activeTabs.length > 1 && (
                <div className="flex gap-2 border-b border-gray-200 dark:border-gray-700 pb-2 overflow-x-auto scrollbar-none shrink-0">
                    { activeTabs.map( ( tab ) => (
                        <button
                            key={ tab.key }
                            onClick={ () => setSelectedTab( tab.key ) }
                            className={ `px-3 py-1.5 text-xs font-medium rounded-lg whitespace-nowrap transition-colors flex items-center ${
                                activeTab === tab.key
                                    ? 'bg-primary-500 text-white'
                                    : 'text-gray-500 hover:text-gray-900 dark:text-gray-400 dark:hover:text-white hover:bg-gray-100 dark:hover:bg-gray-800'
                            }` }
                        >
                            { tab.label }
                            <span className={ `ml-1.5 text-[10px] px-1.5 py-0.5 rounded-full ${
                                activeTab === tab.key
                                    ? 'bg-white/20 text-white'
                                    : 'bg-gray-100 dark:bg-gray-700 text-gray-500 dark:text-gray-400'
                            }` }>
                                { tab.count }
                            </span>
                        </button>
                    ) ) }
                </div>
            ) }

            <div className="flex flex-col gap-3">
                { currentTab?.data.map( ( result ) => (
                    <ContentSearchResultItem
                        key={ `${result.match_type}-${result.item_id}` }
                        result={ result }
                        searchTerm={ searchTerm }
                    />
                ) ) }
            </div>
        </div>
    );
};

const ContentSearchResultItem: React.FC<{
    result: ContentSearchResult;
    searchTerm: string;
}> = ( { result, searchTerm } ) => {
    const { t, locale } = useTranslation();
    const isTr = locale?.startsWith( 'tr' );

    const visibleMatches = result.matches.slice( 0, 2 );
    const extraCount     = Math.max( 0, ( result.total_matches ?? result.matches.length ) - visibleMatches.length );

    const handleGoto = ( pageNum: number, volumeIdx: number, excerpt?: string ) => {
        if ( ! result.cpt_url ) return;
        const deeplink: Record<string, unknown> = { itemId: result.item_id, page: pageNum, volume: volumeIdx, search: searchTerm };
        if ( excerpt ) {
            // Fallback anchor: if the search term fails to match in the reader
            // (e.g. different apostrophe encoding in the file), this raw excerpt
            // snippet lets the reader locate the correct passage by its content.
            deeplink.anchor = excerpt.trim().slice( 0, 80 );
        }
        sessionStorage.setItem( 'jetreader_deeplink', JSON.stringify( deeplink ) );
        window.location.href = result.cpt_url;
    };

    const handleSearchInBook = () => {
        if ( ! result.cpt_url ) return;
        sessionStorage.setItem( 'jetreader_deeplink', JSON.stringify( { itemId: result.item_id, search: searchTerm } ) );
        window.location.href = result.cpt_url;
    };

    const handleTitleClick = ( e: React.MouseEvent ) => {
        if ( result.cpt_url ) return;
        e.preventDefault();
    };

    const metaParts = [];
    if ( result.author ) metaParts.push( result.author );
    if ( result.publisher ) metaParts.push( result.publisher );
    if ( result.year ) metaParts.push( result.year );
    const metaText = metaParts.join( ' | ' );

    return (
        <div className="bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 overflow-hidden hover:shadow-md transition-shadow text-left flex">

            { /* ── Left: Cover full height ── */ }
            <div className="shrink-0 w-48 self-stretch">
                { result.cover_url ? (
                    <img
                        src={ result.cover_url }
                        alt={ result.title }
                        className="w-full h-full object-cover"
                    />
                ) : (
                    <div className="w-full h-full flex items-center justify-center bg-gray-100 dark:bg-gray-700 text-2xl">
                        { TYPE_ICONS[ result.type ] ?? '📄' }
                    </div>
                ) }
            </div>

            { /* ── Right: All content ── */ }
            <div className="flex-1 min-w-0 p-4">
                <a
                    href={ result.cpt_url || '#' }
                    onClick={ handleTitleClick }
                    className="font-semibold text-sm text-gray-900 dark:text-white hover:text-primary-600 dark:hover:text-primary-400 transition-colors line-clamp-2 block leading-snug"
                >
                    { result.title }
                </a>

                { metaText && (
                    <p className="text-xs text-gray-500 dark:text-gray-400 mt-1 line-clamp-1">
                        { metaText }
                    </p>
                ) }

                <div className="flex items-center gap-1.5 mt-1.5 flex-wrap">
                    { result.file_type && (
                        <span className="px-1.5 py-0.5 bg-blue-50 dark:bg-blue-900/30 text-blue-600 dark:text-blue-400 rounded text-[9px] font-bold uppercase">
                            { result.file_type }
                        </span>
                    ) }
                    <span className="text-xs text-gray-400 dark:text-gray-500 capitalize">
                        { TYPE_ICONS[ result.type ] } { result.type }
                    </span>
                    { result.match_type === 'content' && (
                        <span className="px-1.5 py-0.5 bg-primary-50 dark:bg-primary-900/30 text-primary-600 dark:text-primary-400 rounded-full text-[10px] font-medium">
                            { t( 'search.contentSearch' ) }
                        </span>
                    ) }
                </div>

            { /* ── Match list — max 2 ── */ }
            { visibleMatches.length > 0 && (
                <ul className="flex flex-col gap-2 border-t border-gray-100 dark:border-gray-700 pt-2.5 mt-2.5">
                    { visibleMatches.map( ( m, i ) => (
                        <li key={ i } className="flex items-start gap-2">
                            <span className="shrink-0 text-[10px] font-semibold bg-blue-50 dark:bg-blue-900/30 text-blue-600 dark:text-blue-400 border border-blue-200 dark:border-blue-700/50 rounded-full px-2 py-0.5 leading-tight whitespace-nowrap tracking-wide">
                                { ( m.volume_idx > 0 || result.matches.some( match => match.volume_idx > 0 ) ) ? (
                                    <>
                                        { t( 'frontend.infoModalVolItemBook' ) || 'Cilt' } { m.volume_idx + 1 } - { t( 'search.pageLabel' ) } { m.page_num + 1 }
                                    </>
                                ) : (
                                    <>
                                        { t( 'search.pageLabel' ) } { m.page_num + 1 }
                                    </>
                                ) }
                            </span>
                            <span className="flex-1 text-xs text-gray-600 dark:text-gray-300 line-clamp-2 leading-relaxed">
                                &hellip;{ highlightTerm( m.excerpt, searchTerm ) }&hellip;
                            </span>
                            { result.cpt_url && (
                                <button
                                    onClick={ () => handleGoto( m.page_num, m.volume_idx ?? 0, m.excerpt ) }
                                    className="jr-goto-btn"
                                >
                                    { t( 'search.gotoBtn' ) || 'Git' }
                                </button>
                            ) }
                        </li>
                    ) ) }
                </ul>
            ) }

            { /* ── "More matches" footer ── */ }
            { extraCount > 0 && (
                <div className="mt-2.5 pt-2 border-t border-gray-100 dark:border-gray-700 flex items-center justify-between gap-2">
                    <span className="text-xs text-gray-400 dark:text-gray-500">
                        { t( 'search.moreMatchesCount' ).replace( '{count}', String( extraCount ) ) }
                    </span>
                    { result.cpt_url && (
                        <button
                            onClick={ handleSearchInBook }
                            className="text-xs text-primary-600 hover:text-primary-700 dark:text-primary-400 dark:hover:text-primary-300 font-medium flex items-center gap-1 transition-colors shrink-0"
                        >
                            { t( 'search.searchInBook' ) }
                            <svg xmlns="http://www.w3.org/2000/svg" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><polyline points="9 18 15 12 9 6"/></svg>
                        </button>
                    ) }
                </div>
            ) }

            { /* ── "Read Button" for non-content match types ── */ }
            { result.match_type !== 'content' && result.cpt_url && (
                <div className="mt-2.5 pt-2 border-t border-gray-100 dark:border-gray-700 flex justify-end">
                    <button
                        onClick={ () => handleGoto( 0, 0 ) }
                        className="px-3 py-1 bg-primary-500 text-white rounded-lg text-xs font-semibold hover:bg-primary-600 transition-colors flex items-center gap-1"
                    >
                        📖 { t( 'display.read' ) || ( isTr ? 'Oku' : 'Read' ) } &rarr;
                    </button>
                </div>
            ) }
            </div>{ /* ── end right content ── */ }
        </div>
    );
};

/* ------------------------------------------------------------------ */
/*  Library content (grid or search results)                           */
/* ------------------------------------------------------------------ */

interface LibraryContentProps {
    settings: PublicSettings;
    activeType: ContentTypeKey;
    filters: ActiveFilters;
    searchTerm: string;
    forcedType: ContentTypeKey | null;
}

const LibraryContent: React.FC<LibraryContentProps> = ( {
    settings, activeType, filters, searchTerm, forcedType,
} ) => {
    const { t } = useTranslation();
    const [ page, setPage ] = useState( 1 );
    const [ readerItem, setReaderItem ] = useState<LibraryItem | null>( null );
    const [ infoItem,   setInfoItem   ] = useState<LibraryItem | null>( null );
    const [ readerVolIdx, setReaderVolIdx ] = useState<number | undefined>( undefined );

    const resolvedTheme = ( (): 'light' | 'dark' | 'sepia' => {
        const raw = settings.reader_theme ?? 'auto';
        if ( raw === 'auto' ) return window.matchMedia( '(prefers-color-scheme: dark)' ).matches ? 'dark' : 'light';
        if ( raw === 'dark' || raw === 'sepia' ) return raw;
        return 'light';
    } )();
    const resolvedFontSize = ( () => {
        const raw = settings.reader_font_size ?? 'medium';
        if ( raw === 'small' || raw === 'large' || raw === 'xlarge' ) return raw;
        return 'medium' as const;
    } )();

    const effectiveType = forcedType ?? ( filters.type || activeType );

    useEffect( () => { setPage( 1 ); }, [ effectiveType, filters, searchTerm ] );

    const { data, isLoading, isError } = useQuery<PaginatedResponse>( {
        queryKey: [ 'items', effectiveType, filters, page, settings.items_per_page ],
        enabled: searchTerm.length < 2,
        queryFn: async () => {
            const params = new URLSearchParams( {
                per_page: String( settings.items_per_page ),
                page: String( page ),
            } );
            if ( effectiveType ) params.set( 'type', effectiveType );
            if ( filters.language )                    params.set( 'language',        filters.language );
            if ( filters.yearFrom )                    params.set( 'year_from',       filters.yearFrom );
            if ( filters.yearTo )                      params.set( 'year_to',         filters.yearTo );
            if ( filters.authorNames.length > 0 )      params.set( 'author_names',   filters.authorNames.join( ',' ) );
            if ( filters.publisherNames.length > 0 )   params.set( 'publisher_names', filters.publisherNames.join( ',' ) );
            if ( filters.translator )                  params.set( 'translator',      filters.translator );
            if ( filters.featured )                    params.set( 'featured',        '1' );
            if ( filters.categoryIds.length > 0 )      params.set( 'category_ids',   filters.categoryIds.join( ',' ) );

            const res = await fetch( `${API_BASE}/items?${ params }` );
            return res.json();
        },
        keepPreviousData: true,
    } as any );

    const gridCols         = settings.grid_columns ?? 4;
    const cardMinWidth     = settings.library_card_min_width ?? 180;
    const imageSize        = settings.library_image_size ?? 'large';
    const imageFit         = settings.library_image_fit  ?? 'cover';
    const showReadButton   = settings.library_show_read_button !== false;
    const showInfoButton   = settings.library_show_info_button !== false;
    const showCardImage    = settings.show_card_image      !== false;
    const showCardTitle    = settings.show_card_title      !== false;
    const showCardAuthor   = settings.show_card_author     !== false;
    const showCardTranslator = !! settings.show_card_translator;
    const showCardPublisher  = !! settings.show_card_publisher;
    const showCardYear     = settings.show_card_year       !== false;
    const showCardType     = settings.show_card_type       !== false;
    const showCardLanguage = !! settings.show_card_language;
    const showCardPageCount = settings.show_card_page_count !== false;
    const gap = 20;
    const gridStyle: React.CSSProperties = {
        display: 'grid',
        gridTemplateColumns: `repeat(auto-fill, minmax(max(${ cardMinWidth }px, calc((100% - ${ ( gridCols - 1 ) * gap }px) / ${ gridCols })), 1fr))`,
        gap: '1.25rem',
    };

    // Content search mode: show rich results list
    if ( searchTerm.length >= 2 ) {
        return (
            <>
                <ContentSearchResultList searchTerm={ searchTerm } />
                { readerItem && (
                    <Suspense fallback={ null }>
                        <ReaderModal
                            key={ readerItem.id }
                            itemId={ readerItem.id }
                            fileUrl={ readerItem.file_path }
                            format={ resolveFileFormat( readerItem ) }
                            title={ readerItem.title }
                            volumes={ readerItem.volumes && readerItem.volumes.length > 1 ? readerItem.volumes : undefined }
                            itemType={ readerItem.type }
                            encoding={ readerItem.metadata?.encoding }
                            onClose={ () => { setReaderItem( null ); setReaderVolIdx( undefined ); } }
                            initialVolume={ readerVolIdx }
                            initialFontSize={ resolvedFontSize }
                            initialTheme={ resolvedTheme }
                        />
                    </Suspense>
                ) }
            </>
        );
    }

    if ( isLoading ) return <SkeletonGrid cols={ gridCols } cardMinWidth={ cardMinWidth } />;

    if ( isError ) return (
        <div className="text-center py-20">
            <span className="text-4xl">⚠️</span>
            <p className="mt-3 text-gray-500 dark:text-gray-400">{ t( 'frontend.failedToLoad' ) }</p>
        </div>
    );

    const items = data?.items ?? [];

    return (
        <>
            { items.length === 0 ? (
                <div className="text-center py-24">
                    <span className="text-6xl">📭</span>
                    <h2 className="text-xl font-semibold text-gray-800 dark:text-white mt-4">{ t( 'frontend.emptyTitle' ) }</h2>
                    <p className="text-gray-500 dark:text-gray-400 mt-2 text-sm">
                        { t( 'frontend.emptyAdjustFilters' ) }
                    </p>
                </div>
            ) : (
                <>
                    <AnimatePresence mode="popLayout">
                        <div style={ gridStyle }>
                            { items.map( ( item ) => (
                                <ItemCard
                                    key={ item.id }
                                    item={ item }
                                    onRead={ () => setReaderItem( item ) }
                                    onInfo={ () => setInfoItem( item ) }
                                    imageSize={ imageSize }
                                    imageFit={ imageFit }
                                    showReadButton={ showReadButton }
                                    showInfoButton={ showInfoButton }
                                    showCardImage={ showCardImage }
                                    showCardTitle={ showCardTitle }
                                    showCardAuthor={ showCardAuthor }
                                    showCardTranslator={ showCardTranslator }
                                    showCardPublisher={ showCardPublisher }
                                    showCardYear={ showCardYear }
                                    showCardType={ showCardType }
                                    showCardLanguage={ showCardLanguage }
                                    showCardPageCount={ showCardPageCount }
                                    cardRadius={ settings.library_card_radius }
                                    cardBorder={ settings.library_card_border }
                                    cardShadow={ settings.library_card_shadow }
                                    cardHover={ settings.library_card_hover }
                                    cardAlign={ settings.library_card_align }
                                    cardLayout={ settings.library_card_layout }
                                />
                            ) ) }
                        </div>
                    </AnimatePresence>

                    <Pagination
                        page={ data?.page ?? 1 }
                        pages={ data?.pages ?? 1 }
                        total={ data?.total ?? 0 }
                        perPage={ settings.items_per_page }
                        onChange={ ( p ) => { setPage( p ); window.scrollTo( { top: 0, behavior: 'smooth' } ); } }
                    />
                </>
            ) }

            { readerItem && (
                <Suspense fallback={ null }>
                    <ReaderModal
                        key={ readerItem.id }
                        itemId={ readerItem.id }
                        fileUrl={ readerItem.file_path }
                        format={ resolveFileFormat( readerItem ) }
                        title={ readerItem.title }
                        volumes={ readerItem.volumes && readerItem.volumes.length > 1 ? readerItem.volumes : undefined }
                        itemType={ readerItem.type }
                        encoding={ readerItem.metadata?.encoding }
                        onClose={ () => { setReaderItem( null ); setReaderVolIdx( undefined ); } }
                        initialVolume={ readerVolIdx }
                        initialFontSize={ resolvedFontSize }
                        initialTheme={ resolvedTheme }
                    />
                </Suspense>
            ) }
            <AnimatePresence>
                { infoItem && ! readerItem && (
                    <InfoModal
                        key={ infoItem.id }
                        item={ infoItem }
                        onClose={ () => setInfoItem( null ) }
                        onRead={ ( volIdx ) => {
                            setReaderVolIdx( volIdx );
                            setReaderItem( infoItem );
                            setInfoItem( null );
                        } }
                        showReadButton={ showReadButton }
                        downloadEnabled={ settings.download_enabled === true }
                        settings={ settings }
                    />
                ) }
            </AnimatePresence>
        </>
    );
};

/* ------------------------------------------------------------------ */
/*  App root                                                           */
/* ------------------------------------------------------------------ */

interface AppProps { libraryType: string; libraryTypes?: string }

const AppInner: React.FC<AppProps> = ( { libraryType, libraryTypes = '' } ) => {
    const { t, direction } = useTranslation();
    const { data: settings, isLoading: settingsLoading } = usePublicSettings();

    // Parse comma-separated 'types' attribute, e.g. "book,magazine"
    const allowedTypeKeys: ContentTypeKey[] = libraryTypes
        ? ( libraryTypes.split( ',' )
              .map( ( s ) => s.trim() )
              .filter( ( s ): s is ContentTypeKey =>
                  s !== '' && CONTENT_TYPES.some( ( ct ) => ct.key === s )
              ) )
        : [];

    // Single forced type: from 'type' attr OR when only 1 value in 'types' attr
    const forcedType: ContentTypeKey | null =
        libraryType && CONTENT_TYPES.some( ( ct ) => ct.key === libraryType )
            ? ( libraryType as ContentTypeKey )
            : allowedTypeKeys.length === 1
              ? allowedTypeKeys[ 0 ]
              : null;

    // Tabs to show: restricted subset when 'types' has 2+ entries, all otherwise
    const visibleTypes = allowedTypeKeys.length >= 2
        ? CONTENT_TYPES.filter( ( ct ) => allowedTypeKeys.includes( ct.key as ContentTypeKey ) )
        : CONTENT_TYPES;

    const defaultType: ContentTypeKey = forcedType ?? ( () => {
        const p = new URLSearchParams( window.location.search ).get( 'type' ) as ContentTypeKey | null;
        if ( allowedTypeKeys.length >= 2 ) {
            return allowedTypeKeys.includes( p as ContentTypeKey ) ? ( p as ContentTypeKey ) : allowedTypeKeys[ 0 ];
        }
        return CONTENT_TYPES.some( ( ct ) => ct.key === p ) ? p! : '';
    } )();

    const [ activeType,   setActiveType   ] = useState<ContentTypeKey>( defaultType );

    const effectiveType = forcedType ?? activeType;
    const { data: categories  = [] } = useCategories( effectiveType || undefined );
    const { data: authors     = [] } = useAuthors();
    const { data: publishers  = [] } = usePublishers();
    const [ filters,      setFilters      ] = useState<ActiveFilters>( DEFAULT_FILTERS );
    const initialSearch = new URLSearchParams( window.location.search ).get( 'search' ) ?? '';
    const [ searchInput,  setSearchInput  ] = useState( initialSearch );
    const [ searchTerm,   setSearchTerm   ] = useState( initialSearch );
    const [ mobileSidebar,setMobileSidebar] = useState( false );

    useEffect( () => {
        const url = new URL( window.location.href );
        if ( searchTerm ) url.searchParams.set( 'search', searchTerm );
        else url.searchParams.delete( 'search' );
        window.history.replaceState( {}, '', url.toString() );
    }, [ searchTerm ] );

    useEffect( () => {
        // Prefetch ReaderModal bundle when browser is idle to speed up first click
        const prefetch = () => {
            import( '../reader/ReaderModal' );
        };
        if ( 'requestIdleCallback' in window ) {
            ( window as any ).requestIdleCallback( () => prefetch() );
        } else {
            setTimeout( prefetch, 2000 );
        }
    }, [] );

    const switchType = ( key: ContentTypeKey ) => {
        setActiveType( key );
        setFilters( DEFAULT_FILTERS );
        setSearchTerm( '' );
        setSearchInput( '' );
        if ( ! forcedType ) {
            const url = new URL( window.location.href );
            if ( key ) url.searchParams.set( 'type', key );
            else url.searchParams.delete( 'type' );
            url.searchParams.delete( 'search' );
            window.history.replaceState( {}, '', url.toString() );
        }
    };

    const mergeFilter = ( partial: Partial<ActiveFilters> ) =>
        setFilters( ( prev ) => ( { ...prev, ...partial } ) );

    const removeFilter = ( key: keyof ActiveFilters ) =>
        setFilters( ( prev ) => ( { ...prev, [ key ]: DEFAULT_FILTERS[ key ] } ) );

    const removeCategoryId = ( id: number ) =>
        setFilters( ( prev ) => ( { ...prev, categoryIds: prev.categoryIds.filter( ( c ) => c !== id ) } ) );

    const removeAuthorName = ( name: string ) =>
        setFilters( ( prev ) => ( { ...prev, authorNames: prev.authorNames.filter( ( n ) => n !== name ) } ) );

    const removePublisherName = ( name: string ) =>
        setFilters( ( prev ) => ( { ...prev, publisherNames: prev.publisherNames.filter( ( n ) => n !== name ) } ) );

    const clearFilters = () => setFilters( DEFAULT_FILTERS );

    const handleSearch = () => {
        if ( searchInput.trim().length >= 2 ) setSearchTerm( searchInput.trim() );
        else if ( ! searchInput.trim() ) setSearchTerm( '' );
    };

    if ( settingsLoading ) {
        return (
            <div className="w-full py-16 flex justify-center">
                <div className="animate-spin text-3xl">⏳</div>
            </div>
        );
    }

    const cfg = settings!;
    const showSidebar       = cfg.show_sidebar;
    const showLibrarySearch = cfg.library_show_search !== false;

    return (
        <div dir={ direction } className="jetreader-frontend w-full">

            { /* ── Tab navigation ── */ }
            { ! forcedType && (
                <div className="flex gap-0.5 mb-0 border-b border-gray-200 dark:border-gray-700 overflow-x-auto overflow-y-hidden">
                    { visibleTypes.map( ( type ) => (
                        <button
                            key={ type.key }
                            onClick={ () => switchType( type.key ) }
                            className={ `flex items-center gap-2 px-5 py-3 text-sm font-medium border-b-2 transition-colors -mb-px whitespace-nowrap ${
                                activeType === type.key
                                    ? 'border-primary-500 text-primary-600 dark:text-primary-400'
                                    : 'border-transparent text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 hover:border-gray-300'
                            }` }
                        >
                            <span>{ type.icon }</span>
                            <span>{ getTypeLabel( type.key, t ) }</span>
                        </button>
                    ) ) }
                </div>
            ) }

            { /* ── Toolbar ── */ }
            <div className="flex flex-col sm:flex-row sm:items-center gap-3 py-4">
                { /* Mobile filter button */ }
                { showSidebar && (
                    <button
                        onClick={ () => setMobileSidebar( true ) }
                        className="lg:hidden flex items-center gap-2 px-3 py-2 text-sm border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-800 text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700 transition-colors shrink-0"
                    >
                        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={ 2 } d="M3 4h18M7 12h10M11 20h2" />
                        </svg>
                        { t( 'frontend.filtersMobile' ) }
                    </button>
                ) }

                { /* Search */ }
                { showLibrarySearch && (
                    <div className="flex gap-2 flex-1">
                        <input
                            type="text"
                            value={ searchInput }
                            onChange={ ( e ) => setSearchInput( e.target.value ) }
                            onKeyDown={ ( e ) => e.key === 'Enter' && handleSearch() }
                            placeholder={ t( 'frontend.searchPlaceholder' ) }
                            className="jr-input text-sm"
                        />
                        <button onClick={ handleSearch } className="jr-btn-primary text-sm px-4 shrink-0">
                            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
                            </svg>
                        </button>
                        { searchTerm && (
                            <button
                                onClick={ () => { setSearchTerm( '' ); setSearchInput( '' ); } }
                                className="jr-btn-secondary text-sm px-3 shrink-0"
                            >
                                ✕
                            </button>
                        ) }
                    </div>
                ) }
            </div>

            { /* ── Main layout ── */ }
            <div className={ `flex gap-6 ${ showSidebar ? 'items-start' : '' }` }>

                { /* Desktop Sidebar */ }
                { showSidebar && (
                    <aside className="hidden lg:block w-56 xl:w-64 shrink-0 sticky top-6 self-start">
                        <div className="bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 p-4">
                            <FilterSidebar
                                settings={ cfg }
                                categories={ categories }
                                authors={ authors }
                                publishers={ publishers }
                                filters={ filters }
                                forcedType={ forcedType }
                                onFilterChange={ mergeFilter }
                                onClear={ clearFilters }
                            />
                        </div>
                    </aside>
                ) }

                { /* Content */ }
                <div className="flex-1 min-w-0">
                    <ActiveFilterChips
                        filters={ filters }
                        categories={ categories }
                        onRemove={ removeFilter }
                        onRemoveCategoryId={ removeCategoryId }
                        onRemoveAuthorName={ removeAuthorName }
                        onRemovePublisherName={ removePublisherName }
                    />
                    <LibraryContent
                        settings={ cfg }
                        activeType={ activeType }
                        filters={ filters }
                        searchTerm={ searchTerm }
                        forcedType={ forcedType }
                    />
                </div>
            </div>

            { /* ── Mobile sidebar drawer ── */ }
            <AnimatePresence>
                { showSidebar && mobileSidebar && (
                    <>
                        <motion.div
                            initial={ { opacity: 0 } } animate={ { opacity: 1 } } exit={ { opacity: 0 } }
                            className="fixed inset-0 bg-black/50 z-[9998] lg:hidden"
                            onClick={ () => setMobileSidebar( false ) }
                        />
                        <motion.div
                            initial={ { x: direction === 'rtl' ? '100%' : '-100%' } } animate={ { x: 0 } } exit={ { x: direction === 'rtl' ? '100%' : '-100%' } }
                            transition={ { type: 'tween', duration: 0.25 } }
                            className={ `fixed top-0 ${ direction === 'rtl' ? 'right-0' : 'left-0' } h-full w-72 bg-white dark:bg-gray-900 z-[9999] p-5 shadow-2xl overflow-y-auto lg:hidden` }
                        >
                            <FilterSidebar
                                settings={ cfg }
                                categories={ categories }
                                authors={ authors }
                                publishers={ publishers }
                                filters={ filters }
                                forcedType={ forcedType }
                                onFilterChange={ mergeFilter }
                                onClear={ clearFilters }
                                onMobileClose={ () => setMobileSidebar( false ) }
                            />
                        </motion.div>
                    </>
                ) }
            </AnimatePresence>
        </div>
    );
};

const App: React.FC<AppProps> = ( props ) => (
    <QueryClientProvider client={ queryClient }>
        <I18nProvider>
            <AppInner libraryType={ props.libraryType } libraryTypes={ props.libraryTypes } />
        </I18nProvider>
    </QueryClientProvider>
);

export default App;

/* ── Standalone search block ([jetreader_search] shortcode) ── */
const StandaloneSearchInner: React.FC = () => {
    const { t, direction }         = useTranslation();
    const [ input, setInput ]      = useState( '' );
    const [ term,  setTerm  ]      = useState( '' );

    const handleSearch = () => {
        if ( input.trim().length >= 2 ) setTerm( input.trim() );
        else if ( ! input.trim() ) setTerm( '' );
    };

    return (
        <div dir={ direction } className="flex flex-col gap-4">
            <div className="flex gap-2">
                <input
                    type="text"
                    value={ input }
                    onChange={ ( e ) => setInput( e.target.value ) }
                    onKeyDown={ ( e ) => e.key === 'Enter' && handleSearch() }
                    placeholder={ t( 'frontend.searchPlaceholder' ) }
                    className="jr-input text-sm flex-1"
                />
                <button onClick={ handleSearch } className="jr-btn-primary text-sm px-4 shrink-0">
                    <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
                </button>
                { term && (
                    <button
                        onClick={ () => { setTerm( '' ); setInput( '' ); } }
                        className="jr-btn-secondary text-sm px-3 shrink-0"
                    >
                        ✕
                    </button>
                ) }
            </div>
            { term.length >= 2 && <ContentSearchResultList searchTerm={ term } /> }
        </div>
    );
};

export const StandaloneSearchApp: React.FC = () => (
    <QueryClientProvider client={ queryClient }>
        <I18nProvider>
            <StandaloneSearchInner />
        </I18nProvider>
    </QueryClientProvider>
);
