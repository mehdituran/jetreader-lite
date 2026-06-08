import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery, QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AnimatePresence } from 'framer-motion';
import { I18nProvider, useTranslation } from '../../i18n/I18nContext';
import ItemCard from './ItemCard';
import type { DisplayItem, GridAttrs } from './types';

const API_BASE = ( window as any ).jetreaderSettings?.apiUrl?.replace( /\/$/, '' ) ?? '/wp-json/jetreader/v1';

/* ------------------------------------------------------------------ */
/*  Hooks                                                              */
/* ------------------------------------------------------------------ */

interface Category { id: number; name: string; type: string; }
interface Author { id: number; name: string; }

function useCategories( type: string ) {
    return useQuery<Category[]>( {
        queryKey: [ 'jr-cats', type ],
        queryFn: async () => {
            const url = type
                ? `${ API_BASE }/categories?type=${ encodeURIComponent( type ) }`
                : `${ API_BASE }/categories`;
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
            const res = await fetch( `${ API_BASE }/authors` );
            const json = await res.json();
            return Array.isArray( json ) ? json : [];
        },
        staleTime: 1000 * 60 * 10,
    } );
}

function usePublicSettings() {
    return useQuery<{ download_enabled: boolean }>( {
        queryKey: [ 'jr-public-settings' ],
        queryFn: async () => {
            const res = await fetch( `${ API_BASE }/public/settings` );
            return res.json();
        },
        staleTime: 1000 * 60 * 10,
    } );
}

function useItems( params: Record<string, string | number> ) {
    return useQuery<{ items: DisplayItem[]; total: number; pages: number }>( {
        queryKey: [ 'jr-grid-items', params ],
        queryFn: async () => {
            const url = new URL( `${ API_BASE }/items`, window.location.href );
            Object.entries( params ).forEach( ( [ k, v ] ) => {
                if ( v !== '' && v !== null && v !== undefined ) url.searchParams.set( k, String( v ) );
            } );
            const res = await fetch( url.toString() );
            return res.json();
        },
        staleTime: 1000 * 60 * 3,
    } );
}

/* ------------------------------------------------------------------ */
/*  Responsive columns hook                                            */
/* ------------------------------------------------------------------ */

function useResponsiveCols( desktop: number, tablet: number, mobile: number ): number {
    const get = () => {
        const w = window.innerWidth;
        if ( w < 768 )  return mobile;
        if ( w < 1024 ) return tablet;
        return desktop;
    };
    const [ cols, setCols ] = useState( get );
    useEffect( () => {
        const ro = new ResizeObserver( () => setCols( get() ) );
        ro.observe( document.documentElement );
        return () => ro.disconnect();
    }, [ desktop, tablet, mobile ] );
    return cols;
}

function useContainerWidth( ref: React.RefObject<HTMLElement> ): number {
    const [ width, setWidth ] = useState( 0 );
    useEffect( () => {
        if ( ! ref.current ) return;
        const ro = new ResizeObserver( entries => setWidth( entries[ 0 ].contentRect.width ) );
        ro.observe( ref.current );
        return () => ro.disconnect();
    }, [] );
    return width;
}

/* ------------------------------------------------------------------ */
/*  Skeleton                                                           */
/* ------------------------------------------------------------------ */

const Skeleton: React.FC<{ count: number }> = ( { count } ) => (
    <>
        { Array.from( { length: count } ).map( ( _, i ) => (
            <div key={ i } className="jr-card overflow-hidden">
                <div className="jr-skeleton h-44 w-full" />
                <div className="p-3 space-y-2">
                    <div className="jr-skeleton h-3.5 w-3/4 rounded" />
                    <div className="jr-skeleton h-3 w-1/2 rounded" />
                    <div className="jr-skeleton h-8 w-full mt-2 rounded-lg" />
                </div>
            </div>
        ) ) }
    </>
);

/* ------------------------------------------------------------------ */
/*  FilterBar                                                          */
/* ------------------------------------------------------------------ */

