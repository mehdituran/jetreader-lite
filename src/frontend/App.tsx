// Polyfill Promise.withResolvers for older browsers (e.g. iOS < 17.4 / Safari < 17.4)
if (typeof (Promise as any).withResolvers === 'undefined') {
    (Promise as any).withResolvers = function () {
        let resolve: any, reject: any;
        const promise = new Promise((res, rej) => {
            resolve = res;
            reject = rej;
        });
        return { promise, resolve, reject };
    };
}

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
    items_per_page: number;
    grid_columns: number;
    show_sidebar: boolean;
    show_filter_category: boolean;
    show_filter_language: boolean;
    show_filter_year: boolean;
    show_card_image: boolean;
    show_card_title: boolean;
    show_detail_image?: boolean;
    show_detail_title?: boolean;
    show_detail_author?: boolean;
    show_detail_description?: boolean;
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
/*  Hooks                                                              */
/* ------------------------------------------------------------------ */

function usePublicSettings() {
    return useQuery<PublicSettings>( {
        queryKey: [ 'jr-public-settings' ],
        queryFn: async () => {
            const res = await fetch( `${API_BASE}/public/settings` );
            return res.json();
        },
        staleTime: 1000 * 10,
    } );
}

function useCategories( type?: string ) {
    return useQuery<Category[]>( {
        queryKey: [ 'jr-categories', type || '' ],
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
        queryKey: [ 'jr-authors' ],
        queryFn: async () => {
            const res = await fetch( `${API_BASE}/authors` );
            return res.json();
        },
        staleTime: 1000 * 60 * 10,
    } );
}

function usePublishers() {
    return useQuery<Publisher[]>( {
        queryKey: [ 'jr-publishers' ],
        queryFn: async () => {
            const res = await fetch( `${API_BASE}/publishers` );
            return res.json();
        },
        staleTime: 1000 * 60 * 10,
    } );
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
    const { t, locale } = useTranslation();

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
    showImage?: boolean;
    showTitle?: boolean;
}> = ( {
    item, onRead, onInfo,
    showImage = true, showTitle = true,
} ) => {
    const { t } = useTranslation();
    const isQA    = item.type === 'qa';
    const hasFile = !! item.file_path;
    const typeIcon = { book: '📖', article: '📄', magazine: '🗞️', qa: '💬' }[ item.type ] ?? '📖';

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

    const handleRead = () => {
        if ( item.cpt_url ) {
            window.location.href = item.cpt_url;
        } else {
            onRead();
        }
    };

    return (
        <motion.div
            layout
            initial={ { opacity: 0, y: 16 } }
            animate={ { opacity: 1, y: 0 } }
            exit={ { opacity: 0, scale: 0.96 } }
            transition={ { duration: 0.22 } }
            className="jr-card group h-full transition-all duration-300 flex flex-col jr-radius-medium jr-border-subtle jr-shadow-subtle jr-hover-zoom jr-align-left"
            onMouseEnter={ handleMouseEnter }
            onMouseLeave={ handleMouseLeave }
        >
            { /* ── Cover / Image Section ── */ }
            { showImage && (
                isQA ? (
                    <div className="h-24 bg-gradient-to-br from-amber-400 to-orange-500 flex items-center justify-center shrink-0 relative overflow-hidden">
                        <span className="text-3xl opacity-80">💬</span>
                        { item.featured && (
                            <span className="absolute top-1.5 right-1.5 bg-yellow-400/90 backdrop-blur-sm text-yellow-900 text-[10px] font-bold px-2 py-0.5 rounded-full shadow-sm flex items-center gap-0.5">
                                ⭐
                            </span>
                        ) }
                    </div>
                ) : (
                    <div className="relative h-52 bg-gradient-to-br from-slate-100 to-slate-200 dark:from-slate-800 dark:to-slate-700 overflow-hidden flex items-center justify-center shrink-0">
                        { item.cover_image ? (
                            <img
                                src={ item.cover_image }
                                alt={ item.title }
                                loading="lazy"
                                className="w-full h-full object-cover group-hover:scale-[1.03] transition-transform duration-500 ease-out"
                            />
                        ) : (
                            <div className="text-slate-400 dark:text-slate-300 text-center p-3 select-none">
                                <span className="text-4xl opacity-60">{ typeIcon }</span>
                                <p className="mt-1.5 text-[11px] font-medium line-clamp-2 opacity-70">{ item.title }</p>
                            </div>
                        ) }
                        <div className="absolute inset-0 bg-gradient-to-t from-black/5 to-transparent opacity-0 group-hover:opacity-100 transition-opacity duration-300 pointer-events-none" />
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
                { /* Title */ }
                { showTitle && (
                    <h3 className="font-bold text-gray-900 dark:text-white line-clamp-2 text-[14px] leading-tight tracking-tight">
                        { item.title }
                    </h3>
                ) }

                { /* QA description */ }
                { isQA && item.description && (
                    <p className="text-[11px] text-gray-500 dark:text-gray-400 line-clamp-2 leading-relaxed mt-0.5">
                        { item.description }
                    </p>
                ) }

                { /* Spacer */ }
                <div className="flex-1 min-h-0" />

                { /* Action Buttons */ }
                <div className="flex gap-1.5 mt-1">
                    { hasFile && ! isQA && item.file_path.trim() !== '' && (
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
                </div>
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
    settings?: PublicSettings;
}> = ( { item, onClose, onRead, settings } ) => {
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
        [ t( 'frontend.infoModalPages' ),     item.page_count && item.page_count > 0 ? `${ item.page_count } ${ t( 'reader.pages' ) }` : null ],
        item.volumes && item.volumes.length > 1
            ? [ t( 'frontend.infoModalVolumes' ), `${ item.volumes.length } ${ t( 'frontend.infoModalVolumesCount' ) }` ]
            : null,
    ] as ( [ string, string | null ] | null )[] )
        .filter( ( p ): p is [ string, string ] => !! p && !! p[1] );

    const hasFile = !! item.file_path;

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
                            { ( ( item.author && settings?.show_detail_author !== false ) || item.translator ) && (
                                <div style={ { marginBottom: '20px', display: 'flex', flexDirection: 'column', gap: '4px' } }>
                                    { item.author && settings?.show_detail_author !== false && (
                                        <p style={ { margin: 0, fontSize: '14px', color: 'var(--jr-modal-meta, #64748b)', display: 'flex', alignItems: 'center', gap: '6px' } }>
                                            <span style={ { fontSize: '12px' } }>✍️</span>
                                            <span>{ t( 'frontend.infoModalBy' ) } <strong style={ { fontWeight: 600, color: 'var(--jr-modal-text, #334155)' } }>{ item.author }</strong></span>
                                        </p>
                                    ) }
                                    { item.translator && (
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
                            { settings?.show_detail_description !== false && item.description && ( metaFields.length > 0 || ( item.author && settings?.show_detail_author !== false ) || item.translator ) && (
                                <hr style={ { border: 'none', borderTop: '1px solid var(--jr-modal-divider, #e2e8f0)', margin: '0 0 16px 0' } } />
                            ) }

                            { /* Description — pre-line preserves paragraph/line breaks */ }
                            { settings?.show_detail_description !== false && item.description && (
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
                            { hasFile && item.type !== 'qa' && item.file_path.trim() !== '' && (
                                <button
                                    onClick={ handleRead }
                                    className="jr-btn-primary"
                                    style={ { flex: '0 0 auto' } }
                                >{ t( 'frontend.infoModalReadNow' ) }</button>
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
                        height: 200px !important;
                        min-height: 200px !important;
                        max-height: 200px !important;
                        border-radius: 20px 20px 0 0 !important;
                        flex-shrink: 0 !important;
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
/*  Library content (grid)                                             */
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
        queryKey: [ 'jr-items', effectiveType, filters, page, settings.items_per_page, searchTerm ],
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
            if ( searchTerm.length >= 2 )              params.set( 'search',         searchTerm );

            const res = await fetch( `${API_BASE}/items?${ params }` );
            return res.json();
        },
        keepPreviousData: true,
    } as any );

    const gridCols      = settings.grid_columns ?? 4;
    const showCardImage = settings.show_card_image !== false;
    const showCardTitle = settings.show_card_title !== false;
    const gap = 20;
    const gridStyle: React.CSSProperties = {
        display: 'grid',
        gridTemplateColumns: `repeat(auto-fill, minmax(max(180px, calc((100% - ${ ( gridCols - 1 ) * gap }px) / ${ gridCols })), 1fr))`,
        gap: '1.25rem',
    };

    if ( isLoading ) return <SkeletonGrid cols={ gridCols } cardMinWidth={ 180 } />;

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
                                    showImage={ showCardImage }
                                    showTitle={ showCardTitle }
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
                { (
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