interface FilterBarProps {
    type: string;
    categories: Category[];
    authors: Author[];
    activeCategory: number | null;
    activeAuthor: string;
    onCategoryChange: ( id: number | null ) => void;
    onAuthorChange: ( a: string ) => void;
}

const FilterBar: React.FC<FilterBarProps> = ( {
    categories, authors, activeCategory, activeAuthor, onCategoryChange, onAuthorChange,
} ) => {
    const { t } = useTranslation();

    return (
        <div className="jr-filter-bar flex flex-wrap gap-2 mb-4 items-center">
            { /* Category dropdown */ }
            { categories.length > 0 && (
                <select
                    value={ activeCategory ?? '' }
                    onChange={ e => onCategoryChange( e.target.value ? parseInt( e.target.value ) : null ) }
                    className="text-xs border border-gray-300 dark:border-gray-600 rounded-full px-3 py-1.5 bg-white dark:bg-gray-800 text-gray-800 dark:text-gray-200 focus:outline-none focus:border-primary-500"
                >
                    <option value="">{ t( 'display.allCategories' ) }</option>
                    { categories.map( cat => (
                        <option key={ cat.id } value={ cat.id }>{ cat.name }</option>
                    ) ) }
                </select>
            ) }

            { /* Author dropdown */ }
            { authors.length > 0 && (
                <select
                    value={ activeAuthor }
                    onChange={ e => onAuthorChange( e.target.value ) }
                    className="text-xs border border-gray-300 dark:border-gray-600 rounded-full px-3 py-1.5 bg-white dark:bg-gray-800 text-gray-800 dark:text-gray-200 focus:outline-none focus:border-primary-500"
                >
                    <option value="">{ t( 'display.allAuthors' ) }</option>
                    { authors.map( a => (
                        <option key={ a.id } value={ a.name }>{ a.name }</option>
                    ) ) }
                </select>
            ) }
        </div>
    );
};

/* ------------------------------------------------------------------ */
/*  DisplayGrid (inner)                                                */
/* ------------------------------------------------------------------ */

const DisplayGridInner: React.FC<GridAttrs> = ( attrs ) => {
    const { t, direction } = useTranslation();
    const cols = useResponsiveCols( attrs.columns, attrs.columnsTablet, attrs.columnsMobile );
    const containerRef = useRef<HTMLDivElement>( null );
    const cardMinWidth = attrs.cardMinWidth ?? 180;

    const [ page, setPage ]               = useState( 1 );
    const [ activeCategory, setCategory ] = useState<number | null>( null );
    const [ activeAuthor, setAuthor ]     = useState( attrs.author );

    const { data: categories }     = useCategories( attrs.type );
    const { data: authors }        = useAuthors();
    const { data: publicSettings } = usePublicSettings();
    const downloadEnabled = publicSettings?.download_enabled === true;
    const showPageCount = ( publicSettings as any )?.show_card_page_count !== false && attrs.showPageCount !== false;

    const visibleCats = ( categories ?? [] ).filter( c => ! attrs.type || c.type === attrs.type );

    const apiParams = useMemo( () => {
        const p: Record<string, string | number> = {
            per_page: attrs.limit,
            orderby:  attrs.orderby,
            page,
        };
        if ( attrs.type )       p.type        = attrs.type;
        if ( activeCategory )   p.category_id = activeCategory;
        if ( activeAuthor )     p.author      = activeAuthor;
        if ( attrs.items )      p.include_ids = attrs.items;
        // When images are hidden, exclude cover_image from the response for zero wasted transfer.
        if ( ! attrs.showImage ) p.fields = 'id,type,title,slug,description,file_path,file_type,language,author,publisher,publication_year,reading_time,page_count,featured,view_count,volumes,category_ids,cpt_url,created_at,updated_at';
        return p;
    }, [ attrs, page, activeCategory, activeAuthor ] );

    const { data, isLoading } = useItems( apiParams );
    const items = data?.items ?? [];
    const pages = data?.pages ?? 1;

    const gridStyle: React.CSSProperties = {
        display: 'grid',
        gridTemplateColumns: `repeat(auto-fill, minmax(${ cardMinWidth }px, 1fr))`,
        gap: '1.25rem',
    };

    return (
        <div dir={ direction } className="jr-grid-display" ref={ containerRef }>
            { attrs.title && (
                <h2 className="jr-display-title text-xl font-bold text-gray-900 dark:text-white mb-4">
                    { attrs.title }
                </h2>
            ) }

            { attrs.showFilter && (
                <FilterBar
                    type={ attrs.type }
                    categories={ visibleCats }
                    authors={ authors ?? [] }
                    activeCategory={ activeCategory }
                    activeAuthor={ activeAuthor }
                    onCategoryChange={ id => { setCategory( id ); setPage( 1 ); } }
                    onAuthorChange={ a  => { setAuthor( a );  setPage( 1 ); } }
                />
            ) }

            { isLoading ? (
                <div style={ gridStyle }><Skeleton count={ cols * 2 } /></div>
            ) : items.length === 0 ? (
                <div className="text-center py-12 text-gray-400 dark:text-gray-600">
                    <p className="text-4xl mb-2">📭</p>
                    <p className="text-sm">{ t( 'display.noItems' ) }</p>
                </div>
            ) : (
                <div style={ gridStyle }>
                    <AnimatePresence mode="popLayout">
                        { items.map( item => (
                            <ItemCard
                                key={ item.id }
                                item={ item }
                                showImage={ attrs.showImage }
                                showDescription={ attrs.showDescription }
                                showType={ attrs.showType }
                                showAuthor={ attrs.showAuthor }
                                showReadButton={ attrs.showReadButton }
                                showInfoButton={ attrs.showInfoButton }
                                showDownloadButton={ downloadEnabled }
                                showTranslator={ attrs.showTranslator }
                                showPublisher={ attrs.showPublisher }
                                showYear={ attrs.showYear }
                                showLanguage={ attrs.showLanguage }
                                showPageCount={ showPageCount }
                                imageSize={ attrs.imageSize }
                                imageFit={ attrs.imageFit }
                                cardRadius={ attrs.cardRadius }
                                cardBorder={ attrs.cardBorder }
                                cardShadow={ attrs.cardShadow }
                                cardHover={ attrs.cardHover }
                                cardAlign={ attrs.cardAlign }
                                cardLayout={ attrs.cardLayout }
                            />
                        ) ) }
                    </AnimatePresence>
                </div>
            ) }

            { pages > 1 && (
                <div className="flex justify-center items-center gap-2 mt-6">
                    <button
                        onClick={ () => setPage( p => Math.max( 1, p - 1 ) ) }
                        disabled={ page <= 1 }
                        className="jr-btn-secondary text-xs px-3 py-1.5 disabled:opacity-40"
                    >
                        { t( 'display.prev' ) }
                    </button>
                    <span className="text-xs text-gray-500 dark:text-gray-400">
                        { t( 'display.pageOf', { page: String( page ), pages: String( pages ) } ) }
                    </span>
                    <button
                        onClick={ () => setPage( p => Math.min( pages, p + 1 ) ) }
                        disabled={ page >= pages }
                        className="jr-btn-secondary text-xs px-3 py-1.5 disabled:opacity-40"
                    >
                        { t( 'display.next' ) }
                    </button>
                </div>
            ) }
        </div>
    );
};

/* ------------------------------------------------------------------ */
/*  Exported wrapper (provides QueryClient + I18n)                    */
/* ------------------------------------------------------------------ */

const qc = new QueryClient( { defaultOptions: { queries: { staleTime: 1000 * 60 * 3, retry: 1 } } } );

const DisplayGrid: React.FC<GridAttrs> = ( attrs ) => (
    <QueryClientProvider client={ qc }>
        <I18nProvider>
            <DisplayGridInner { ...attrs } />
        </I18nProvider>
    </QueryClientProvider>
);

export default DisplayGrid;
