import React, { useEffect, useState, useCallback } from 'react';
import { QueryClient, QueryClientProvider, useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { motion, AnimatePresence } from 'framer-motion';
import { I18nProvider, useTranslation } from '../i18n/I18nContext';
import { LangCombobox } from './LangCombobox';

declare const __JR_LITE__: boolean;

const queryClient = new QueryClient( {
    defaultOptions: {
        queries: {
            staleTime: Infinity,
            gcTime:    10 * 60 * 1000,
            retry: 1,
        },
    },
} );

/* ------------------------------------------------------------------ */
/*  Navigation — SPA router                                            */
/* ------------------------------------------------------------------ */

interface NavigationContextType {
    currentPage: string;
    navigateTo: ( page: string ) => void;
}

const NavigationContext = React.createContext<NavigationContextType>( {
    currentPage: 'jetreader',
    navigateTo: () => {},
} );

/** Hook to access SPA navigation from any child component. */
const useNavigation = () => React.useContext( NavigationContext );

/**
 * SPA-safe navigation link.
 * Keeps the real href so right-click / open-in-new-tab still works.
 * Clicking intercepts the default to prevent a full page reload.
 */
const NavLink: React.FC<{
    page: string;
    className?: string;
    style?: React.CSSProperties;
    children: React.ReactNode;
}> = ( { page, className, style, children } ) => {
    const { navigateTo } = useNavigation();
    return (
        <a
            href={ `admin.php?page=${ page }` }
            className={ className }
            style={ style }
            onClick={ ( e ) => { e.preventDefault(); navigateTo( page ); } }
        >
            { children }
        </a>
    );
};

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

interface VolumeEntry {
    vol: number;
    file_path: string;
    file_type: string;
    cover_image: string;
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
    translator: string;
    publisher: string;
    isbn: string;
    publication_year: number;
    reading_time: number;
    visibility: string;
    featured: boolean;
    view_count: number;
    read_count: number;
    volumes?: VolumeEntry[] | null;
    category_ids?: number[];
    created_at: string;
    updated_at: string;
}

interface PaginatedResponse {
    items: LibraryItem[];
    total: number;
    page: number;
    per_page: number;
    pages: number;
    all_ids?: number[];
}

interface Category {
    id: number;
    name: string;
    slug: string;
    description: string;
    type: string;
}

const API_BASE = ( ( window as any ).jetreaderSettings?.apiUrl ?? '/wp-json/jetreader/v1' ).replace( /\/$/, '' );
const getNonce = () => ( window as any ).jetreaderSettings?.nonce || ( window as any ).wpApiSettings?.nonce || '';
const dbg = ( ...args: unknown[] ) => { if ( ( window as any ).jetreaderSettings?.debug ) console.warn( '[JetReader]', ...args ); };

// Cached frames — one per type — so we never construct more than two frames
// across the lifetime of the admin page. Re-creating frames on every click
// can leave WP's media backbone in a broken state (activateMode TypeError).
const _mediaFrames: Record<string, any> = {};

function openWpMedia( title: string, imageOnly: boolean, onSelect: ( url: string ) => void ) {
    const wp = ( window as any ).wp;
    if ( ! wp?.media ) return;

    const key = imageOnly ? 'image' : 'file';

    if ( ! _mediaFrames[ key ] ) {
        _mediaFrames[ key ] = wp.media( {
            title,
            button: { text: '✓' },
            multiple: false,
            library: imageOnly ? { type: 'image' } : {},
        } );
    }

    const frame = _mediaFrames[ key ];

    // Replace the callback each open so we always call the right setter.
    frame.off( 'select' );
    frame.on( 'select', () => {
        const attachment = frame.state().get( 'selection' ).first().toJSON();
        onSelect( attachment.url );
    } );

    frame.open();
}

const WpMediaButton: React.FC<{
    onSelect: ( url: string ) => void;
    imageOnly?: boolean;
    title: string;
    disabled?: boolean;
}> = ( { onSelect, imageOnly = false, title, disabled } ) => (
    <button
        type="button"
        disabled={ disabled }
        title={ title }
        onClick={ () => ! disabled && openWpMedia( title, imageOnly, onSelect ) }
        className="flex-shrink-0 w-9 h-9 flex items-center justify-center bg-gray-150 dark:bg-gray-700 hover:bg-gray-250 dark:hover:bg-gray-600 border border-gray-300 dark:border-gray-600 rounded-xl text-gray-600 dark:text-gray-300 transition-all duration-150 disabled:opacity-50 disabled:cursor-not-allowed active:scale-95 shadow-sm"
    >
        { imageOnly ? (
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <rect x="3" y="3" width="18" height="18" rx="2" ry="2"/>
                <circle cx="8.5" cy="8.5" r="1.5"/>
                <polyline points="21 15 16 10 5 21"/>
            </svg>
        ) : (
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>
            </svg>
        ) }
    </button>
);

/* ------------------------------------------------------------------ */
/*  Dashboard                                                          */
/* ------------------------------------------------------------------ */

/* Shortcode copy-button used inside the Dashboard guide */
const ShortcodeChip: React.FC<{ code: string; hint: string; copied: string }> = ( { code, hint, copied } ) => {
    const [ isCopied, setIsCopied ] = React.useState( false );
    const handleCopy = () => {
        if ( navigator.clipboard ) {
            navigator.clipboard.writeText( code ).then( () => {
                setIsCopied( true );
                setTimeout( () => setIsCopied( false ), 2000 );
            } ).catch( () => {} );
        } else {
            // Fallback for HTTP sites where clipboard API is unavailable
            const el = document.createElement( 'textarea' );
            el.value = code;
            el.style.cssText = 'position:fixed;opacity:0';
            document.body.appendChild( el );
            el.select();
            try { document.execCommand( 'copy' ); setIsCopied( true ); setTimeout( () => setIsCopied( false ), 2000 ); } catch {}
            document.body.removeChild( el );
        }
    };
    // Use div+role instead of <button> to avoid WordPress admin CSS that targets
    // <button> elements inside non-first flex children (.divide-y siblings).
    // Named group (group/sc) avoids conflicts with Elementor/WooCommerce .group styles.
    return (
        <div
            role="button"
            tabIndex={ 0 }
            onClick={ handleCopy }
            onKeyDown={ ( e ) => ( e.key === 'Enter' || e.key === ' ' ) && handleCopy() }
            aria-label={ hint }
            className="group/sc inline-flex items-center gap-2 font-mono text-sm bg-gray-100 dark:bg-gray-700 hover:bg-primary-50 dark:hover:bg-primary-900/30 border border-gray-300 dark:border-gray-600 hover:border-primary-400 dark:hover:border-primary-500 text-gray-800 dark:text-gray-200 px-3 py-1.5 rounded-lg transition-all duration-150 cursor-pointer select-none"
        >
            <span className="text-primary-600 dark:text-primary-400 select-all">{ code }</span>
            <span className="text-[10px] text-gray-400 dark:text-gray-500 group-hover/sc:text-primary-500 transition-colors">
                { isCopied ? copied : '⎘' }
            </span>
        </div>
    );
};

const AdminSpinner: React.FC = () => (
    <div className="flex items-center justify-center py-16">
        <div className="w-9 h-9 rounded-full border-4 border-gray-200 dark:border-gray-700 border-t-blue-500 animate-spin" />
    </div>
);

const ProUpgradeBanner: React.FC = () => {
    return (
        <div className="mb-6 p-5 bg-gradient-to-r from-indigo-500 via-purple-500 to-pink-500 rounded-2xl text-white shadow-lg flex flex-col sm:flex-row sm:items-center justify-between gap-4">
            <div>
                <h4 className="text-base font-extrabold flex items-center gap-2 m-0">
                    🚀 JetReader Pro
                </h4>
                <p className="text-xs text-white/90 mt-1 mb-0 max-w-xl">
                    Unlock unlimited uploads, multi-language support, standalone search widgets, custom display layouts, and advanced reader styling by upgrading to JetReader Pro.
                </p>
            </div>
            <a
                href="https://wplector.com"
                target="_blank"
                rel="noopener noreferrer"
                className="shrink-0 inline-flex items-center justify-center bg-white text-indigo-600 hover:bg-indigo-50 font-bold text-xs px-5 py-2.5 rounded-xl transition-all shadow-md active:scale-95 text-center no-underline"
            >
                Upgrade to Pro ➜
            </a>
        </div>
    );
};

const LectorDashboard: React.FC = () => {
    const { t } = useTranslation();
    const isLite = true;
    const isPro  = false;
    const [ stats, setStats ] = React.useState( {
        total_books: 0,
        total_articles: 0,
        total_magazines: 0,
        total_qa: 0,
        total_items: 0,
        total_views: 0,
        total_reads: 0,
    } );

    React.useEffect( () => {
        fetch( `${API_BASE}/dashboard`, {
            headers: { 'X-WP-Nonce': getNonce() },
        } )
            .then( ( res ) => res.json() )
            .then( ( data ) => {
                if ( data && ! data.code ) setStats( data );
            } )
            .catch( ( err ) => dbg( 'dashboard fetch error:', err ) );
    }, [] );

    const statCards = [
        { label: t('dashboard.totalBooks'), value: stats.total_books, iconBg: 'bg-blue-500/10 dark:bg-blue-500/20 text-blue-600 dark:text-blue-400', icon: '📚' },
        { label: t('dashboard.totalArticles'), value: stats.total_articles, iconBg: 'bg-green-500/10 dark:bg-green-500/20 text-green-600 dark:text-green-400', icon: '📄' },
        { label: t('dashboard.totalMagazines'), value: stats.total_magazines, iconBg: 'bg-purple-500/10 dark:bg-purple-500/20 text-purple-600 dark:text-purple-400', icon: '🗞️' },
        { label: t('dashboard.totalQA'), value: stats.total_qa, iconBg: 'bg-orange-500/10 dark:bg-orange-500/20 text-orange-600 dark:text-orange-400', icon: '💬' },
        { label: t('dashboard.totalViews'), value: stats.total_views, iconBg: 'bg-cyan-500/10 dark:bg-cyan-500/20 text-cyan-600 dark:text-cyan-400', icon: '👁️' },
        { label: t('dashboard.totalReads'), value: stats.total_reads, iconBg: 'bg-pink-500/10 dark:bg-pink-500/20 text-pink-600 dark:text-pink-400', icon: '📖' },
    ];

    return (
        <div className="p-6">
            <div className="mb-6">
                <h1 className="text-2xl font-bold text-gray-900 dark:text-white">
                    {t('dashboard.title')}
                </h1>
                <p className="mt-1 text-gray-500 dark:text-gray-400 text-sm">
                    {t('dashboard.welcome')}
                </p>
            </div>

            { ( isLite || !isPro ) && <ProUpgradeBanner /> }

            <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-6 gap-4 mb-6">
                { statCards.map( ( card ) => (
                    <div
                        key={ card.label }
                        className="bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 p-3.5 sm:p-5 flex items-center gap-3 sm:gap-4 hover:shadow-md hover:border-gray-300 dark:hover:border-gray-600 transition-all duration-200"
                    >
                        <div className={`w-10 h-10 sm:w-12 sm:h-12 rounded-xl flex items-center justify-center shrink-0 ${card.iconBg}`}>
                            <span className="text-xl sm:text-2xl">{ card.icon }</span>
                        </div>
                        <div className="min-w-0">
                            <span className="block text-xl sm:text-2xl font-extrabold text-gray-900 dark:text-white tracking-tight leading-none mb-1">
                                { card.value.toLocaleString() }
                            </span>
                            <p className="text-[10px] sm:text-[11px] font-bold text-gray-500 dark:text-gray-400 uppercase tracking-wider leading-tight whitespace-normal break-words">
                                { card.label }
                            </p>
                        </div>
                    </div>
                ) ) }
            </div>

            { /* ── Quick Actions ── */ }
            <div style={{ background:'#fff', borderRadius:'16px', border:'1px solid #e5e7eb', padding:'22px', boxShadow:'0 1px 4px rgba(0,0,0,0.05)' }} className="dark:bg-gray-800 dark:border-gray-700">
                <p style={{ fontSize:'11px', fontWeight:700, letterSpacing:'0.1em', textTransform:'uppercase', color:'#9ca3af', marginBottom:'16px' }}>
                    { t('dashboard.quickActions') }
                </p>
                <div style={{ display:'grid', gridTemplateColumns:'repeat(auto-fill,minmax(150px,1fr))', gap:'12px' }}>
                    { [
                        { page:'jetreader-items',     icon:'📚', label: t('dashboard.manageLibraryItems'), primary:true,  lite:true  },
                        { page:'jetreader-constants', icon:'🏷️', label: t('dashboard.manageCategories'),   primary:false, lite:true  },
                        { page:'jetreader-displays',  icon:'🎨', label: t('dashboard.manageDisplays'),     primary:false, lite:false },
                        { page:'jetreader-settings',  icon:'⚙️', label: t('dashboard.settingsLink'),       primary:false, lite:true  },
                        { page:'jetreader-about',     icon:'💬', label: t('dashboard.supportLink'),         primary:false, lite:true  },
                    ].filter( (action) => !isLite || action.lite ).map( (action) => (
                        <NavLink
                            key={ action.page }
                            page={ action.page }
                            style={{
                                display:'flex', flexDirection:'column', alignItems:'center', justifyContent:'center',
                                gap:'10px', padding:'20px 12px', borderRadius:'14px', textDecoration:'none',
                                textAlign:'center', cursor:'pointer', transition:'all 0.15s',
                                background: action.primary
                                    ? 'linear-gradient(135deg,var(--jr-p600,#4f46e5),var(--jr-p700,#4338ca))'
                                    : '#f9fafb',
                                border: action.primary ? 'none' : '1.5px solid #e5e7eb',
                                color: action.primary ? '#fff' : '#374151',
                                boxShadow: action.primary ? '0 4px 14px rgba(79,70,229,0.25)' : 'none',
                            }}
                        >
                            <span style={{ fontSize:'26px', lineHeight:1 }}>{ action.icon }</span>
                            <span style={{ fontSize:'13px', fontWeight:600, lineHeight:1.4 }}>{ action.label }</span>
                        </NavLink>
                    ) ) }
                </div>
            </div>

            { /* ── Shortcode Guide ── */ }
            <div style={{ marginTop:'24px', background:'#fff', borderRadius:'16px', border:'1px solid #e5e7eb', overflow:'hidden', boxShadow:'0 1px 4px rgba(0,0,0,0.05)' }} className="dark:bg-gray-800 dark:border-gray-700">

                { /* Header */ }
                <div style={{ background:'linear-gradient(135deg,var(--jr-p600,#4f46e5),var(--jr-p800,#3730a3))', padding:'22px 26px' }}>
                    <h2 style={{ fontSize:'18px', fontWeight:700, color:'#fff', margin:0, display:'flex', alignItems:'center', gap:'8px' }}>
                        📋 { t('dashboard.shortcodeGuideTitle') }
                    </h2>
                    <p style={{ fontSize:'14px', color:'rgba(255,255,255,0.75)', marginTop:'5px', marginBottom:0 }}>
                        { t('dashboard.shortcodeGuideDesc') }
                    </p>
                </div>

                { /* Shortcode rows */ }
                <div>
                    { [
                        { code:'[jetreader_library]',                       label: t('dashboard.scLibraryLabel'),      desc: t('dashboard.scLibraryDesc'),      badge:'⭐',  liteVisible:true  },
                        { code:'[jetreader_library type="book"]',           label: t('dashboard.scLibraryBooksLabel'), desc: t('dashboard.scLibraryBooksDesc'), badge:'📚', liteVisible:true  },
                        { code:'[jetreader_library types="book,magazine"]', label: t('dashboard.scLibraryTypesLabel'), desc: t('dashboard.scLibraryTypesDesc'), badge:'🗂️', liteVisible:true  },
                        { code:'[jetreader_search]',                        label: t('dashboard.scSearchLabel'),       desc: t('dashboard.scSearchDesc'),       badge:'🔍', isPremium:true,    liteVisible:false },
                        { code:'[jetreader_featured]',                      label: t('dashboard.scFeaturedLabel'),     desc: t('dashboard.scFeaturedDesc'),     badge:'✨',  liteVisible:true  },
                    ].filter( ( sc ) => !isLite || sc.liteVisible ).map( ( sc, i, arr ) => (
                        <div
                            key={ sc.code }
                            style={{ borderBottom: i < arr.length - 1 ? '1px solid #f3f4f6' : 'none', padding:'16px 22px' }}
                            className="hover:bg-gray-50 dark:hover:bg-gray-750 transition-colors dark:border-gray-700/60"
                        >
                            { /* Top row: badge icon + label + pro lock */ }
                            <div style={{ display:'flex', alignItems:'center', gap:'10px', marginBottom:'10px' }}>
                                <div style={{ width:'38px', height:'38px', borderRadius:'10px', background:'#f3f4f6', display:'flex', alignItems:'center', justifyContent:'center', flexShrink:0, fontSize:'20px' }}
                                     className="dark:bg-gray-700">
                                    { sc.badge }
                                </div>
                                <div>
                                    <div style={{ display:'flex', alignItems:'center', gap:'6px' }}>
                                        <span style={{ fontSize:'15px', fontWeight:700, color:'#111827' }} className="dark:text-white">
                                            { sc.label }
                                        </span>
                                        { sc.isPremium && !isPro && <PremiumLockIcon className="w-4 h-4" /> }
                                    </div>
                                    <span style={{ fontSize:'13px', color:'#6b7280', lineHeight:1.5 }} className="dark:text-gray-400">
                                        { sc.desc }
                                    </span>
                                </div>
                            </div>
                            { /* Bottom row: code chip — always full width on its own line */ }
                            <div style={{ paddingLeft:'48px' }}>
                                <ShortcodeChip
                                    code={ sc.code }
                                    hint={ t('dashboard.scCopyHint') }
                                    copied={ t('dashboard.scCopied') }
                                />
                            </div>
                        </div>
                    ) ) }

                    { /* Grid & Slider CTA — Pro only */ }
                    { !isLite && (
                    <div style={{ padding:'18px 22px', background:'linear-gradient(135deg,rgba(79,70,229,0.04),rgba(99,102,241,0.08))', borderTop:'1px solid #ede9fe' }}>
                        <div style={{ display:'flex', alignItems:'flex-start', gap:'12px', flexWrap:'wrap' }}>
                            <div style={{ width:'38px', height:'38px', borderRadius:'10px', background:'rgba(79,70,229,0.1)', display:'flex', alignItems:'center', justifyContent:'center', flexShrink:0, fontSize:'20px' }}>
                                🎨
                            </div>
                            <div style={{ flex:1, minWidth:'160px' }}>
                                <span style={{ fontSize:'15px', fontWeight:700, color:'#111827', display:'block' }} className="dark:text-white">
                                    { t('dashboard.scGridSliderLabel') }
                                </span>
                                <span style={{ fontSize:'13px', color:'#6b7280', display:'block', marginTop:'3px' }} className="dark:text-gray-400">
                                    { t('dashboard.scGridSliderDesc') }
                                </span>
                            </div>
                            <NavLink page="jetreader-displays" className="jr-btn-primary" style={{ flexShrink:0, fontSize:'13px', padding:'10px 18px', whiteSpace:'nowrap', alignSelf:'center' }}>
                                { t('dashboard.scGoToDisplays') }
                            </NavLink>
                        </div>
                    </div>
                    ) }
                </div>
            </div>
        </div>
    );
};

/* ------------------------------------------------------------------ */
/*  ItemsPage – full CRUD                                              */
/* ------------------------------------------------------------------ */


const FORMATS_ADMIN = [ 'epub', 'pdf', 'txt', 'docx' ];

interface AdminFilters {
    author: string;
    file_type: string;
    visibility: string;
    featured: string;
    view_min: string;
    view_max: string;
    has_volumes: boolean;
    category_id: string;
}

const DEFAULT_ADMIN_FILTERS: AdminFilters = {
    author: '', file_type: '', visibility: '', featured: '',
    view_min: '', view_max: '', has_volumes: false, category_id: '',
};

interface BulkEditForm {
    visibility: string;
    featured: string;
    language: string;
    author: string;
    authorChanged: boolean;
    publisher: string;
    publisherChanged: boolean;
    translator: string;
    translatorChanged: boolean;
    publication_year: string;
    publication_yearChanged: boolean;
    type: string;
    typeChanged: boolean;
    categoryIds: number[];
    categoryChanged: boolean;
}

/* ------------------------------------------------------------------ */
/*  BulkAddModal – add multiple items in one go                        */
/* ------------------------------------------------------------------ */

interface BulkAddItem {
    title: string;
    category_id: string;
    author: string;
    translator: string;
    publisher: string;
    publication_year: string;
    description: string;
    visibility: string;
    featured: boolean;
    cover_image: string;
    file_path: string;
    file_type: string;
}

const EMPTY_BULK_ITEM: BulkAddItem = {
    title: '', category_id: '', author: '', translator: '', publisher: '',
    publication_year: '', description: '', visibility: 'publish',
    featured: false, cover_image: '', file_path: '', file_type: '',
};

interface BulkAddModalProps {
    isOpen: boolean;
    onClose: () => void;
    onSaved: () => void;
    flashMessage: ( msg: string ) => void;
}

const BulkAddModal: React.FC<BulkAddModalProps> = ( { isOpen, onClose, onSaved, flashMessage } ) => {
    const { t } = useTranslation();
    const [ activeType, setActiveType ] = useState<string>( 'book' );
    const [ rows, setRows ] = useState<BulkAddItem[]>( [ { ...EMPTY_BULK_ITEM } ] );
    const [ saving, setSaving ] = useState( false );
    const [ pendingType, setPendingType ] = useState<string | null>( null );
    const [ pendingClose, setPendingClose ] = useState( false );

    const TYPE_SVG: Record<string, React.ReactNode> = {
        book: (
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/>
                <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/>
            </svg>
        ),
        article: (
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
                <polyline points="14 2 14 8 20 8"/>
                <line x1="16" y1="13" x2="8" y2="13"/>
                <line x1="16" y1="17" x2="8" y2="17"/>
            </svg>
        ),
        magazine: (
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M4 22h16a2 2 0 0 0 2-2V4a2 2 0 0 0-2-2H8a2 2 0 0 0-2 2v16a2 2 0 0 1-2 2zm0 0a2 2 0 0 1-2-2v-9c0-1.1.9-2 2-2h2"/>
                <path d="M18 14h-8M18 18h-8M16 6H10v4h6V6z"/>
            </svg>
        ),
        qa: (
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
            </svg>
        )
    };

    const bulkTypeTabs = [
        { key: 'book',     label: t( 'items.typeTabsBooks' ),     icon: TYPE_SVG.book },
        { key: 'article',  label: t( 'items.typeTabsArticles' ),  icon: TYPE_SVG.article },
        { key: 'magazine', label: t( 'items.typeTabsMagazines' ), icon: TYPE_SVG.magazine },
        { key: 'qa',       label: t( 'items.typeTabsQA' ),        icon: TYPE_SVG.qa },
    ];

    const { data: bulkCategories = [] } = useQuery<CategoryExtended[]>( {
        queryKey: [ 'categories', 'bulk', activeType ],
        queryFn: async () => {
            const res = await fetch( `${API_BASE}/categories?type=${ encodeURIComponent( activeType ) }`, {
                headers: { 'X-WP-Nonce': getNonce() },
            } );
            const json = await res.json();
            return Array.isArray( json ) ? json : [];
        },
        enabled: isOpen,
    } );

    const { data: bulkAuthors = [] } = useQuery<SimpleRecord[]>( {
        queryKey: [ 'authors', 'bulk' ],
        queryFn: async () => {
            const res = await fetch( `${API_BASE}/authors`, { headers: { 'X-WP-Nonce': getNonce() } } );
            const json = await res.json();
            return Array.isArray( json ) ? json : [];
        },
        enabled: isOpen,
    } );

    const { data: bulkPublishers = [] } = useQuery<SimpleRecord[]>( {
        queryKey: [ 'publishers', 'bulk' ],
        queryFn: async () => {
            const res = await fetch( `${API_BASE}/publishers`, { headers: { 'X-WP-Nonce': getNonce() } } );
            const json = await res.json();
            return Array.isArray( json ) ? json : [];
        },
        enabled: isOpen,
    } );

    const hasUnsavedData = rows.some( ( row ) =>
        row.title.trim() !== '' ||
        row.author.trim() !== '' ||
        row.translator.trim() !== '' ||
        row.publisher.trim() !== '' ||
        row.publication_year.trim() !== '' ||
        row.description.trim() !== '' ||
        row.cover_image.trim() !== '' ||
        row.file_path.trim() !== '' ||
        row.category_id !== '' ||
        row.file_type !== '' ||
        row.featured ||
        row.visibility !== 'publish'
    );

    const handleTypeChange = ( type: string ) => {
        setActiveType( type );
        setRows( [ { ...EMPTY_BULK_ITEM } ] );
        setPendingType( null );
        setPendingClose( false );
    };

    const onTabClick = ( key: string ) => {
        if ( key === activeType ) return;
        if ( hasUnsavedData ) {
            setPendingType( key );
            setPendingClose( false );
        } else {
            handleTypeChange( key );
        }
    };

    const onCloseRequest = () => {
        if ( hasUnsavedData ) {
            setPendingClose( true );
            setPendingType( null );
        } else {
            onClose();
        }
    };

    const addRow = () => setRows( ( prev ) => [ ...prev, { ...EMPTY_BULK_ITEM } ] );

    const removeRow = ( idx: number ) => {
        if ( rows.length <= 1 ) return;
        setRows( ( prev ) => prev.filter( ( _, i ) => i !== idx ) );
    };

    const updateRow = ( idx: number, field: keyof BulkAddItem, value: string | boolean ) => {
        setRows( ( prev ) => prev.map( ( row, i ) => i === idx ? { ...row, [ field ]: value } : row ) );
    };

    const copyFieldToAll = ( idx: number, field: keyof BulkAddItem ) => {
        const value = rows[ idx ][ field ];
        setRows( ( prev ) => prev.map( ( row, i ) => i === idx ? row : { ...row, [ field ]: value } ) );
    };

    const duplicateRow = ( idx: number ) => {
        setRows( ( prev ) => [
            ...prev.slice( 0, idx + 1 ),
            { ...prev[ idx ] },
            ...prev.slice( idx + 1 ),
        ] );
    };

    const handleSave = async () => {
        const validRows = rows.filter( ( r ) => r.title.trim() );
        if ( validRows.length === 0 ) {
            flashMessage( t( 'items.addItemError' ) );
            return;
        }
        setSaving( true );
        let ok = 0, fail = 0;
        for ( const row of validRows ) {
            try {
                const payload: Record<string, unknown> = {
                    type:         activeType,
                    title:        row.title.trim(),
                    visibility:   row.visibility || 'publish',
                    featured:     row.featured,
                    category_ids: row.category_id ? [ Number( row.category_id ) ] : [],
                    description:  row.description,
                };
                if ( activeType !== 'qa' ) {
                    payload.author           = row.author;
                    payload.translator       = row.translator;
                    payload.publisher        = row.publisher;
                    payload.publication_year = parseInt( row.publication_year, 10 ) || null;
                    payload.cover_image      = row.cover_image;
                    payload.file_path        = row.file_path;
                    payload.file_type        = row.file_type;
                    payload.volumes          = [ { vol: 1, file_path: row.file_path, file_type: row.file_type, cover_image: row.cover_image } ];
                }
                const res = await fetch( `${API_BASE}/items`, {
                    method:  'POST',
                    headers: { 'Content-Type': 'application/json', 'X-WP-Nonce': getNonce() },
                    body:    JSON.stringify( payload ),
                } );
                const json = await res.json();
                json.code ? fail++ : ok++;
            } catch { fail++; }
        }
        setSaving( false );
        flashMessage(
            fail === 0
                ? t( 'items.bulkAddSuccess', { N: String( ok ) } )
                : t( 'items.bulkAddPartial', { OK: String( ok ), FAIL: String( fail ) } )
        );
        onSaved();
        onClose();
        setRows( [ { ...EMPTY_BULK_ITEM } ] );
        setActiveType( 'book' );
    };

    if ( ! isOpen ) return null;

    const isQA      = activeType === 'qa';
    const fileTypes = [ 'epub', 'pdf', 'txt', 'docx' ];
    const canCopy   = rows.length > 1;

    const CopyToAll = ( { idx, field }: { idx: number; field: keyof BulkAddItem } ) => (
        <button
            type="button"
            onClick={ () => copyFieldToAll( idx, field ) }
            disabled={ ! canCopy }
            title={ t( 'admin.copyAll' ) }
            className="shrink-0 p-2 rounded-xl text-gray-400 hover:text-blue-500 hover:bg-blue-50 dark:hover:bg-blue-900/30 disabled:opacity-20 disabled:cursor-not-allowed transition-all active:scale-95 border border-transparent hover:border-blue-200 dark:hover:border-blue-800 bg-transparent flex items-center justify-center w-9 h-9"
        >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <rect x="9" y="9" width="13" height="13" rx="2"/>
                <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>
            </svg>
        </button>
    );

    return (
        <AnimatePresence>
            <motion.div
                initial={ { opacity: 0 } }
                animate={ { opacity: 1 } }
                exit={ { opacity: 0 } }
                className="fixed inset-0 bg-black/50 z-50 flex items-start justify-center pt-6 p-4 overflow-y-auto"
                onClick={ onCloseRequest }
            >
                <motion.div
                    initial={ { scale: 0.95, opacity: 0, y: 20 } }
                    animate={ { scale: 1, opacity: 1, y: 0 } }
                    exit={ { scale: 0.95, opacity: 0, y: 20 } }
                    className="bg-white dark:bg-gray-800 rounded-2xl shadow-2xl w-full max-w-5xl mb-6 border border-gray-100 dark:border-gray-700/60 overflow-hidden"
                    onClick={ ( e ) => e.stopPropagation() }
                >
                    {/* Header */}
                    <div className="flex items-center justify-between px-6 pt-5 pb-4 border-b border-gray-200 dark:border-gray-700 bg-gray-50/50 dark:bg-gray-900/10">
                        <div className="flex items-center gap-2.5">
                            <span className="p-2 bg-blue-50 dark:bg-blue-900/30 text-blue-600 dark:text-blue-400 rounded-xl shadow-sm">
                                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                                    <path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/>
                                    <rect x="8" y="2" width="8" height="4" rx="1" ry="1"/>
                                </svg>
                            </span>
                            <div>
                                <h2 className="text-lg font-bold text-gray-900 dark:text-white leading-tight">{ t( 'items.bulkAddTitle' ) }</h2>
                                <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">{ t( 'items.bulkAddSubtitle' ) || 'Add multiple items to your library in one go' }</p>
                            </div>
                        </div>
                        <button onClick={ onCloseRequest } className="p-2 hover:bg-gray-150 dark:hover:bg-gray-700/60 rounded-xl transition-all text-gray-500 dark:text-gray-400 active:scale-95">✕</button>
                    </div>

                    {/* Type tabs */}
                    <div className="flex gap-1 px-6 pt-3 border-b border-gray-200 dark:border-gray-700 overflow-x-auto bg-white dark:bg-gray-800">
                        { bulkTypeTabs.map( ( tab ) => (
                            <button
                                key={ tab.key }
                                onClick={ () => onTabClick( tab.key ) }
                                className={ `flex items-center gap-1.5 px-4 py-2 text-sm font-medium border-b-2 transition-colors -mb-px whitespace-nowrap ${
                                    activeType === tab.key
                                        ? 'border-blue-500 text-blue-600 dark:text-blue-400'
                                        : 'border-transparent text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200'
                                }` }
                            >
                                <span className="shrink-0">{ tab.icon }</span>
                                <span>{ tab.label }</span>
                            </button>
                        ) ) }
                    </div>

                    {/* Confirmation banner — tab change or close */}
                    { ( pendingType || pendingClose ) && (
                        <div className="px-6 py-3 bg-amber-50 dark:bg-amber-900/30 border-b border-amber-200 dark:border-amber-700 flex items-center justify-between gap-3 animate-fade-in">
                            <p className="text-sm text-amber-800 dark:text-amber-300">
                                { pendingClose
                                    ? t( 'items.bulkCloseWarning' )
                                    : t( 'items.bulkTabChangeWarning' ) }
                            </p>
                            <div className="flex gap-2 shrink-0">
                                <button
                                    type="button"
                                    onClick={ () => { setPendingType( null ); setPendingClose( false ); } }
                                    className="px-3 py-1.5 text-xs rounded-lg bg-white dark:bg-gray-800 border border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700 transition-colors"
                                >
                                    { t( 'items.bulkTabChangeCancel' ) }
                                </button>
                                <button
                                    type="button"
                                    onClick={ () => pendingClose ? onClose() : handleTypeChange( pendingType! ) }
                                    className="px-3 py-1.5 text-xs rounded-lg bg-amber-600 text-white hover:bg-amber-700 transition-colors"
                                >
                                    { pendingClose
                                        ? t( 'items.bulkCloseConfirm' )
                                        : t( 'items.bulkTabChangeContinue' ) }
                                </button>
                            </div>
                        </div>
                    ) }

                    {/* Rows – scrollable */}
                    <div className="px-6 py-5 space-y-4 max-h-[55vh] overflow-y-auto bg-gray-50/30 dark:bg-gray-900/5">
                        { rows.map( ( row, idx ) => (
                            <div key={ idx } className="bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 p-4 space-y-4 shadow-sm hover:border-gray-300 dark:hover:border-gray-650 transition-all duration-200">
                                {/* Row Header */}
                                <div className="flex items-center justify-between border-b border-gray-150 dark:border-gray-700/60 pb-2.5">
                                    <div className="flex items-center gap-2">
                                        <span className="flex items-center justify-center w-6 h-6 rounded-full bg-blue-50 dark:bg-blue-900/40 text-blue-600 dark:text-blue-400 text-xs font-bold shadow-sm">{ idx + 1 }</span>
                                        <span className="text-sm font-semibold text-gray-700 dark:text-gray-300">
                                            { activeType === 'book' ? t( 'itemForm.typeBook' ) : activeType === 'article' ? t( 'itemForm.typeArticle' ) : activeType === 'magazine' ? t( 'itemForm.typeMagazine' ) : t( 'itemForm.typeQA' ) } #{ idx + 1 }
                                        </span>
                                    </div>
                                    <div className="flex items-center gap-2">
                                        {/* Duplicate row */}
                                        <button
                                            type="button"
                                            onClick={ () => duplicateRow( idx ) }
                                            title={ t( 'admin.duplicateRow' ) }
                                            className="w-8 h-8 flex items-center justify-center rounded-lg text-gray-500 dark:text-gray-400 hover:text-indigo-500 hover:bg-indigo-50 dark:hover:bg-indigo-900/20 transition-all active:scale-95 border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 shadow-sm"
                                        >
                                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                                                <rect x="9" y="9" width="13" height="13" rx="2"/>
                                                <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>
                                            </svg>
                                        </button>
                                        {/* Remove row */}
                                        <button
                                            type="button"
                                            onClick={ () => removeRow( idx ) }
                                            disabled={ rows.length <= 1 }
                                            className="w-8 h-8 flex items-center justify-center rounded-lg text-gray-500 dark:text-gray-400 hover:text-red-500 hover:bg-red-50 dark:hover:bg-red-900/20 disabled:opacity-30 disabled:cursor-not-allowed transition-all active:scale-95 border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 shadow-sm text-sm"
                                        >✕</button>
                                    </div>
                                </div>

                                { isQA ? (
                                    /* Q&A Simple Fields Grid */
                                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                                        {/* Title */}
                                        <div className="md:col-span-2 space-y-1">
                                            <label className="block text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide">
                                                { t( 'itemForm.titleRequired' ) } <span className="text-red-500">*</span>
                                            </label>
                                            <div className="flex items-center gap-1.5">
                                                <input
                                                    type="text"
                                                    value={ row.title }
                                                    onChange={ ( e ) => updateRow( idx, 'title', e.target.value ) }
                                                    placeholder={ t( 'itemForm.titleRequired' ) }
                                                    className="jr-input flex-1 text-sm min-w-0"
                                                />
                                                <CopyToAll idx={ idx } field="title" />
                                            </div>
                                        </div>

                                        {/* Category */}
                                        <div className="space-y-1">
                                            <label className="block text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide">
                                                { t( 'itemForm.categoryLabel' ) }
                                            </label>
                                            <div className="flex items-center gap-1.5">
                                                <select
                                                    value={ row.category_id }
                                                    onChange={ ( e ) => updateRow( idx, 'category_id', e.target.value ) }
                                                    className="jr-input text-sm w-full"
                                                >
                                                    <option value="">— { t( 'itemForm.categoryLabel' ) } —</option>
                                                    { bulkCategories.map( ( c ) => (
                                                        <option key={ c.id } value={ String( c.id ) }>{ c.name }</option>
                                                    ) ) }
                                                </select>
                                                <CopyToAll idx={ idx } field="category_id" />
                                            </div>
                                        </div>

                                        {/* Visibility */}
                                        <div className="space-y-1">
                                            <label className="block text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide">
                                                { t( 'itemForm.visibilityLabel' ) }
                                            </label>
                                            <div className="flex items-center gap-1.5">
                                                <select value={ row.visibility } onChange={ ( e ) => updateRow( idx, 'visibility', e.target.value ) } className="jr-input text-sm w-full">
                                                    <option value="publish">{ t( 'itemForm.visibilityPublish' ) }</option>
                                                    <option value="draft">{ t( 'itemForm.visibilityDraft' ) }</option>
                                                    <option value="private">{ t( 'itemForm.visibilityPrivate' ) }</option>
                                                </select>
                                                <CopyToAll idx={ idx } field="visibility" />
                                            </div>
                                        </div>

                                        {/* Featured */}
                                        <div className="flex items-center justify-between border border-gray-250 dark:border-gray-700 bg-gray-50/50 dark:bg-gray-900/10 rounded-xl px-3.5 py-2 hover:border-gray-300 dark:hover:border-gray-650 transition-colors">
                                            <label className="flex items-center gap-2.5 text-xs font-semibold text-gray-655 dark:text-gray-400 uppercase tracking-wide cursor-pointer select-none">
                                                <input type="checkbox" checked={ row.featured } onChange={ ( e ) => updateRow( idx, 'featured', e.target.checked ) } className="rounded accent-blue-600 w-4 h-4" />
                                                <span>{ t( 'itemForm.featuredLabel' ) }</span>
                                            </label>
                                            <CopyToAll idx={ idx } field="featured" />
                                        </div>

                                        {/* Description */}
                                        <div className="md:col-span-2 space-y-1">
                                            <label className="block text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide">
                                                { t( 'itemForm.descriptionPlaceholder' ) }
                                            </label>
                                            <div className="flex items-start gap-1.5">
                                                <textarea value={ row.description } onChange={ ( e ) => updateRow( idx, 'description', e.target.value ) } placeholder={ t( 'itemForm.descriptionPlaceholder' ) } className="jr-input w-full text-sm" rows={ 2 } />
                                                <CopyToAll idx={ idx } field="description" />
                                            </div>
                                        </div>
                                    </div>
                                ) : (
                                    /* Books, Articles, Magazines Standard Fields Grid */
                                    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                                        {/* Title */}
                                        <div className="md:col-span-2 space-y-1">
                                            <label className="block text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide">
                                                { t( 'itemForm.titleRequired' ) } <span className="text-red-500">*</span>
                                            </label>
                                            <div className="flex items-center gap-1.5">
                                                <input
                                                    type="text"
                                                    value={ row.title }
                                                    onChange={ ( e ) => updateRow( idx, 'title', e.target.value ) }
                                                    placeholder={ t( 'itemForm.titleRequired' ) }
                                                    className="jr-input flex-1 text-sm min-w-0"
                                                />
                                                <CopyToAll idx={ idx } field="title" />
                                            </div>
                                        </div>

                                        {/* Category */}
                                        <div className="space-y-1">
                                            <label className="block text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide">
                                                { t( 'itemForm.categoryLabel' ) }
                                            </label>
                                            <div className="flex items-center gap-1.5">
                                                <select
                                                    value={ row.category_id }
                                                    onChange={ ( e ) => updateRow( idx, 'category_id', e.target.value ) }
                                                    className="jr-input text-sm w-full"
                                                >
                                                    <option value="">— { t( 'itemForm.categoryLabel' ) } —</option>
                                                    { bulkCategories.map( ( c ) => (
                                                        <option key={ c.id } value={ String( c.id ) }>{ c.name }</option>
                                                    ) ) }
                                                </select>
                                                <CopyToAll idx={ idx } field="category_id" />
                                            </div>
                                        </div>

                                        {/* Author */}
                                        <div className="space-y-1">
                                            <label className="block text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide">
                                                { t( 'items.authorLabel' ) }
                                            </label>
                                            <div className="flex items-center gap-1.5">
                                                { bulkAuthors.length > 0 ? (
                                                    <select value={ row.author } onChange={ ( e ) => updateRow( idx, 'author', e.target.value ) } className="jr-input text-sm w-full">
                                                        <option value="">{ t( 'itemForm.selectAuthor' ) }</option>
                                                        { bulkAuthors.map( ( a ) => <option key={ a.id } value={ a.name }>{ a.name }</option> ) }
                                                    </select>
                                                ) : (
                                                    <span className="jr-input text-xs text-gray-400 w-full flex items-center gap-1 opacity-50 select-none">
                                                        { t( 'itemForm.noAuthorWarning' ) }{ ' ' }
                                                        <NavLink page="jetreader-constants" className="text-blue-500 underline">{ t( 'itemForm.goToConstants' ) }</NavLink>
                                                    </span>
                                                ) }
                                                <CopyToAll idx={ idx } field="author" />
                                            </div>
                                        </div>

                                        {/* Publisher */}
                                        <div className="space-y-1">
                                            <label className="block text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide">
                                                { t( 'itemForm.publisherLabel' ) }
                                            </label>
                                            <div className="flex items-center gap-1.5">
                                                { bulkPublishers.length > 0 ? (
                                                    <select value={ row.publisher } onChange={ ( e ) => updateRow( idx, 'publisher', e.target.value ) } className="jr-input text-sm w-full">
                                                        <option value="">{ t( 'itemForm.selectPublisher' ) }</option>
                                                        { bulkPublishers.map( ( p ) => <option key={ p.id } value={ p.name }>{ p.name }</option> ) }
                                                    </select>
                                                ) : (
                                                    <span className="jr-input text-xs text-gray-400 w-full flex items-center gap-1 opacity-50 select-none">
                                                        { t( 'itemForm.noPublisherWarning' ) }{ ' ' }
                                                        <NavLink page="jetreader-constants" className="text-blue-500 underline">{ t( 'itemForm.goToConstants' ) }</NavLink>
                                                    </span>
                                                ) }
                                                <CopyToAll idx={ idx } field="publisher" />
                                            </div>
                                        </div>

                                        {/* Translator */}
                                        <div className="space-y-1">
                                            <label className="block text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide">
                                                { t( 'itemForm.translatorLabel' ) }
                                            </label>
                                            <div className="flex items-center gap-1.5">
                                                <input
                                                    type="text"
                                                    value={ row.translator }
                                                    onChange={ ( e ) => updateRow( idx, 'translator', e.target.value ) }
                                                    placeholder={ t( 'itemForm.translatorPlaceholder' ) }
                                                    className="jr-input text-sm w-full"
                                                />
                                                <CopyToAll idx={ idx } field="translator" />
                                            </div>
                                        </div>

                                        {/* Year */}
                                        <div className="space-y-1">
                                            <label className="block text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide">
                                                { t( 'itemForm.yearLabel' ) }
                                            </label>
                                            <div className="flex items-center gap-1.5">
                                                <input type="number" value={ row.publication_year } onChange={ ( e ) => updateRow( idx, 'publication_year', e.target.value ) } placeholder={ t( 'itemForm.yearLabel' ) } className="jr-input text-sm w-full" />
                                                <CopyToAll idx={ idx } field="publication_year" />
                                            </div>
                                        </div>

                                        {/* Visibility */}
                                        <div className="space-y-1">
                                            <label className="block text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide">
                                                { t( 'itemForm.visibilityLabel' ) }
                                            </label>
                                            <div className="flex items-center gap-1.5">
                                                <select value={ row.visibility } onChange={ ( e ) => updateRow( idx, 'visibility', e.target.value ) } className="jr-input text-sm w-full">
                                                    <option value="publish">{ t( 'itemForm.visibilityPublish' ) }</option>
                                                    <option value="draft">{ t( 'itemForm.visibilityDraft' ) }</option>
                                                    <option value="private">{ t( 'itemForm.visibilityPrivate' ) }</option>
                                                </select>
                                                <CopyToAll idx={ idx } field="visibility" />
                                            </div>
                                        </div>

                                        {/* File Type */}
                                        <div className="space-y-1">
                                            <label className="block text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide">
                                                { t( 'itemForm.fileTypeLabel' ) || 'File Type' }
                                            </label>
                                            <div className="flex items-center gap-1.5">
                                                <select value={ row.file_type } onChange={ ( e ) => updateRow( idx, 'file_type', e.target.value ) } className="jr-input text-sm w-full">
                                                    <option value="">{ t( 'itemForm.fileTypeSelect' ) }</option>
                                                    { fileTypes.map( ( f ) => <option key={ f } value={ f }>{ f.toUpperCase() }</option> ) }
                                                </select>
                                                <CopyToAll idx={ idx } field="file_type" />
                                            </div>
                                        </div>

                                        {/* Cover Image */}
                                        <div className="space-y-1">
                                            <label className="block text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide">
                                                { t( 'itemForm.coverImageLabel' ) || 'Cover Image' }
                                            </label>
                                            <div className="flex items-center gap-1.5">
                                                <div className="flex items-center gap-1 flex-1 min-w-0">
                                                    <input type="text" value={ row.cover_image } onChange={ ( e ) => updateRow( idx, 'cover_image', e.target.value ) } placeholder={ t( 'itemForm.coverImagePlaceholder' ) } className="jr-input text-sm flex-1 min-w-0" />
                                                    <WpMediaButton imageOnly title={ t( 'itemForm.browseMedia' ) } onSelect={ ( url ) => updateRow( idx, 'cover_image', url ) } />
                                                </div>
                                                <CopyToAll idx={ idx } field="cover_image" />
                                            </div>
                                        </div>

                                        {/* File Path */}
                                        <div className="space-y-1">
                                            <label className="block text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide">
                                                { t( 'itemForm.filePathLabel' ) || 'File Path' }
                                            </label>
                                            <div className="flex items-center gap-1.5">
                                                <div className="flex items-center gap-1 flex-1 min-w-0">
                                                    <input type="text" value={ row.file_path } onChange={ ( e ) => updateRow( idx, 'file_path', e.target.value ) } placeholder={ t( 'itemForm.filePathPlaceholder' ) } className="jr-input text-sm flex-1 min-w-0" />
                                                    <WpMediaButton title={ t( 'itemForm.browseMedia' ) } onSelect={ ( url ) => updateRow( idx, 'file_path', url ) } />
                                                </div>
                                                <CopyToAll idx={ idx } field="file_path" />
                                            </div>
                                        </div>

                                        {/* Featured */}
                                        <div className="flex items-center justify-between border border-gray-250 dark:border-gray-700 bg-gray-50/50 dark:bg-gray-900/10 rounded-xl px-3.5 py-2 hover:border-gray-300 dark:hover:border-gray-650 transition-colors mt-5">
                                            <label className="flex items-center gap-2.5 text-xs font-semibold text-gray-650 dark:text-gray-450 uppercase tracking-wide cursor-pointer select-none">
                                                <input type="checkbox" checked={ row.featured } onChange={ ( e ) => updateRow( idx, 'featured', e.target.checked ) } className="rounded accent-blue-600 w-4 h-4" />
                                                <span>{ t( 'itemForm.featuredLabel' ) }</span>
                                            </label>
                                            <CopyToAll idx={ idx } field="featured" />
                                        </div>

                                        {/* Description */}
                                        <div className="md:col-span-2 lg:col-span-3 space-y-1">
                                            <label className="block text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide">
                                                { t( 'itemForm.descriptionPlaceholder' ) }
                                            </label>
                                            <div className="flex items-start gap-1.5">
                                                <textarea value={ row.description } onChange={ ( e ) => updateRow( idx, 'description', e.target.value ) } placeholder={ t( 'itemForm.descriptionPlaceholder' ) } className="jr-input w-full text-sm" rows={ 2 } />
                                                <CopyToAll idx={ idx } field="description" />
                                            </div>
                                        </div>
                                    </div>
                                ) }
                            </div>
                        ) ) }
                    </div>

                    {/* Footer */}
                    <div className="flex items-center justify-between px-6 py-4 border-t border-gray-200 dark:border-gray-700 bg-gray-50/50 dark:bg-gray-900/10">
                        <button
                            onClick={ addRow }
                            className="px-4 py-2.5 text-sm bg-blue-50 hover:bg-blue-100 text-blue-700 dark:bg-blue-900/20 dark:hover:bg-blue-900/35 dark:text-blue-300 font-semibold rounded-xl transition-all duration-150 active:scale-95 flex items-center gap-1.5 border border-blue-100 dark:border-blue-800/40"
                        >
                            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                                <line x1="12" y1="5" x2="12" y2="19"/>
                                <line x1="5" y1="12" x2="19" y2="12"/>
                            </svg>
                            { t( 'items.bulkAddAddRow' ) }
                        </button>
                        <div className="flex gap-3">
                            <button onClick={ onCloseRequest } className="jr-btn-secondary text-sm">
                                { t( 'common.cancel' ) }
                            </button>
                            <button onClick={ handleSave } disabled={ saving } className="jr-btn-primary text-sm flex items-center gap-1.5">
                                { saving && (
                                    <svg className="animate-spin -ml-1 mr-1.5 h-4 w-4 text-white" fill="none" viewBox="0 0 24 24" aria-hidden="true">
                                        <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                                        <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                                    </svg>
                                ) }
                                <span>{ saving ? t( 'items.bulkSaving' ) : t( 'items.bulkAddSave' ) }</span>
                            </button>
                        </div>
                    </div>
                </motion.div>
            </motion.div>
        </AnimatePresence>
    );
};

const ItemsPage: React.FC = () => {
    const { t, locale } = useTranslation();
    const queryClient = useQueryClient();
    const isLite = true;

    const typeTabs = [
        { key: '',         label: t( 'items.typeTabsAll' ),       icon: '📋' },
        { key: 'book',     label: t( 'items.typeTabsBooks' ),     icon: '📚' },
        { key: 'article',  label: t( 'items.typeTabsArticles' ),  icon: '📄' },
        { key: 'magazine', label: t( 'items.typeTabsMagazines' ), icon: '🗞️' },
        { key: 'qa',       label: t( 'items.typeTabsQA' ),        icon: '💬' },
    ];

    const typeLabel = ( type: string ) => ( ( {
        book:     t( 'itemForm.typeBook' ),
        article:  t( 'itemForm.typeArticle' ),
        magazine: t( 'itemForm.typeMagazine' ),
        qa:       t( 'itemForm.typeQA' ),
    } as Record<string, string> )[ type ] ?? type );

    const visibilityLabel = ( v: string ) => ( ( {
        publish: t( 'itemForm.visibilityPublish' ),
        draft:   t( 'itemForm.visibilityDraft' ),
        private: t( 'itemForm.visibilityPrivate' ),
    } as Record<string, string> )[ v ] ?? v );
    const [ page, setPage ] = useState( 1 );
    const [ typeFilter, setTypeFilter ] = useState( '' );
    const [ searchTerm, setSearchTerm ] = useState( '' );
    const [ editingItem, setEditingItem ] = useState<LibraryItem | null>( null );
    const [ creating, setCreating ] = useState( false );
    const [ deleteConfirm, setDeleteConfirm ] = useState<number | null>( null );
    const [ message, setMessage ] = useState( '' );

    // Filter panel
    const [ filterOpen, setFilterOpen ] = useState( false );
    const [ pendingFilters, setPendingFilters ] = useState<AdminFilters>( DEFAULT_ADMIN_FILTERS );
    const [ activeFilters, setActiveFilters ] = useState<AdminFilters>( DEFAULT_ADMIN_FILTERS );

    // Bulk selection
    const [ selectedIds, setSelectedIds ] = useState<Set<number>>( new Set() );
    const [ bulkAdding, setBulkAdding ] = useState( false );
    const [ bulkEditOpen, setBulkEditOpen ] = useState( false );
    const [ bulkDeleteConfirm, setBulkDeleteConfirm ] = useState( false );
    const [ bulkSaving, setBulkSaving ] = useState( false );
    const [ bulkForm, setBulkForm ] = useState<BulkEditForm>( {
        visibility: '', featured: '', language: '',
        author: '', authorChanged: false,
        publisher: '', publisherChanged: false,
        translator: '', translatorChanged: false,
        publication_year: '', publication_yearChanged: false,
        type: '', typeChanged: false,
        categoryIds: [], categoryChanged: false,
    } );

    const { data: formAuthors = [] } = useQuery<SimpleRecord[]>( {
        queryKey: [ 'authors', 'form' ],
        queryFn: async () => {
            const res = await fetch( `${API_BASE}/authors`, { headers: { 'X-WP-Nonce': getNonce() } } );
            const json = await res.json();
            return Array.isArray( json ) ? json : [];
        },
    } );

    const { data: formPublishers = [] } = useQuery<SimpleRecord[]>( {
        queryKey: [ 'publishers', 'form' ],
        queryFn: async () => {
            const res = await fetch( `${API_BASE}/publishers`, { headers: { 'X-WP-Nonce': getNonce() } } );
            const json = await res.json();
            return Array.isArray( json ) ? json : [];
        },
    } );

    const { data: formCategories = [] } = useQuery<CategoryExtended[]>( {
        queryKey: [ 'categories', 'form' ],
        queryFn: async () => {
            const res = await fetch( `${API_BASE}/categories`, { headers: { 'X-WP-Nonce': getNonce() } } );
            const json = await res.json();
            return Array.isArray( json ) ? json : [];
        },
    } );

    // Fetch categories for filter dropdown + table column display
    const { data: adminCategories = [] } = useQuery<CategoryExtended[]>( {
        queryKey: [ 'categories', 'admin', typeFilter ],
        queryFn: async () => {
            const url = typeFilter
                ? `${API_BASE}/categories?type=${ encodeURIComponent( typeFilter ) }`
                : `${API_BASE}/categories`;
            const res = await fetch( url, { headers: { 'X-WP-Nonce': getNonce() } } );
            const json = await res.json();
            return Array.isArray( json ) ? json : [];
        },
    } );

    const getCategoryNames = ( ids: number[] | undefined ) => {
        if ( ! ids?.length ) return '—';
        const names = ids
            .map( id => adminCategories.find( c => Number( c.id ) === Number( id ) )?.name )
            .filter( Boolean );
        return names.length ? names.join( ', ' ) : '—';
    };

    // Fetch items
    const { data, isLoading, isError, refetch } = useQuery<PaginatedResponse>( {
        queryKey: [ 'items', page, typeFilter, activeFilters ],
        queryFn: async () => {
            const params = new URLSearchParams( { page: String( page ), per_page: '20' } );
            if ( typeFilter )                    params.set( 'type',        typeFilter );
            if ( activeFilters.author )          params.set( 'author',      activeFilters.author );
            if ( activeFilters.file_type )       params.set( 'file_type',   activeFilters.file_type );
            if ( activeFilters.visibility )      params.set( 'visibility',  activeFilters.visibility );
            if ( activeFilters.featured !== '' ) params.set( 'featured',    activeFilters.featured );
            if ( activeFilters.view_min )        params.set( 'view_min',    activeFilters.view_min );
            if ( activeFilters.view_max )        params.set( 'view_max',    activeFilters.view_max );
            if ( activeFilters.has_volumes )     params.set( 'has_volumes', '1' );
            if ( activeFilters.category_id )     params.set( 'category_id', activeFilters.category_id );
            params.set( 'include_all_ids', '1' );
            const res = await fetch( `${API_BASE}/items?${params.toString()}`, {
                headers: { 'X-WP-Nonce': getNonce() },
            } );
            const json = await res.json();
            if ( json.code ) throw new Error( json.message );
            return json;
        },
    } );

    // Fetch counts per type for tab badges
    const { data: stats } = useQuery( {
        queryKey: [ 'dashboard-stats' ],
        queryFn: async () => {
            const res = await fetch( `${API_BASE}/dashboard`, {
                headers: { 'X-WP-Nonce': getNonce() },
            } );
            return res.json();
        },
        staleTime: 1000 * 60,
    } );

    const typeCounts: Record<string, number> = {
        '':        ( stats?.total_items  ?? 0 ),
        'book':    ( stats?.total_books    ?? 0 ),
        'article': ( stats?.total_articles ?? 0 ),
        'magazine':( stats?.total_magazines?? 0 ),
        'qa':      ( stats?.total_qa       ?? 0 ),
    };

    // Search
    const searchItems = async () => {
        if ( ! searchTerm.trim() ) { refetch(); return; }
        try {
            const res = await fetch( `${API_BASE}/search?q=${encodeURIComponent( searchTerm )}`, {
                headers: { 'X-WP-Nonce': getNonce() },
            } );
            if ( ! res.ok ) {
                flashMessage( `❌ Search failed (HTTP ${res.status}).` );
                dbg( 'search fetch error:', res.status, res.statusText );
                return;
            }
            const json = await res.json();
            if ( json.items ) {
                queryClient.setQueryData( [ 'items', page, typeFilter, activeFilters ], { items: json.items, total: json.total, page: 1, per_page: 20, pages: 1 } );
            }
        } catch ( err ) {
            flashMessage( '❌ Search request failed. Please try again.' );
            dbg( 'search fetch exception:', err );
        }
    };

    // Delete mutation
    const deleteMutation = useMutation( {
        mutationFn: async ( id: number ) => {
            const res = await fetch( `${API_BASE}/items/${id}`, {
                method: 'DELETE',
                headers: { 'X-WP-Nonce': getNonce() },
            } );
            const json = await res.json();
            if ( json.code ) throw new Error( json.message );
            return json;
        },
        onSuccess: () => {
            queryClient.invalidateQueries( { queryKey: [ 'items' ] } );
            setDeleteConfirm( null );
            flashMessage( '✅ Item deleted successfully.' );
        },
        onError: ( err: Error ) => flashMessage( `❌ ${err.message}` ),
    } );

    const flashMessage = ( msg: string ) => {
        setMessage( msg );
        setTimeout( () => setMessage( '' ), 3000 );
    };

    /* ── Bulk helpers ── */
    const activeFiltersCount = (
        ( activeFilters.author          ? 1 : 0 ) +
        ( activeFilters.file_type       ? 1 : 0 ) +
        ( activeFilters.visibility      ? 1 : 0 ) +
        ( activeFilters.featured !== '' ? 1 : 0 ) +
        ( activeFilters.view_min        ? 1 : 0 ) +
        ( activeFilters.view_max        ? 1 : 0 ) +
        ( activeFilters.has_volumes     ? 1 : 0 ) +
        ( activeFilters.category_id     ? 1 : 0 )
    );

    const allPageSelected = !! ( data?.items.length && data.items.every( i => selectedIds.has( i.id ) ) );
    const allMatchingSelected = !! ( data?.all_ids?.length && data.all_ids.every( id => selectedIds.has( id ) ) );

    const toggleSelectAll = () => {
        const next = new Set( selectedIds );
        if ( allPageSelected ) {
            if ( data?.items.length && selectedIds.size > data.items.length ) {
                setSelectedIds( new Set() );
            } else {
                data?.items.forEach( i => next.delete( i.id ) );
                setSelectedIds( next );
            }
        } else {
            data?.items.forEach( i => next.add( i.id ) );
            setSelectedIds( next );
        }
    };

    const toggleSelect = ( id: number ) => {
        const next = new Set( selectedIds );
        next.has( id ) ? next.delete( id ) : next.add( id );
        setSelectedIds( next );
    };

    const selectedItems = data?.items.filter( i => selectedIds.has( i.id ) ) ?? [];
    const hasMultiVolumeSelected = selectedItems.some( i => i.volumes && i.volumes.length > 1 );

    const openBulkEdit = () => {
        setBulkForm( {
            visibility: '', featured: '', language: '',
            author: '', authorChanged: false,
            publisher: '', publisherChanged: false,
            translator: '', translatorChanged: false,
            publication_year: '', publication_yearChanged: false,
            type: '', typeChanged: false,
            categoryIds: [], categoryChanged: false,
        } );
        setBulkEditOpen( true );
    };

    const handleBulkSave = async () => {
        const payload: Record<string, unknown> = {};
        if ( bulkForm.visibility )                            payload.visibility = bulkForm.visibility;
        if ( bulkForm.featured !== '' )                       payload.featured   = bulkForm.featured === '1';
        if ( bulkForm.language )                              payload.language   = bulkForm.language;
        if ( bulkForm.typeChanged )                           payload.type       = bulkForm.type;
        if ( bulkForm.authorChanged )                         payload.author     = bulkForm.author === '__none__' ? '' : bulkForm.author;
        if ( bulkForm.publisherChanged )                      payload.publisher  = bulkForm.publisher === '__none__' ? '' : bulkForm.publisher;
        if ( bulkForm.translatorChanged )                     payload.translator = bulkForm.translator;
        if ( bulkForm.publication_yearChanged )               payload.publication_year = bulkForm.publication_year ? parseInt( bulkForm.publication_year, 10 ) : null;
        if ( bulkForm.categoryChanged )                       payload.category_ids = bulkForm.categoryIds;

        if ( Object.keys( payload ).length === 0 ) {
            flashMessage( t( 'items.bulkNoChange' ) );
            return;
        }
        setBulkSaving( true );
        try {
            const r = await fetch( `${API_BASE}/items/bulk`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json', 'X-WP-Nonce': getNonce() },
                body: JSON.stringify( { ids: [ ...selectedIds ], ...payload } ),
            } );
            const json = await r.json();
            const ok   = json.updated ?? 0;
            flashMessage( `✅ ${ok} ${ t( 'items.itemsBulkUpdated' ) }` );
        } catch {
            flashMessage( `❌ ${ t( 'items.failed' ) }` );
        } finally {
            setBulkSaving( false );
            setBulkEditOpen( false );
            setSelectedIds( new Set() );
            queryClient.invalidateQueries( { queryKey: [ 'items' ] } );
        }
    };

    const handleBulkDelete = async () => {
        setBulkSaving( true );
        try {
            const r    = await fetch( `${API_BASE}/items/bulk-delete`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'X-WP-Nonce': getNonce() },
                body: JSON.stringify( { ids: [ ...selectedIds ] } ),
            } );
            const json = await r.json();
            const ok   = json.deleted ?? 0;
            flashMessage( `🗑️ ${ok} ${ t( 'items.itemsBulkDeleted' ) }` );
        } catch {
            flashMessage( `❌ ${ t( 'items.failed' ) }` );
        } finally {
            setBulkSaving( false );
            setBulkDeleteConfirm( false );
            setSelectedIds( new Set() );
            queryClient.invalidateQueries( { queryKey: [ 'items' ] } );
            queryClient.invalidateQueries( { queryKey: [ 'dashboard-stats' ] } );
        }
    };

    return (
        <div className="p-6">
            <div className="flex items-center justify-between mb-4">
                <div>
                    <h1 className="text-2xl font-bold text-gray-900 dark:text-white">{t('items.title')}</h1>
                    <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">
                        {t('items.subtitle')}
                    </p>
                </div>
                <div className="flex gap-2">
                    <button
                        onClick={ () => setBulkAdding( true ) }
                        className="jr-btn-secondary"
                    >
                        { t( 'items.bulkAddButton' ) }
                    </button>
                    <button onClick={ () => { setCreating( true ); setEditingItem( null ); } } className="jr-btn-primary">
                        { t( 'items.addNewItem' ) }
                    </button>
                </div>
            </div>

            { /* ── Embed reminder banner — Pro only (Displays not in Lite) ── */ }
            { !isLite && (
            <div className="flex flex-col sm:flex-row sm:items-center gap-3 mb-6 px-4 py-3 rounded-xl bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-800 text-sm">
                <span className="text-blue-500 text-lg shrink-0">💡</span>
                <span className="text-blue-800 dark:text-blue-200 flex-1">
                    { t( 'dashboard.itemsBannerText' ) }
                </span>
                <NavLink
                    page="jetreader-displays"
                    className="shrink-0 text-xs font-medium text-blue-600 dark:text-blue-400 hover:text-blue-800 dark:hover:text-blue-200 underline underline-offset-2 whitespace-nowrap"
                >
                    { t( 'dashboard.itemsBannerLink' ) }
                </NavLink>
            </div>
            ) }

            { message && (
                <div className="mb-4 px-4 py-2 bg-gray-100 dark:bg-gray-700 rounded-lg text-sm text-gray-800 dark:text-gray-200">
                    { message }
                </div>
            ) }

            {/* Type tabs */}
            <div className="flex gap-1 mb-5 border-b border-gray-200 dark:border-gray-700 overflow-x-auto">
                { typeTabs.map( ( tab ) => (
                    <button
                        key={ tab.key }
                        onClick={ () => {
                            setTypeFilter( tab.key );
                            setPage( 1 );
                            setPendingFilters( ( p ) => ( { ...p, category_id: '' } ) );
                            setActiveFilters( ( p ) => ( { ...p, category_id: '' } ) );
                        } }
                        className={ `flex items-center gap-1.5 px-4 py-2.5 text-sm font-medium border-b-2 transition-colors -mb-px whitespace-nowrap ${
                            typeFilter === tab.key
                                ? 'border-blue-500 text-blue-600 dark:text-blue-400'
                                : 'border-transparent text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200'
                        }` }
                    >
                        <span>{ tab.icon }</span>
                        <span>{ tab.label }</span>
                        <span className={ `ml-1 text-xs px-1.5 py-0.5 rounded-full ${ typeFilter === tab.key ? 'bg-blue-100 text-blue-700 dark:bg-blue-900 dark:text-blue-300' : 'bg-gray-100 text-gray-500 dark:bg-gray-700 dark:text-gray-400' }` }>
                            { typeCounts[ tab.key ] ?? 0 }
                        </span>
                    </button>
                ) ) }
            </div>

            {/* Toolbar */}
            <div className="flex flex-wrap gap-3 mb-3 items-center">
                <div className="flex gap-2 flex-1 max-w-xl">
                    <input
                        type="text"
                        value={ searchTerm }
                        onChange={ ( e ) => setSearchTerm( e.target.value ) }
                        onKeyDown={ ( e ) => e.key === 'Enter' && searchItems() }
                        placeholder={t('items.searchItems')}
                        className="jr-input flex-1 text-sm"
                    />
                    <button onClick={ searchItems } className="jr-btn-secondary text-sm px-3">🔍</button>
                    <button
                        onClick={ () => setFilterOpen( ( v ) => ! v ) }
                        className={ `relative px-3 py-2 text-sm border rounded-lg transition-colors whitespace-nowrap ${
                            filterOpen
                                ? 'bg-blue-50 dark:bg-blue-900/30 border-blue-400 dark:border-blue-600 text-blue-700 dark:text-blue-300'
                                : 'bg-white dark:bg-gray-700 border-gray-300 dark:border-gray-600 text-gray-600 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-600'
                        }` }
                        title={t('items.filters')}
                    >
                        {t('items.filters')}
                        { activeFiltersCount > 0 && (
                            <span className="absolute -top-1.5 -right-1.5 bg-blue-600 text-white text-[10px] font-bold w-4 h-4 rounded-full flex items-center justify-center">
                                { activeFiltersCount }
                            </span>
                        ) }
                    </button>
                </div>
            </div>

            {/* Filter panel */}
            { filterOpen && (
                <div className="mb-5 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-xl p-5 shadow-sm">
                    <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 xl:grid-cols-4 gap-4">
                        <div>
                            <label className="block text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide mb-1">{t('items.filterCategory')}</label>
                            <select
                                value={ pendingFilters.category_id }
                                onChange={ ( e ) => setPendingFilters( ( p ) => ( { ...p, category_id: e.target.value } ) ) }
                                className="jr-input w-full text-sm"
                            >
                                <option value="">{t('allCategories')}</option>
                                { adminCategories.map( ( cat ) => (
                                    <option key={ cat.id } value={ String( cat.id ) }>{ cat.name }</option>
                                ) ) }
                            </select>
                        </div>
                        <div>
                            <label className="block text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide mb-1">{t('items.filterAuthor')}</label>
                            <input
                                type="text"
                                value={ pendingFilters.author }
                                onChange={ ( e ) => setPendingFilters( ( p ) => ( { ...p, author: e.target.value } ) ) }
                                placeholder={t('items.filterAuthorPlaceholder')}
                                className="jr-input w-full text-sm"
                            />
                        </div>
                        <div>
                            <label className="block text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide mb-1">{t('items.filterFormat')}</label>
                            <select
                                value={ pendingFilters.file_type }
                                onChange={ ( e ) => setPendingFilters( ( p ) => ( { ...p, file_type: e.target.value } ) ) }
                                className="jr-input w-full text-sm"
                            >
                                <option value="">{t('allFormats')}</option>
                                { FORMATS_ADMIN.map( ( f ) => <option key={ f } value={ f }>{ f.toUpperCase() }</option> ) }
                            </select>
                        </div>
                        <div>
                            <label className="block text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide mb-1">{t('items.filterVisibility')}</label>
                            <select
                                value={ pendingFilters.visibility }
                                onChange={ ( e ) => setPendingFilters( ( p ) => ( { ...p, visibility: e.target.value } ) ) }
                                className="jr-input w-full text-sm"
                            >
                                <option value="">{t('all')}</option>
                                <option value="publish">{t('items.filterVisibilityPublished')}</option>
                                <option value="draft">{t('items.filterVisibilityDraft')}</option>
                                <option value="private">{t('items.filterVisibilityPrivate')}</option>
                            </select>
                        </div>
                        <div>
                            <label className="block text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide mb-1">{t('items.filterFeatured')}</label>
                            <select
                                value={ pendingFilters.featured }
                                onChange={ ( e ) => setPendingFilters( ( p ) => ( { ...p, featured: e.target.value } ) ) }
                                className="jr-input w-full text-sm"
                            >
                                <option value="">{t('all')}</option>
                                <option value="1">{t('items.filterFeaturedYes')}</option>
                                <option value="0">{t('items.filterFeaturedNo')}</option>
                            </select>
                        </div>
                        <div>
                            <label className="block text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide mb-1">{t('items.filterViewsMinMax')}</label>
                            <div className="flex gap-2">
                                <input type="number" placeholder={t('items.filterViewsMin')} min={ 0 } value={ pendingFilters.view_min } onChange={ ( e ) => setPendingFilters( ( p ) => ( { ...p, view_min: e.target.value } ) ) } className="jr-input flex-1 w-0 text-sm" />
                                <input type="number" placeholder={t('items.filterViewsMax')} min={ 0 } value={ pendingFilters.view_max } onChange={ ( e ) => setPendingFilters( ( p ) => ( { ...p, view_max: e.target.value } ) ) } className="jr-input flex-1 w-0 text-sm" />
                            </div>
                        </div>
                        <div className="flex items-end pb-1">
                            <label className="flex items-center gap-2 cursor-pointer select-none">
                                <input
                                    type="checkbox"
                                    checked={ pendingFilters.has_volumes }
                                    onChange={ ( e ) => setPendingFilters( ( p ) => ( { ...p, has_volumes: e.target.checked } ) ) }
                                    className="rounded accent-blue-600 w-4 h-4"
                                />
                                <span className="text-sm text-gray-700 dark:text-gray-300">{t('items.filterMultiVolume')}</span>
                            </label>
                        </div>
                    </div>
                    <div className="flex gap-3 mt-5 justify-end border-t border-gray-100 dark:border-gray-700 pt-4">
                        <button
                            onClick={ () => {
                                setPendingFilters( DEFAULT_ADMIN_FILTERS );
                                setActiveFilters( DEFAULT_ADMIN_FILTERS );
                                setPage( 1 );
                            } }
                            className="px-4 py-2 text-sm bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-200 rounded-lg hover:bg-gray-200 dark:hover:bg-gray-600 transition-colors"
                        >
                            {t('items.resetFilters')}
                        </button>
                        <button
                            onClick={ () => { setActiveFilters( pendingFilters ); setPage( 1 ); setFilterOpen( false ); } }
                            className="jr-btn-primary text-sm"
                        >
                            {t('items.applyFilters')}
                        </button>
                    </div>
                </div>
            ) }

            {/* Loading */}
            { isLoading && <AdminSpinner /> }

            {/* Error */}
            { isError && (
                <div className="text-center py-12 text-red-500">
                    {t('items.failedToLoad')} <button onClick={ () => refetch() } className="underline">{t('common.retry')}</button>
                </div>
            ) }

            {/* Bulk action bar */}
            { selectedIds.size > 0 && (
                <div className="flex items-center gap-3 mb-4 bg-blue-50 dark:bg-blue-950/40 border border-blue-200 dark:border-blue-800 rounded-xl px-4 py-3 flex-wrap">
                    <span className="text-sm font-semibold text-blue-800 dark:text-blue-200">
                        ✓ { selectedIds.size } { selectedIds.size === 1 ? t('items.item') : t('items.itemsSelected') }
                    </span>
                    { data?.all_ids && data.all_ids.length > data.items.length && (
                        <label className="flex items-center gap-1.5 text-xs text-blue-700 dark:text-blue-300 font-medium cursor-pointer ml-2 select-none border-l border-blue-200 dark:border-blue-800 pl-3">
                            <input
                                type="checkbox"
                                checked={ allMatchingSelected }
                                onChange={ ( e ) => {
                                    if ( e.target.checked ) {
                                        setSelectedIds( new Set( data.all_ids ) );
                                    } else {
                                        setSelectedIds( new Set( data.items.map( i => i.id ) ) );
                                    }
                                } }
                                className="rounded accent-blue-600 w-3.5 h-3.5 cursor-pointer"
                            />
                            <span>{ t( 'items.selectAllMatching', { N: String( data.total ) } ) }</span>
                        </label>
                    ) }
                    <div className="flex gap-2 ml-auto">
                        <button
                            onClick={ openBulkEdit }
                            className="px-3 py-1.5 text-xs bg-white dark:bg-gray-700 border border-blue-300 dark:border-blue-600 text-blue-700 dark:text-blue-300 rounded-lg hover:bg-blue-50 dark:hover:bg-blue-900 transition-colors font-medium"
                        >
                            {t('items.bulkEdit')}
                        </button>
                        <button
                            onClick={ () => setBulkDeleteConfirm( true ) }
                            className="px-3 py-1.5 text-xs bg-white dark:bg-gray-700 border border-red-300 dark:border-red-600 text-red-600 dark:text-red-400 rounded-lg hover:bg-red-50 dark:hover:bg-red-900/30 transition-colors font-medium"
                        >
                            {t('items.bulkDelete')}
                        </button>
                        <button
                            onClick={ () => setSelectedIds( new Set() ) }
                            className="px-3 py-1.5 text-xs bg-white dark:bg-gray-700 border border-gray-300 dark:border-gray-600 text-gray-600 dark:text-gray-400 rounded-lg hover:bg-gray-50 dark:hover:bg-gray-600 transition-colors"
                        >
                            {t('items.deselect')}
                        </button>
                    </div>
                </div>
            ) }

            {/* Table */}
            { data && data.items.length > 0 && (
                <div className="bg-white dark:bg-gray-800 rounded-xl shadow-md border border-gray-200 dark:border-gray-700 overflow-x-auto">
                    <table className="w-full text-sm">
                        <thead>
                            <tr className="border-b border-gray-200 dark:border-gray-700 text-left text-gray-500 dark:text-gray-400">
                                <th className="p-4 w-10">
                                    <input
                                        type="checkbox"
                                        checked={ allPageSelected }
                                        onChange={ toggleSelectAll }
                                        className="rounded accent-blue-600 w-4 h-4 cursor-pointer"
                                        title={ t( 'admin.selectDeselectAll' ) }
                                    />
                                </th>
                                <th className="p-4 font-medium">{t('items.titleColumn')}</th>
                                <th className="p-4 font-medium">{t('items.typeColumn')}</th>
                                <th className="p-4 font-medium">{t('items.categoryColumn')}</th>
                                <th className="p-4 font-medium">{t('items.authorColumn')}</th>
                                <th className="p-4 font-medium">{t('items.formatColumn')}</th>
                                <th className="p-4 font-medium">{t('items.visibilityColumn')}</th>
                                <th className="p-4 font-medium">{t('items.featuredColumn')}</th>
                                <th className="p-4 font-medium">{t('items.viewsColumn')}</th>
                                <th className="p-4 font-medium text-right">{t('common.actions')}</th>
                            </tr>
                        </thead>
                        <tbody>
                            { data.items.map( ( item ) => {
                                const isSelected = selectedIds.has( item.id );
                                return (
                                    <tr
                                        key={ item.id }
                                        className={ `border-b border-gray-100 dark:border-gray-700 transition-colors ${
                                            isSelected
                                                ? 'bg-blue-50 dark:bg-blue-950/20 hover:bg-blue-100 dark:hover:bg-blue-950/30'
                                                : 'hover:bg-gray-50 dark:hover:bg-gray-750'
                                        }` }
                                    >
                                        <td className="p-4 w-10">
                                            <input
                                                type="checkbox"
                                                checked={ isSelected }
                                                onChange={ () => toggleSelect( item.id ) }
                                                className="rounded accent-blue-600 w-4 h-4 cursor-pointer"
                                            />
                                        </td>
                                        <td className="p-4 font-medium text-gray-900 dark:text-white max-w-[200px] truncate">{ item.title }</td>
                                        <td className="p-4"><span className="px-2 py-0.5 text-xs rounded-full bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-300">{ typeLabel( item.type ) }</span></td>
                                        <td className="p-4 text-gray-600 dark:text-gray-400 max-w-[160px] truncate">{ getCategoryNames( item.category_ids ) }</td>
                                        <td className="p-4 text-gray-600 dark:text-gray-400">{ item.author || '—' }</td>
                                        <td className="p-4">
                                            <div className="flex items-center gap-1.5 flex-wrap">
                                                <span className="uppercase text-xs font-mono">
                                                    { item.volumes && item.volumes.length > 0 ? item.volumes[0].file_type || '—' : item.file_type || '—' }
                                                </span>
                                                { item.volumes && item.volumes.length > 1 && (
                                                    <span className="text-xs bg-purple-100 dark:bg-purple-900 text-purple-700 dark:text-purple-300 px-1.5 py-0.5 rounded-full font-medium">
                                                        { item.volumes.length } { item.type === 'magazine' ? t( 'reader.volLabelMagazine' ) : t( 'reader.volLabelBook' ) }
                                                    </span>
                                                ) }
                                            </div>
                                        </td>
                                        <td className="p-4"><span className={ `px-2 py-0.5 text-xs rounded-full ${ item.visibility === 'publish' ? 'bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200' : 'bg-yellow-100 text-yellow-800 dark:bg-yellow-900 dark:text-yellow-200' }` }>{ visibilityLabel( item.visibility ) }</span></td>
                                        <td className="p-4">{ item.featured ? '⭐' : '—' }</td>
                                        <td className="p-4 text-gray-500">{ item.view_count }</td>
                                        <td className="p-4 text-right">
                                            <div className="flex gap-1 justify-end">
                                                <button
                                                    onClick={ () => { setEditingItem( item ); setCreating( false ); } }
                                                    className="px-3 py-1.5 text-xs bg-blue-50 text-blue-700 dark:bg-blue-900 dark:text-blue-200 rounded-lg hover:bg-blue-100 dark:hover:bg-blue-800 transition-colors"
                                                >
                                                    ✏️ { t( 'common.edit' ) }
                                                </button>
                                                <button
                                                    onClick={ () => setDeleteConfirm( item.id ) }
                                                    className="px-3 py-1.5 text-xs bg-red-50 text-red-700 dark:bg-red-900 dark:text-red-200 rounded-lg hover:bg-red-100 dark:hover:bg-red-800 transition-colors"
                                                >
                                                    🗑️ { t( 'common.delete' ) }
                                                </button>
                                            </div>
                                        </td>
                                    </tr>
                                );
                            } ) }
                        </tbody>
                    </table>
                </div>
            ) }

            {/* Empty */}
            { data && data.items.length === 0 && (
                <div className="text-center py-16">
                    <span className="text-5xl block mb-4">📭</span>
                    <p className="text-gray-500 dark:text-gray-400 text-lg">{t('items.noItemsYet')}</p>
                    <p className="text-gray-400 dark:text-gray-500 text-sm mt-1">{t('items.noItemsHint')}</p>
                </div>
            ) }

            {/* Pagination */}
            { data && data.pages > 1 && (
                <div className="flex items-center justify-between mt-6">
                    <p className="text-sm text-gray-500 dark:text-gray-400">
                        {t('common.showingPage')} { data.page } {t('common.of')} { data.pages } ({ data.total } {t('common.total')})
                    </p>
                    <div className="flex gap-2">
                        <button
                            onClick={ () => setPage( ( p ) => Math.max( p - 1, 1 ) ) }
                            disabled={ page <= 1 }
                            className="px-3 py-1.5 text-sm bg-white dark:bg-gray-700 border border-gray-300 dark:border-gray-600 rounded-lg hover:bg-gray-50 dark:hover:bg-gray-600 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                        >
                            {t('common.previous')}
                        </button>
                        <button
                            onClick={ () => setPage( ( p ) => Math.min( p + 1, data.pages ) ) }
                            disabled={ page >= data.pages }
                            className="px-3 py-1.5 text-sm bg-white dark:bg-gray-700 border border-gray-300 dark:border-gray-600 rounded-lg hover:bg-gray-50 dark:hover:bg-gray-600 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                        >
                            {t('common.next')}
                        </button>
                    </div>
                </div>
            ) }

            {/* Create / Edit Modal */}
            <ItemFormModal
                editingItem={ editingItem }
                isCreating={ creating }
                onClose={ () => { setEditingItem( null ); setCreating( false ); } }
                onSaved={ () => {
                    setEditingItem( null );
                    setCreating( false );
                    queryClient.invalidateQueries( { queryKey: [ 'items' ] } );
                } }
                flashMessage={ flashMessage }
            />

            {/* Bulk Add Modal */}
            <BulkAddModal
                isOpen={ bulkAdding }
                onClose={ () => setBulkAdding( false ) }
                onSaved={ () => {
                    queryClient.invalidateQueries( { queryKey: [ 'items' ] } );
                    queryClient.invalidateQueries( { queryKey: [ 'dashboard-stats' ] } );
                } }
                flashMessage={ flashMessage }
            />

            {/* Delete Confirmation Modal */}
            <AnimatePresence>
                { deleteConfirm !== null && (
                    <motion.div
                        initial={ { opacity: 0 } }
                        animate={ { opacity: 1 } }
                        exit={ { opacity: 0 } }
                        className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4"
                        onClick={ () => setDeleteConfirm( null ) }
                    >
                        <motion.div
                            initial={ { scale: 0.9, opacity: 0 } }
                            animate={ { scale: 1, opacity: 1 } }
                            exit={ { scale: 0.9, opacity: 0 } }
                            className="bg-white dark:bg-gray-800 rounded-xl shadow-2xl p-6 max-w-sm w-full"
                            onClick={ ( e ) => e.stopPropagation() }
                        >
                            <h3 className="text-lg font-semibold text-gray-900 dark:text-white mb-2">{ t( 'items.deleteConfirm' ) }</h3>
                            <p className="text-gray-600 dark:text-gray-400 text-sm mb-6">
                                { t( 'items.deleteWarning' ) }
                            </p>
                            <div className="flex gap-3">
                                <button
                                    onClick={ () => setDeleteConfirm( null ) }
                                    className="flex-1 px-4 py-2 text-sm bg-gray-200 dark:bg-gray-600 text-gray-700 dark:text-gray-200 rounded-lg hover:bg-gray-300 dark:hover:bg-gray-500 transition-colors"
                                >
                                    { t( 'common.cancel' ) }
                                </button>
                                <button
                                    onClick={ () => deleteMutation.mutate( deleteConfirm ) }
                                    disabled={ deleteMutation.isPending }
                                    className="flex-1 px-4 py-2 text-sm bg-red-600 text-white rounded-lg hover:bg-red-700 disabled:opacity-50 transition-colors"
                                >
                                    { deleteMutation.isPending ? t( 'items.deleting' ) : t( 'common.delete' ) }
                                </button>
                            </div>
                        </motion.div>
                    </motion.div>
                ) }
            </AnimatePresence>

            {/* ── Bulk Edit Modal ── */}
            <AnimatePresence>
                { bulkEditOpen && (
                    <motion.div
                        initial={ { opacity: 0 } } animate={ { opacity: 1 } } exit={ { opacity: 0 } }
                        className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4"
                        onClick={ () => setBulkEditOpen( false ) }
                    >
                        <motion.div
                            initial={ { scale: 0.95, opacity: 0, y: 20 } }
                            animate={ { scale: 1, opacity: 1, y: 0 } }
                            exit={ { scale: 0.95, opacity: 0, y: 20 } }
                            className="bg-white dark:bg-gray-800 rounded-2xl shadow-2xl w-full max-w-xl"
                            onClick={ ( e ) => e.stopPropagation() }
                        >
                            { /* Header */ }
                            <div className="flex items-center justify-between p-6 border-b border-gray-200 dark:border-gray-700">
                                <div>
                                    <h2 className="text-lg font-bold text-gray-900 dark:text-white">{ t( 'items.bulkEditTitle' ) }</h2>
                                    <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
                                        { t( 'items.bulkEditHint' ) }
                                    </p>
                                </div>
                                <button onClick={ () => setBulkEditOpen( false ) } className="p-2 hover:bg-gray-100 dark:hover:bg-gray-700 rounded-lg text-gray-500">✕</button>
                            </div>

                            <div className="p-6 space-y-4 max-h-[65vh] overflow-y-auto">
                                { /* Selected item chips */ }
                                <div className="flex flex-wrap gap-1.5 max-h-24 overflow-y-auto p-3 bg-gray-50 dark:bg-gray-900/40 rounded-xl border border-gray-100 dark:border-gray-700">
                                    { selectedItems.map( ( item ) => (
                                        <span key={ item.id } className="inline-flex items-center gap-1 text-xs bg-white dark:bg-gray-700 border border-gray-200 dark:border-gray-600 rounded-full px-2.5 py-1 text-gray-700 dark:text-gray-300 shadow-sm">
                                            { { book: '📚', article: '📄', magazine: '🗞️', qa: '💬' }[ item.type ] ?? '📄' }
                                            <span className="max-w-[120px] truncate">{ item.title }</span>
                                        </span>
                                    ) ) }
                                    { selectedIds.size > selectedItems.length && (
                                        <span className="inline-flex items-center text-xs text-gray-500 dark:text-gray-400 font-medium px-2.5 py-1 italic bg-gray-100 dark:bg-gray-800 rounded-full">
                                            { t( 'items.andMore', { count: String( selectedIds.size - selectedItems.length ) } ) }
                                        </span>
                                    ) }
                                </div>

                                { /* Multi-volume warning */ }
                                { hasMultiVolumeSelected && (
                                    <div className="flex items-start gap-2 bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-700 rounded-xl p-3 text-sm text-amber-800 dark:text-amber-300">
                                        <span className="shrink-0">⚠️</span>
                                        <span>{ t( 'items.multiVolumeWarning' ) }</span>
                                    </div>
                                ) }

                                { /* Fields Grid */ }
                                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                                    {/* Visibility */}
                                    <div>
                                        <label className="block text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide mb-1">{ t( 'itemForm.visibilityLabel' ) }</label>
                                        <select
                                            value={ bulkForm.visibility }
                                            onChange={ ( e ) => setBulkForm( ( p ) => ( { ...p, visibility: e.target.value } ) ) }
                                            className="jr-input w-full text-sm"
                                        >
                                            <option value="">{ t( 'common.noChange' ) }</option>
                                            <option value="publish">{ t( 'itemForm.visibilityPublish' ) }</option>
                                            <option value="draft">{ t( 'itemForm.visibilityDraft' ) }</option>
                                            <option value="private">{ t( 'itemForm.visibilityPrivate' ) }</option>
                                        </select>
                                    </div>

                                    {/* Featured */}
                                    <div>
                                        <label className="block text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide mb-1">{ t( 'items.featuredColumn' ) }</label>
                                        <select
                                            value={ bulkForm.featured }
                                            onChange={ ( e ) => setBulkForm( ( p ) => ( { ...p, featured: e.target.value } ) ) }
                                            className="jr-input w-full text-sm"
                                        >
                                            <option value="">{ t( 'common.noChange' ) }</option>
                                            <option value="1">{ t( 'items.filterFeaturedYes' ) }</option>
                                            <option value="0">{ t( 'items.filterFeaturedNo' ) }</option>
                                        </select>
                                    </div>

                                    {/* Language */}
                                    <div>
                                        <label className="block text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide mb-1">{ t( 'items.languageLabel' ) }</label>
                                        <LangCombobox
                                            value={ bulkForm.language }
                                            onChange={ ( v ) => setBulkForm( ( p ) => ( { ...p, language: v } ) ) }
                                            uiLocale={ locale }
                                            placeholder={ t( 'common.noChange' ) }
                                            searchPlaceholder={ t( 'itemForm.languageSearchPlaceholder' ) }
                                        />
                                    </div>

                                    {/* Translator */}
                                    <div>
                                        <label className="block text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide mb-1">
                                            { t( 'itemForm.translatorLabel' ) }
                                        </label>
                                        <input
                                            type="text"
                                            value={ bulkForm.translator }
                                            onChange={ ( e ) => setBulkForm( ( p ) => ( { ...p, translator: e.target.value, translatorChanged: true } ) ) }
                                            placeholder={ t( 'common.noChange' ) }
                                            className="jr-input w-full text-sm"
                                        />
                                    </div>

                                    {/* Author */}
                                    <div>
                                        <label className="block text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide mb-1">
                                            { t( 'items.authorLabel' ) }
                                        </label>
                                        <select
                                            value={ bulkForm.author }
                                            onChange={ ( e ) => setBulkForm( ( p ) => ( { ...p, author: e.target.value, authorChanged: true } ) ) }
                                            className="jr-input w-full text-sm"
                                        >
                                            <option value="">{ t( 'common.noChange' ) }</option>
                                            <option value="__none__">{ t( 'items.authorRemove' ) }</option>
                                            { formAuthors.map( ( a ) => (
                                                <option key={ a.id } value={ a.name }>{ a.name }</option>
                                            ) ) }
                                        </select>
                                    </div>

                                    {/* Publisher */}
                                    <div>
                                        <label className="block text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide mb-1">
                                            { t( 'itemForm.publisherLabel' ) }
                                        </label>
                                        <select
                                            value={ bulkForm.publisher }
                                            onChange={ ( e ) => setBulkForm( ( p ) => ( { ...p, publisher: e.target.value, publisherChanged: true } ) ) }
                                            className="jr-input w-full text-sm"
                                        >
                                            <option value="">{ t( 'common.noChange' ) }</option>
                                            <option value="__none__">{ t( 'items.publisherRemove' ) }</option>
                                            { formPublishers.map( ( p ) => (
                                                <option key={ p.id } value={ p.name }>{ p.name }</option>
                                            ) ) }
                                        </select>
                                    </div>

                                    {/* Type */}
                                    <div>
                                        <label className="block text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide mb-1">
                                            { t( 'itemForm.typeLabel' ) }
                                        </label>
                                        <select
                                            value={ bulkForm.type }
                                            onChange={ ( e ) => setBulkForm( ( p ) => ( { ...p, type: e.target.value, typeChanged: true } ) ) }
                                            className="jr-input w-full text-sm"
                                        >
                                            <option value="">{ t( 'common.noChange' ) }</option>
                                            <option value="book">{ t( 'itemForm.typeBook' ) }</option>
                                            <option value="article">{ t( 'itemForm.typeArticle' ) }</option>
                                            <option value="magazine">{ t( 'itemForm.typeMagazine' ) }</option>
                                            <option value="qa">{ t( 'itemForm.typeQA' ) }</option>
                                        </select>
                                    </div>

                                    {/* Publication Year */}
                                    <div>
                                        <label className="block text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide mb-1">
                                            { t( 'itemForm.yearLabel' ) }
                                        </label>
                                        <input
                                            type="number"
                                            value={ bulkForm.publication_year }
                                            onChange={ ( e ) => setBulkForm( ( p ) => ( { ...p, publication_year: e.target.value, publication_yearChanged: true } ) ) }
                                            placeholder={ t( 'common.noChange' ) }
                                            className="jr-input w-full text-sm"
                                        />
                                    </div>
                                </div>

                                {/* Category (Full Width) */}
                                <div className="mt-4 border-t border-gray-100 dark:border-gray-700/60 pt-4">
                                    <label className="flex items-center gap-2 block text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide mb-1.5 select-none cursor-pointer">
                                        <input
                                            type="checkbox"
                                            checked={ bulkForm.categoryChanged }
                                            onChange={ ( e ) => setBulkForm( ( p ) => ( { ...p, categoryChanged: e.target.checked } ) ) }
                                            className="rounded accent-blue-600"
                                        />
                                        <span>{ t( 'items.changeCategories' ) ?? 'Change Categories' }</span>
                                    </label>
                                    { bulkForm.categoryChanged && bulkForm.categoryIds.length === 0 && (
                                        <p className="text-xs text-amber-600 dark:text-amber-400 mt-1">
                                            ⚠️ { t( 'items.selectCategoryWarning' ) ?? 'Please select at least one category.' }
                                        </p>
                                    ) }
                                    { bulkForm.categoryChanged && (
                                        <div className="mt-3 p-3 bg-gray-50 dark:bg-gray-900/40 border border-gray-200 dark:border-gray-700 rounded-xl max-h-40 overflow-y-auto grid grid-cols-1 sm:grid-cols-2 gap-2">
                                            { formCategories.map( ( cat ) => {
                                                const isSelected = bulkForm.categoryIds.includes( cat.id );
                                                return (
                                                    <label
                                                        key={ cat.id }
                                                        className={ `flex items-center gap-2 px-2 py-1 rounded text-xs cursor-pointer transition-colors hover:bg-gray-100 dark:hover:bg-gray-800 ${
                                                            isSelected ? 'text-blue-700 dark:text-blue-300 font-semibold' : 'text-gray-700 dark:text-gray-300'
                                                        }` }
                                                    >
                                                        <input
                                                            type="checkbox"
                                                            checked={ isSelected }
                                                            onChange={ () => setBulkForm( ( p ) => ( {
                                                                ...p,
                                                                categoryIds: isSelected
                                                                    ? p.categoryIds.filter( id => id !== cat.id )
                                                                    : [ ...p.categoryIds, cat.id ]
                                                            } ) ) }
                                                            className="rounded accent-blue-600"
                                                        />
                                                        { cat.name }
                                                    </label>
                                                );
                                            } ) }
                                        </div>
                                    ) }
                                </div>
                            </div>

                            <div className="flex gap-3 p-6 border-t border-gray-200 dark:border-gray-700 justify-end">
                                <button onClick={ () => setBulkEditOpen( false ) } className="px-4 py-2 text-sm bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-200 rounded-lg hover:bg-gray-200 dark:hover:bg-gray-600 transition-colors">
                                    { t( 'common.cancel' ) }
                                </button>
                                <button
                                    onClick={ handleBulkSave }
                                    disabled={ bulkSaving || ( bulkForm.categoryChanged && bulkForm.categoryIds.length === 0 ) }
                                    className="jr-btn-primary text-sm"
                                >
                                    { bulkSaving ? t( 'items.bulkSaving' ) : t( 'items.bulkApply', { N: String( selectedIds.size ) } ) }
                                </button>
                            </div>
                        </motion.div>
                    </motion.div>
                ) }
            </AnimatePresence>

            {/* ── Bulk Delete Confirmation ── */}
            <AnimatePresence>
                { bulkDeleteConfirm && (
                    <motion.div
                        initial={ { opacity: 0 } } animate={ { opacity: 1 } } exit={ { opacity: 0 } }
                        className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4"
                        onClick={ () => setBulkDeleteConfirm( false ) }
                    >
                        <motion.div
                            initial={ { scale: 0.9, opacity: 0 } }
                            animate={ { scale: 1, opacity: 1 } }
                            exit={ { scale: 0.9, opacity: 0 } }
                            className="bg-white dark:bg-gray-800 rounded-xl shadow-2xl p-6 max-w-sm w-full"
                            onClick={ ( e ) => e.stopPropagation() }
                        >
                            <h3 className="text-lg font-semibold text-gray-900 dark:text-white mb-1">{ t( 'items.deleteBulkConfirm' ) }</h3>
                            <p className="text-gray-600 dark:text-gray-400 text-sm mb-4">
                                { t( 'items.deleteBulkWarning' ) }
                            </p>
                            <div className="max-h-28 overflow-y-auto mb-5 flex flex-wrap gap-1.5">
                                { selectedItems.map( ( item ) => (
                                    <span key={ item.id } className="text-xs bg-red-50 dark:bg-red-900/30 text-red-700 dark:text-red-300 border border-red-100 dark:border-red-800 rounded-full px-2 py-0.5">
                                        { item.title }
                                    </span>
                                ) ) }
                                { selectedIds.size > selectedItems.length && (
                                    <span className="text-xs bg-gray-50 dark:bg-gray-800 text-gray-500 dark:text-gray-400 border border-gray-100 dark:border-gray-700 rounded-full px-2 py-0.5 italic">
                                        { t( 'items.andMore', { count: String( selectedIds.size - selectedItems.length ) } ) }
                                    </span>
                                ) }
                            </div>
                            <div className="flex gap-3">
                                <button
                                    onClick={ () => setBulkDeleteConfirm( false ) }
                                    className="flex-1 px-4 py-2 text-sm bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-200 rounded-lg hover:bg-gray-200 transition-colors"
                                >
                                    { t( 'common.cancel' ) }
                                </button>
                                <button
                                    onClick={ handleBulkDelete }
                                    disabled={ bulkSaving }
                                    className="flex-1 px-4 py-2 text-sm bg-red-600 text-white rounded-lg hover:bg-red-700 disabled:opacity-50 transition-colors"
                                >
                                    { bulkSaving ? t( 'items.deleting' ) : t( 'items.deletingAll' ) }
                                </button>
                            </div>
                        </motion.div>
                    </motion.div>
                ) }
            </AnimatePresence>
        </div>
    );
};

/* ------------------------------------------------------------------ */
/*  ItemFormModal – shared for create & edit                           */
/* ------------------------------------------------------------------ */

interface ItemFormModalProps {
    editingItem: LibraryItem | null;
    isCreating: boolean;
    onClose: () => void;
    onSaved: () => void;
    flashMessage: ( msg: string ) => void;
}

const EMPTY_VOLUME: VolumeEntry = { vol: 1, file_path: '', file_type: '', cover_image: '' };

const ItemFormModal: React.FC<ItemFormModalProps> = ( { editingItem, isCreating, onClose, onSaved, flashMessage } ) => {
    const { t, locale } = useTranslation();
    const isOpen = isCreating || editingItem !== null;

    const [ form, setForm ] = useState( {
        title: '',
        type: 'book',
        author: '',
        translator: '',
        description: '',
        publisher: '',
        publication_year: '',
        isbn: '',
        language: 'en',
        file_type: '',
        file_path: '',
        cover_image: '',
        visibility: 'publish',
        featured: false,
    } );
    const [ volumes, setVolumes ] = useState<VolumeEntry[]>( [ { ...EMPTY_VOLUME } ] );
    const [ coverMode, setCoverMode ] = useState<'shared' | 'individual'>( 'shared' );
    const [ sharedCover, setSharedCover ] = useState( '' );
    const [ saving, setSaving ] = useState( false );
    const [ selectedCategoryIds, setSelectedCategoryIds ] = useState<number[]>( [] );

    const isMultiVolType = ( type: string ) => type === 'book' || type === 'magazine';
    const volLabel = ( type: string ) => type === 'magazine' ? t( 'reader.volLabelMagazine' ) : t( 'reader.volLabelBook' );

    // Fetch categories for the current selected type
    const { data: formCategories = [] } = useQuery<CategoryExtended[]>( {
        queryKey: [ 'categories', 'form', form.type ],
        queryFn: async () => {
            const res = await fetch( `${API_BASE}/categories?type=${ encodeURIComponent( form.type ) }`, {
                headers: { 'X-WP-Nonce': getNonce() },
            } );
            const json = await res.json();
            return Array.isArray( json ) ? json : [];
        },
        enabled: true,
    } );

    // Fetch authors and publishers for dropdowns
    const { data: formAuthors = [] } = useQuery<SimpleRecord[]>( {
        queryKey: [ 'authors', 'form' ],
        queryFn: async () => {
            const res = await fetch( `${API_BASE}/authors`, { headers: { 'X-WP-Nonce': getNonce() } } );
            const json = await res.json();
            return Array.isArray( json ) ? json : [];
        },
    } );
    const { data: formPublishers = [] } = useQuery<SimpleRecord[]>( {
        queryKey: [ 'publishers', 'form' ],
        queryFn: async () => {
            const res = await fetch( `${API_BASE}/publishers`, { headers: { 'X-WP-Nonce': getNonce() } } );
            const json = await res.json();
            return Array.isArray( json ) ? json : [];
        },
    } );

    const toggleCategory = ( catId: number ) => {
        setSelectedCategoryIds( ( prev ) =>
            prev.includes( catId ) ? prev.filter( ( id ) => id !== catId ) : [ ...prev, catId ]
        );
    };

    const resetVolumes = () => {
        setVolumes( [ { ...EMPTY_VOLUME } ] );
        setCoverMode( 'shared' );
        setSharedCover( '' );
    };

    useEffect( () => {
        if ( editingItem ) {
            setForm( {
                title: editingItem.title || '',
                type: editingItem.type || 'book',
                author: editingItem.author || '',
                translator: editingItem.translator || '',
                description: editingItem.description || '',
                publisher: editingItem.publisher || '',
                publication_year: editingItem.publication_year ? String( editingItem.publication_year ) : '',
                isbn: editingItem.isbn || '',
                language: editingItem.language || 'en',
                file_type: editingItem.file_type || '',
                file_path: editingItem.file_path || '',
                cover_image: editingItem.cover_image || '',
                visibility: editingItem.visibility || 'publish',
                featured: editingItem.featured || false,
            } );
            setSelectedCategoryIds( editingItem.category_ids || [] );
            if ( editingItem.volumes && editingItem.volumes.length > 0 ) {
                setVolumes( editingItem.volumes );
                const allSame = editingItem.volumes.every( ( v ) => v.cover_image === editingItem.volumes![0].cover_image );
                setCoverMode( allSame ? 'shared' : 'individual' );
                setSharedCover( editingItem.volumes[0].cover_image || '' );
            } else {
                setVolumes( [ { vol: 1, file_path: editingItem.file_path || '', file_type: editingItem.file_type || '', cover_image: editingItem.cover_image || '' } ] );
                setCoverMode( 'shared' );
                setSharedCover( editingItem.cover_image || '' );
            }
        } else {
            setForm( {
                title: '', type: 'book', author: '', translator: '', description: '', publisher: '',
                publication_year: '', isbn: '', language: 'en', file_type: '', file_path: '',
                cover_image: '', visibility: 'publish', featured: false,
            } );
            setSelectedCategoryIds( [] );
            resetVolumes();
        }
    }, [ editingItem ] );

    const updateField = ( field: string, value: string | boolean ) => {
        if ( field === 'type' ) {
            setSelectedCategoryIds( [] );
        }
        setForm( ( prev ) => ( { ...prev, [ field ]: value } ) );
    };

    const changeVolumeCount = ( count: number ) => {
        const n = Math.max( 1, Math.min( 20, count ) );
        setVolumes( ( prev ) => {
            if ( n > prev.length ) {
                const extra = Array.from( { length: n - prev.length }, ( _, i ) => ( {
                    vol: prev.length + i + 1,
                    file_path: '',
                    file_type: prev[0]?.file_type || '',
                    cover_image: '',
                } ) );
                return [ ...prev, ...extra ];
            }
            return prev.slice( 0, n ).map( ( v, i ) => ( { ...v, vol: i + 1 } ) );
        } );
    };

    const updateVolume = ( idx: number, field: keyof VolumeEntry, value: string ) => {
        setVolumes( ( prev ) => prev.map( ( v, i ) => {
            if ( i !== idx ) return v;
            const updated = { ...v, [ field ]: value };
            // Auto-detect file_type from URL extension when file_path changes
            if ( field === 'file_path' && ! v.file_type ) {
                const ext = value.split( '?' )[ 0 ].split( '#' )[ 0 ].split( '.' ).pop()?.toLowerCase() ?? '';
                const known: Record<string, string> = { pdf: 'pdf', epub: 'epub', docx: 'docx', doc: 'doc', txt: 'txt' };
                if ( known[ ext ] ) updated.file_type = known[ ext ];
            }
            return updated;
        } ) );
    };

    const handleSave = async () => {
        if ( ! form.title.trim() ) {
            flashMessage( t( 'items.addItemError' ) );
            return;
        }
        setSaving( true );
        try {
            const isEdit = !!editingItem;
            const url = isEdit ? `${API_BASE}/items/${editingItem.id}` : `${API_BASE}/items`;
            const method = isEdit ? 'PUT' : 'POST';

            const payload: Record<string, unknown> = {
                title: form.title,
                type: form.type,
                author: form.author,
                translator: form.translator,
                description: form.description,
                publisher: form.publisher,
                publication_year: parseInt( form.publication_year, 10 ) || null,
                isbn: form.isbn,
                language: form.language,
                visibility: form.visibility,
                featured: form.featured,
            };

            if ( isMultiVolType( form.type ) ) {
                const finalVols = volumes.map( ( v, i ) => ( {
                    ...v,
                    vol: i + 1,
                    cover_image: coverMode === 'shared' ? sharedCover : v.cover_image,
                } ) );
                payload.volumes    = finalVols;
                payload.file_path  = finalVols[0].file_path;
                payload.file_type  = finalVols[0].file_type;
                payload.cover_image= finalVols[0].cover_image;
            } else if ( form.type !== 'qa' ) {
                payload.file_path   = form.file_path;
                payload.file_type   = form.file_type;
                payload.cover_image = form.cover_image;
            }

            payload.category_ids = selectedCategoryIds;

            const res = await fetch( url, {
                method,
                headers: { 'Content-Type': 'application/json', 'X-WP-Nonce': getNonce() },
                body: JSON.stringify( payload ),
            } );
            const json = await res.json();
            if ( json.code ) throw new Error( json.message );

            flashMessage( isEdit ? t( 'items.itemUpdated' ) : t( 'items.itemCreated' ) );
            onSaved();
        } catch ( err ) {
            flashMessage( `❌ ${ err instanceof Error ? err.message : t( 'items.saveFailed' ) }` );
        } finally {
            setSaving( false );
        }
    };

    if ( ! isOpen ) return null;

    return (
        <AnimatePresence>
            <motion.div
                initial={ { opacity: 0 } }
                animate={ { opacity: 1 } }
                exit={ { opacity: 0 } }
                className="fixed inset-0 bg-black/50 z-50 flex items-start justify-center pt-10 p-4 overflow-y-auto"
                onClick={ onClose }
            >
                <motion.div
                    initial={ { scale: 0.95, opacity: 0, y: 20 } }
                    animate={ { scale: 1, opacity: 1, y: 0 } }
                    exit={ { scale: 0.95, opacity: 0, y: 20 } }
                    className="bg-white dark:bg-gray-800 rounded-2xl shadow-2xl max-w-2xl w-full"
                    onClick={ ( e ) => e.stopPropagation() }
                >
                    <div className="flex items-center justify-between p-6 border-b border-gray-200 dark:border-gray-700">
                        <h2 className="text-xl font-bold text-gray-900 dark:text-white">
                            { editingItem ? t('itemForm.editTitle') : t('itemForm.createTitle') }
                        </h2>
                        <button onClick={ onClose } className="p-2 hover:bg-gray-100 dark:hover:bg-gray-700 rounded-lg transition-colors text-gray-500 dark:text-gray-400">
                            ✕
                        </button>
                    </div>

                    <div className="p-6 space-y-4 max-h-[70vh] overflow-y-auto">
                        {/* Row 1 */}
                        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                            <div>
                                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">{t('itemForm.titleRequired')}</label>
                                <input type="text" value={ form.title } onChange={ ( e ) => updateField( 'title', e.target.value ) } className="jr-input w-full text-sm" placeholder={t('itemForm.titlePlaceholder')} />
                            </div>
                            <div>
                                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">{t('itemForm.typeLabel')}</label>
                                <select value={ form.type } onChange={ ( e ) => updateField( 'type', e.target.value ) } className="jr-input w-full text-sm">
                                    <option value="book">{t('itemForm.typeBook')}</option>
                                    <option value="article">{t('itemForm.typeArticle')}</option>
                                    <option value="magazine">{t('itemForm.typeMagazine')}</option>
                                    <option value="qa">{t('itemForm.typeQA')}</option>
                                </select>
                            </div>
                            <div>
                                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">{ t( 'itemForm.translatorLabel' ) }</label>
                                <input type="text" disabled={ form.type === 'qa' } value={ form.translator } onChange={ ( e ) => updateField( 'translator', e.target.value ) } className="jr-input w-full text-sm disabled:opacity-50" placeholder={ t( 'itemForm.translatorPlaceholder' ) } />
                            </div>
                        </div>
                        {/* Row 1.5 – Category, Author, Publisher (single row) */}
                        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                            <div>
                                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">{t('itemForm.categoryLabel')}</label>
                                { formCategories.length > 0 ? (
                                    <div className="relative group">
                                        <div className="jr-input w-full text-sm min-h-[38px] flex flex-wrap items-center gap-1 px-2 py-1 cursor-pointer overflow-y-auto max-h-[120px]">
                                            { selectedCategoryIds.length === 0 && (
                                                <span className="text-gray-400 text-xs">{t('itemForm.selectCategories')}</span>
                                            ) }
                                            { formCategories
                                                .filter( ( c ) => selectedCategoryIds.includes( c.id ) )
                                                .map( ( c ) => (
                                                    <span key={ c.id } className="inline-flex items-center gap-1 bg-blue-100 dark:bg-blue-900/40 text-blue-700 dark:text-blue-300 text-xs rounded-full px-2 py-0.5">
                                                        { c.name }
                                                        <button
                                                            onClick={ () => toggleCategory( c.id ) }
                                                            className="ml-0.5 w-3.5 h-3.5 flex items-center justify-center rounded-full hover:bg-blue-200 dark:hover:bg-blue-800 text-blue-500 dark:text-blue-400"
                                                        >✕</button>
                                                    </span>
                                                ) ) }
                                        </div>
                                        <div className="absolute left-0 right-0 top-full mt-1 z-20 bg-white dark:bg-gray-800 border border-gray-300 dark:border-gray-600 rounded-lg shadow-lg p-2 max-h-48 overflow-y-auto hidden group-hover:block group-focus-within:block">
                                            { formCategories.map( ( cat ) => {
                                                const isSelected = selectedCategoryIds.includes( cat.id );
                                                return (
                                                    <label
                                                        key={ cat.id }
                                                        className={ `flex items-center gap-2 px-2 py-1.5 rounded text-xs cursor-pointer transition-colors ${
                                                            isSelected
                                                                ? 'bg-blue-50 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300'
                                                                : 'text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700'
                                                        }` }
                                                    >
                                                        <input
                                                            type="checkbox"
                                                            checked={ isSelected }
                                                            onChange={ () => toggleCategory( cat.id ) }
                                                            className="rounded accent-blue-600"
                                                        />
                                                        { cat.name }
                                                    </label>
                                                );
                                            } ) }
                                        </div>
                                    </div>
                                ) : (
                                    <div className="relative group">
                                        <div className="jr-input w-full text-sm min-h-[38px] flex items-center px-2 text-gray-400 cursor-pointer">
                                            { t( 'itemForm.selectCategories' ) }
                                        </div>
                                        <div className="absolute left-0 right-0 top-full mt-1 z-20 bg-white dark:bg-gray-800 border border-gray-300 dark:border-gray-600 rounded-lg shadow-lg p-3 text-xs text-gray-500 dark:text-gray-400 hidden group-hover:block">
                                            { t( 'itemForm.noCategoryWarning' ) }{ ' ' }
                                            <NavLink page="jetreader-constants" className="text-blue-500 underline whitespace-nowrap">
                                                { t( 'itemForm.goToCategories' ) }
                                            </NavLink>
                                        </div>
                                    </div>
                                ) }
                            </div>
                            <div>
                                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">{ t( 'itemForm.authorLabel' ) }</label>
                                { formAuthors.length > 0 ? (
                                    <select
                                        disabled={ form.type === 'qa' }
                                        value={ form.author }
                                        onChange={ ( e ) => updateField( 'author', e.target.value ) }
                                        className="jr-input w-full text-sm disabled:opacity-50"
                                    >
                                        <option value="">{ t( 'itemForm.selectAuthor' ) }</option>
                                        { formAuthors.map( ( a ) => (
                                            <option key={ a.id } value={ a.name }>{ a.name }</option>
                                        ) ) }
                                    </select>
                                ) : (
                                    <div className="jr-input w-full text-sm text-gray-400 flex items-center gap-1">
                                        { t( 'itemForm.noAuthorWarning' ) }{ ' ' }
                                        <NavLink page="jetreader-constants" className="text-blue-500 underline whitespace-nowrap">
                                            { t( 'itemForm.goToConstants' ) }
                                        </NavLink>
                                    </div>
                                ) }
                            </div>
                            <div>
                                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">{ t( 'itemForm.publisherLabel' ) }</label>
                                { formPublishers.length > 0 ? (
                                    <select
                                        disabled={ form.type === 'qa' }
                                        value={ form.publisher }
                                        onChange={ ( e ) => updateField( 'publisher', e.target.value ) }
                                        className="jr-input w-full text-sm disabled:opacity-50"
                                    >
                                        <option value="">{ t( 'itemForm.selectPublisher' ) }</option>
                                        { formPublishers.map( ( p ) => (
                                            <option key={ p.id } value={ p.name }>{ p.name }</option>
                                        ) ) }
                                    </select>
                                ) : (
                                    <div className="jr-input w-full text-sm text-gray-400 flex items-center gap-1">
                                        { t( 'itemForm.noPublisherWarning' ) }{ ' ' }
                                        <NavLink page="jetreader-constants" className="text-blue-500 underline whitespace-nowrap">
                                            { t( 'itemForm.goToConstants' ) }
                                        </NavLink>
                                    </div>
                                ) }
                            </div>
                        </div>
                        {/* Row 3 */}
                        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                            <div>
                                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">{ t( 'itemForm.yearLabel' ) }</label>
                                <input type="number" disabled={ form.type === 'qa' } value={ form.publication_year } onChange={ ( e ) => updateField( 'publication_year', e.target.value ) } className="jr-input w-full text-sm disabled:opacity-50" placeholder="2024" />
                            </div>
                            <div>
                                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">{ t( 'itemForm.isbnLabel' ) }</label>
                                <input type="text" disabled={ form.type === 'qa' } value={ form.isbn } onChange={ ( e ) => updateField( 'isbn', e.target.value ) } className="jr-input w-full text-sm disabled:opacity-50" placeholder={ t( 'itemForm.isbnPlaceholder' ) } />
                            </div>
                            <div>
                                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">{ t( 'itemForm.languageLabel' ) }</label>
                                <LangCombobox
                                    value={ form.language }
                                    onChange={ ( v ) => updateField( 'language', v ) }
                                    uiLocale={ locale }
                                    disabled={ form.type === 'qa' }
                                    searchPlaceholder={ t( 'itemForm.languageSearchPlaceholder' ) }
                                />
                            </div>
                        </div>
                        {/* Description */}
                        <div>
                            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">{ t( 'itemForm.descriptionLabel' ) }</label>
                            <textarea value={ form.description } onChange={ ( e ) => updateField( 'description', e.target.value ) } className="jr-input w-full text-sm" rows={ 3 } placeholder={ t( 'itemForm.descriptionPlaceholder' ) } />
                        </div>
                        {/* Row 4 – file / multi-volume */}
                        { isMultiVolType( form.type ) ? (
                            <div className="border border-indigo-200 dark:border-indigo-700 rounded-xl p-4 space-y-4 bg-indigo-50 dark:bg-indigo-950/30">
                                { /* Header row */ }
                                <div className="flex items-center justify-between flex-wrap gap-3">
                                    <h3 className="text-sm font-semibold text-indigo-700 dark:text-indigo-300">
                                        { form.type === 'book' ? t( 'itemForm.volumes.bookHeader' ) : t( 'itemForm.volumes.magazineHeader' ) }
                                    </h3>
                                    <div className="flex items-center gap-2">
                                        <label className="text-xs text-gray-500 dark:text-gray-400 font-medium">
                                            { form.type === 'book' ? t( 'itemForm.volumes.volumeCount' ) : t( 'itemForm.volumes.issueCount' ) }
                                        </label>
                                        <input
                                            type="number"
                                            min={ 1 }
                                            max={ 20 }
                                            value={ volumes.length }
                                            onChange={ ( e ) => changeVolumeCount( parseInt( e.target.value ) || 1 ) }
                                            className="jr-input w-16 text-sm text-center"
                                        />
                                    </div>
                                </div>

                                { /* Cover mode (only when multiple) */ }
                                { volumes.length > 1 && (
                                    <div className="flex items-center gap-4 text-sm">
                                        <span className="text-xs font-medium text-gray-600 dark:text-gray-400">{ t( 'itemForm.volumes.coverImageTitle' ) }</span>
                                        { ( [ [ 'shared', t( 'itemForm.volumes.coverModeShared' ) ], [ 'individual', t( 'itemForm.volumes.coverModeIndividual' ) ] ] as const ).map( ( [ val, lbl ] ) => (
                                            <label key={ val } className="flex items-center gap-1.5 cursor-pointer">
                                                <input
                                                    type="radio"
                                                    name="cover-mode"
                                                    checked={ coverMode === val }
                                                    onChange={ () => setCoverMode( val ) }
                                                    className="accent-indigo-600"
                                                />
                                                <span className="text-xs text-gray-700 dark:text-gray-300">{ lbl }</span>
                                            </label>
                                        ) ) }
                                    </div>
                                ) }

                                { /* Shared cover input */ }
                                { ( coverMode === 'shared' || volumes.length === 1 ) && (
                                    <div>
                                        <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">
                                            { volumes.length > 1 ? t( 'itemForm.volumes.coverImageShared' ) : t( 'itemForm.volumes.coverImageSingle' ) }
                                        </label>
                                        <div className="flex items-center gap-2">
                                            <input
                                                type="text"
                                                value={ sharedCover }
                                                onChange={ ( e ) => setSharedCover( e.target.value ) }
                                                className="jr-input flex-1 text-sm"
                                                placeholder="https://..."
                                            />
                                            <WpMediaButton imageOnly title={ t( 'itemForm.browseMedia' ) } onSelect={ ( url ) => setSharedCover( url ) } />
                                        </div>
                                    </div>
                                ) }

                                { /* Volume rows */ }
                                { volumes.map( ( vol, idx ) => (
                                    <div key={ idx } className="border border-gray-200 dark:border-gray-700 rounded-lg p-3 space-y-2.5 bg-white dark:bg-gray-800">
                                        <div className="text-xs font-bold text-indigo-600 dark:text-indigo-400 uppercase tracking-wide">
                                            { form.type === 'book' ? `📖 ${ t( 'itemForm.volumes.volumeLabel' ) } ${idx + 1}` : `🗞️ ${ t( 'itemForm.volumes.issueLabel' ) } ${idx + 1}` }
                                        </div>
                                        <div className="grid grid-cols-1 md:grid-cols-2 gap-2.5">
                                            <div>
                                                <label className="block text-xs text-gray-500 dark:text-gray-400 mb-0.5">{ t( 'itemForm.volumes.filePathLabel' ) }</label>
                                                <div className="flex items-center gap-2">
                                                    <input
                                                        type="text"
                                                        value={ vol.file_path }
                                                        onChange={ ( e ) => updateVolume( idx, 'file_path', e.target.value ) }
                                                        className="jr-input flex-1 text-sm"
                                                        placeholder="/wp-content/uploads/..."
                                                    />
                                                    <WpMediaButton title={ t( 'itemForm.browseMedia' ) } onSelect={ ( url ) => updateVolume( idx, 'file_path', url ) } />
                                                </div>
                                            </div>
                                            <div>
                                                <label className="block text-xs text-gray-500 dark:text-gray-400 mb-0.5">{ t( 'itemForm.volumes.fileTypeLabel' ) }</label>
                                                <select
                                                    value={ vol.file_type }
                                                    onChange={ ( e ) => updateVolume( idx, 'file_type', e.target.value ) }
                                                    className="jr-input w-full text-sm"
                                                >
                                                    <option value="">{ t( 'itemForm.volumes.fileTypeSelect' ) }</option>
                                                    <option value="epub">EPUB</option>
                                                    <option value="pdf">PDF</option>
                                                    <option value="txt">TXT</option>
                                                    <option value="docx">DOCX</option>
                                                </select>
                                            </div>
                                        </div>
                                        { coverMode === 'individual' && (
                                            <div>
                                                <label className="block text-xs text-gray-500 dark:text-gray-400 mb-0.5">{ t( 'itemForm.volumes.coverImageUrlLabel' ) }</label>
                                                <div className="flex items-center gap-2">
                                                    <input
                                                        type="text"
                                                        value={ vol.cover_image }
                                                        onChange={ ( e ) => updateVolume( idx, 'cover_image', e.target.value ) }
                                                        className="jr-input flex-1 text-sm"
                                                        placeholder="https://..."
                                                    />
                                                    <WpMediaButton imageOnly title={ t( 'itemForm.browseMedia' ) } onSelect={ ( url ) => updateVolume( idx, 'cover_image', url ) } />
                                                </div>
                                            </div>
                                        ) }
                                    </div>
                                ) ) }
                            </div>
                        ) : form.type !== 'qa' ? (
                            <>
                                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                                    <div>
                                        <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">{ t( 'itemForm.filePathLabel' ) }</label>
                                        <div className="flex items-center gap-2">
                                            <input type="text" value={ form.file_path } onChange={ ( e ) => updateField( 'file_path', e.target.value ) } className="jr-input flex-1 text-sm" placeholder={ t( 'itemForm.filePathPlaceholder' ) } />
                                            <WpMediaButton title={ t( 'itemForm.browseMedia' ) } onSelect={ ( url ) => updateField( 'file_path', url ) } />
                                        </div>
                                    </div>
                                    <div>
                                        <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">{ t( 'itemForm.fileTypeLabel' ) }</label>
                                        <select value={ form.file_type } onChange={ ( e ) => updateField( 'file_type', e.target.value ) } className="jr-input w-full text-sm">
                                            <option value="">{ t( 'itemForm.fileTypeSelect' ) }</option>
                                            <option value="epub">EPUB</option>
                                            <option value="pdf">PDF</option>
                                            <option value="txt">TXT</option>
                                            <option value="docx">DOCX</option>
                                        </select>
                                    </div>
                                </div>
                                <div>
                                    <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">{ t( 'itemForm.coverImageLabel' ) }</label>
                                    <div className="flex items-center gap-2">
                                        <input type="text" value={ form.cover_image } onChange={ ( e ) => updateField( 'cover_image', e.target.value ) } className="jr-input flex-1 text-sm" placeholder={ t( 'itemForm.coverImagePlaceholder' ) } />
                                        <WpMediaButton imageOnly title={ t( 'itemForm.browseMedia' ) } onSelect={ ( url ) => updateField( 'cover_image', url ) } />
                                    </div>
                                </div>
                            </>
                        ) : null }
                        {/* Row 5 – visibility + featured */}
                        <div className="flex items-center gap-6">
                            <div>
                                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">{ t( 'itemForm.visibilityLabel' ) }</label>
                                <select value={ form.visibility } onChange={ ( e ) => updateField( 'visibility', e.target.value ) } className="jr-input text-sm">
                                    <option value="publish">{ t( 'itemForm.visibilityPublish' ) }</option>
                                    <option value="draft">{ t( 'itemForm.visibilityDraft' ) }</option>
                                    <option value="private">{ t( 'itemForm.visibilityPrivate' ) }</option>
                                </select>
                            </div>
                            <label className="flex items-center gap-2 cursor-pointer mt-5">
                                <input
                                    type="checkbox"
                                    checked={ form.featured }
                                    onChange={ ( e ) => updateField( 'featured', e.target.checked ) }
                                    className="rounded"
                                />
                                <span className="text-sm text-gray-700 dark:text-gray-300">{ t( 'itemForm.featuredLabel' ) }</span>
                            </label>
                        </div>

                    </div>

                    <div className="flex gap-3 p-6 border-t border-gray-200 dark:border-gray-700 justify-end">
                        <button onClick={ onClose } className="px-4 py-2 text-sm bg-gray-200 dark:bg-gray-600 text-gray-700 dark:text-gray-200 rounded-lg hover:bg-gray-300 dark:hover:bg-gray-500 transition-colors">
                            { t( 'common.cancel' ) }
                        </button>
                        <button onClick={ handleSave } disabled={ saving } className="jr-btn-primary text-sm">
                            { saving ? t( 'itemForm.saving' ) : t( 'itemForm.saveButton' ) }
                        </button>
                    </div>
                </motion.div>
            </motion.div>
        </AnimatePresence>
    );
};

/* ------------------------------------------------------------------ */
/*  CategoriesPage  (reused as a sub-tab inside ConstantsPage)        */
/* ------------------------------------------------------------------ */

interface CategoryExtended {
    id: number;
    name: string;
    slug: string;
    description: string;
    type: string;
}

interface SimpleRecord {
    id: number;
    name: string;
    slug: string;
    description: string;
}

const CategoriesTab: React.FC<{ flashMessage: ( msg: string ) => void }> = ( { flashMessage } ) => {
    const { t } = useTranslation();
    const queryClient = useQueryClient();

    const categoryTypeTabs = [
        { key: 'book',     label: t( 'categories.tabBooks' ) },
        { key: 'article',  label: t( 'categories.tabArticles' ) },
        { key: 'magazine', label: t( 'categories.tabMagazines' ) },
        { key: 'qa',       label: t( 'categories.tabQA' ) },
    ];
    const [ activeTab, setActiveTab ] = useState( 'book' );
    const [ newName, setNewName ] = useState( '' );
    const [ newDescription, setNewDescription ] = useState( '' );
    const [ editingCat, setEditingCat ] = useState<CategoryExtended | null>( null );
    const [ editName, setEditName ] = useState( '' );
    const [ editDescription, setEditDescription ] = useState( '' );
    const [ selectedCatIds, setSelectedCatIds ] = useState<Set<number>>( new Set() );
    const [ bulkDeleting, setBulkDeleting ] = useState( false );

    const { data: allCategories, isLoading } = useQuery<CategoryExtended[]>( {
        queryKey: [ 'categories' ],
        queryFn: async () => {
            const res = await fetch( `${API_BASE}/categories`, { headers: { 'X-WP-Nonce': getNonce() } } );
            const json = await res.json();
            if ( json.code ) throw new Error( json.message );
            return json;
        },
    } );

    const categories = ( allCategories || [] ).filter( ( c ) => c.type === activeTab );
    const countForTab = ( type: string ) => ( allCategories || [] ).filter( ( c ) => c.type === type ).length;

    const createMutation = useMutation( {
        mutationFn: async ( payload: { name: string; description: string; type: string } ) => {
            const res = await fetch( `${API_BASE}/categories`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'X-WP-Nonce': getNonce() },
                body: JSON.stringify( payload ),
            } );
            const json = await res.json();
            if ( json.code ) throw new Error( json.message );
            return json;
        },
        onSuccess: () => {
            queryClient.invalidateQueries( { queryKey: [ 'categories' ] } );
            setNewName( '' );
            setNewDescription( '' );
            flashMessage( t( 'categories.categoryCreated' ) );
        },
        onError: ( err: Error ) => flashMessage( `❌ ${err.message}` ),
    } );

    const updateMutation = useMutation( {
        mutationFn: async ( payload: { id: number; name: string; description: string } ) => {
            const res = await fetch( `${API_BASE}/categories/${payload.id}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json', 'X-WP-Nonce': getNonce() },
                body: JSON.stringify( { name: payload.name, description: payload.description } ),
            } );
            const json = await res.json();
            if ( json.code ) throw new Error( json.message );
            return json;
        },
        onSuccess: () => {
            queryClient.invalidateQueries( { queryKey: [ 'categories' ] } );
            setEditingCat( null );
            setEditName( '' );
            setEditDescription( '' );
            flashMessage( t( 'categories.categoryUpdated' ) );
        },
        onError: ( err: Error ) => flashMessage( `❌ ${err.message}` ),
    } );

    const deleteMutation = useMutation( {
        mutationFn: async ( id: number ) => {
            const res = await fetch( `${API_BASE}/categories/${id}`, {
                method: 'DELETE',
                headers: { 'X-WP-Nonce': getNonce() },
            } );
            const json = await res.json();
            if ( json.code ) throw new Error( json.message );
            return json;
        },
        onSuccess: () => {
            queryClient.invalidateQueries( { queryKey: [ 'categories' ] } );
            flashMessage( t( 'categories.categoryDeleted' ) );
        },
        onError: ( err: Error ) => flashMessage( `❌ ${err.message}` ),
    } );

    const handleCreate = async () => {
        const names = newName.split( ',' ).map( ( n ) => n.trim() ).filter( Boolean );
        if ( names.length === 0 ) { flashMessage( t( 'categories.categoryNameRequired' ) ); return; }
        if ( names.length === 1 ) {
            createMutation.mutate( { name: names[0], description: newDescription.trim(), type: activeTab } );
            return;
        }
        for ( const name of names ) {
            await fetch( `${API_BASE}/categories`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'X-WP-Nonce': getNonce() },
                body: JSON.stringify( { name, description: '', type: activeTab } ),
            } );
        }
        queryClient.invalidateQueries( { queryKey: [ 'categories' ] } );
        setNewName( '' );
        setNewDescription( '' );
        flashMessage( t( 'categories.categoryCreated' ) );
    };

    const handleBulkDeleteCats = async () => {
        if ( selectedCatIds.size === 0 ) return;
        const count = selectedCatIds.size;
        if ( ! window.confirm( t( 'constants.confirmBulkDelete', { N: String( count ) } ) ) ) return;
        setBulkDeleting( true );
        for ( const id of selectedCatIds ) {
            await fetch( `${API_BASE}/categories/${id}`, { method: 'DELETE', headers: { 'X-WP-Nonce': getNonce() } } );
        }
        queryClient.invalidateQueries( { queryKey: [ 'categories' ] } );
        setSelectedCatIds( new Set() );
        setBulkDeleting( false );
        flashMessage( t( 'categories.bulkDeleted', { N: String( count ) } ) );
    };

    const openEdit = ( cat: CategoryExtended ) => {
        setEditingCat( cat );
        setEditName( cat.name );
        setEditDescription( cat.description || '' );
    };

    const handleUpdate = () => {
        if ( ! editingCat ) return;
        if ( ! editName.trim() ) { flashMessage( t( 'categories.categoryNameRequired' ) ); return; }
        updateMutation.mutate( { id: editingCat.id, name: editName.trim(), description: editDescription.trim() } );
    };

    return (
        <>
            {/* Type sub-tabs */}
            <div className="flex gap-1 mb-5 border-b border-gray-200 dark:border-gray-700 overflow-x-auto">
                { categoryTypeTabs.map( ( tab ) => (
                    <button
                        key={ tab.key }
                        onClick={ () => { setActiveTab( tab.key ); setEditingCat( null ); setSelectedCatIds( new Set() ); } }
                        className={ `flex items-center gap-1.5 px-4 py-2.5 text-sm font-medium border-b-2 transition-colors -mb-px whitespace-nowrap ${
                            activeTab === tab.key
                                ? 'border-blue-500 text-blue-600 dark:text-blue-400'
                                : 'border-transparent text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200'
                        }` }
                    >
                        <span>{ tab.label }</span>
                        <span className={ `ml-1 text-xs px-1.5 py-0.5 rounded-full ${ activeTab === tab.key ? 'bg-blue-100 text-blue-700 dark:bg-blue-900 dark:text-blue-300' : 'bg-gray-100 text-gray-500 dark:bg-gray-700 dark:text-gray-400' }` }>
                            { countForTab( tab.key ) }
                        </span>
                    </button>
                ) ) }
            </div>

            {/* Edit form (inline) */}
            { editingCat && (
                <div className="bg-white dark:bg-gray-800 rounded-xl shadow-md p-6 border border-indigo-200 dark:border-indigo-700 mb-6">
                    <h2 className="font-semibold text-gray-900 dark:text-white mb-4">{ t( 'categories.editCategory' ) }</h2>
                    <div className="flex gap-3 flex-wrap items-end">
                        <div className="flex-1 min-w-[200px]">
                            <label className="block text-xs text-gray-500 dark:text-gray-400 mb-1">{ t( 'common.name' ) }</label>
                            <input type="text" value={ editName } onChange={ ( e ) => setEditName( e.target.value ) } onKeyDown={ ( e ) => e.key === 'Enter' && handleUpdate() } className="jr-input w-full text-sm" />
                        </div>
                        <div className="flex-1 min-w-[200px]">
                            <label className="block text-xs text-gray-500 dark:text-gray-400 mb-1">{ t( 'common.description' ) }</label>
                            <input type="text" value={ editDescription } onChange={ ( e ) => setEditDescription( e.target.value ) } onKeyDown={ ( e ) => e.key === 'Enter' && handleUpdate() } className="jr-input w-full text-sm" />
                        </div>
                        <button onClick={ handleUpdate } disabled={ updateMutation.isPending } className="jr-btn-primary text-sm">
                            { updateMutation.isPending ? t( 'categories.saving' ) : t( 'common.save' ) }
                        </button>
                        <button onClick={ () => setEditingCat( null ) } className="px-4 py-2 text-sm bg-gray-200 dark:bg-gray-600 text-gray-700 dark:text-gray-200 rounded-lg hover:bg-gray-300 dark:hover:bg-gray-500 transition-colors">
                            { t( 'common.cancel' ) }
                        </button>
                    </div>
                </div>
            ) }

            {/* Create form */}
            <div className="bg-white dark:bg-gray-800 rounded-xl shadow-md p-6 border border-gray-200 dark:border-gray-700 mb-6">
                <h2 className="font-semibold text-gray-900 dark:text-white mb-4">
                    { t( 'categories.addNew' ) } <span className="text-blue-600 dark:text-blue-400">{ categoryTypeTabs.find( ( tab ) => tab.key === activeTab )?.label }</span>
                </h2>
                <div className="flex gap-3 flex-wrap items-end">
                    <div className="flex-1 min-w-[200px]">
                        <label className="block text-xs text-gray-500 dark:text-gray-400 mb-1">{ t( 'common.name' ) }</label>
                        <input type="text" value={ newName } onChange={ ( e ) => setNewName( e.target.value ) } onKeyDown={ ( e ) => e.key === 'Enter' && handleCreate() } className="jr-input w-full text-sm" placeholder={ t( 'categories.categoryNamePlaceholder' ) } />
                    </div>
                    <div className="flex-1 min-w-[200px]">
                        <label className="block text-xs text-gray-500 dark:text-gray-400 mb-1">{ t( 'common.descriptionOptional' ) }</label>
                        <input type="text" value={ newDescription } onChange={ ( e ) => setNewDescription( e.target.value ) } onKeyDown={ ( e ) => e.key === 'Enter' && handleCreate() } className="jr-input w-full text-sm" placeholder={ t( 'common.descriptionPlaceholder' ) } />
                    </div>
                    <button onClick={ handleCreate } disabled={ createMutation.isPending } className="jr-btn-primary text-sm">
                        { createMutation.isPending ? t( 'categories.adding' ) : t( 'categories.addButton' ) }
                    </button>
                </div>
                <p className="text-xs text-gray-400 dark:text-gray-500 mt-2">{ t( 'categories.multiAddHint' ) }</p>
            </div>

            {/* Category list */}
            <div className="bg-white dark:bg-gray-800 rounded-xl shadow-md border border-gray-200 dark:border-gray-700">
                { isLoading && <AdminSpinner /> }
                { ! isLoading && categories.length === 0 && (
                    <div className="p-8 text-center text-gray-500">{ t( 'categories.noCategories' ) }</div>
                ) }
                { categories.length > 0 && (
                    <>
                        { selectedCatIds.size > 0 && (
                            <div className="flex items-center gap-3 px-4 py-2.5 bg-blue-50 dark:bg-blue-950/40 border-b border-blue-200 dark:border-blue-800 rounded-t-xl">
                                <span className="text-sm text-blue-700 dark:text-blue-300 font-medium">{ selectedCatIds.size } { t( 'common.selected' ) }</span>
                                <button
                                    onClick={ handleBulkDeleteCats }
                                    disabled={ bulkDeleting }
                                    className="px-3 py-1.5 text-xs bg-red-600 text-white rounded-lg hover:bg-red-700 transition-colors disabled:opacity-50"
                                >
                                    { bulkDeleting ? '...' : t( 'categories.bulkDeleteSelected', { N: String( selectedCatIds.size ) } ) }
                                </button>
                                <button onClick={ () => setSelectedCatIds( new Set() ) } className="text-xs text-gray-500 hover:text-gray-700 dark:hover:text-gray-300 underline ml-auto">
                                    { t( 'common.cancel' ) }
                                </button>
                            </div>
                        ) }
                        <table className="w-full text-sm">
                            <thead>
                                <tr className="border-b border-gray-200 dark:border-gray-700 text-left text-gray-500 dark:text-gray-400">
                                    <th className="p-4 w-10">
                                        <input
                                            type="checkbox"
                                            checked={ selectedCatIds.size === categories.length }
                                            onChange={ ( e ) => setSelectedCatIds( e.target.checked ? new Set( categories.map( c => c.id ) ) : new Set() ) }
                                            className="rounded accent-blue-600"
                                        />
                                    </th>
                                    <th className="p-4 font-medium">{ t( 'common.name' ) }</th>
                                    <th className="p-4 font-medium">{ t( 'common.slug' ) }</th>
                                    <th className="p-4 font-medium">{ t( 'common.description' ) }</th>
                                    <th className="p-4 font-medium text-right">{ t( 'common.actions' ) }</th>
                                </tr>
                            </thead>
                            <tbody>
                                { categories.map( ( cat ) => (
                                    <tr key={ cat.id } className={ `border-b border-gray-100 dark:border-gray-700 hover:bg-gray-50 dark:hover:bg-gray-750 ${ selectedCatIds.has( cat.id ) ? 'bg-blue-50 dark:bg-blue-950/20' : '' }` }>
                                        <td className="p-4">
                                            <input
                                                type="checkbox"
                                                checked={ selectedCatIds.has( cat.id ) }
                                                onChange={ ( e ) => {
                                                    const next = new Set( selectedCatIds );
                                                    e.target.checked ? next.add( cat.id ) : next.delete( cat.id );
                                                    setSelectedCatIds( next );
                                                } }
                                                className="rounded accent-blue-600"
                                            />
                                        </td>
                                        <td className="p-4 font-medium text-gray-900 dark:text-white">{ cat.name }</td>
                                        <td className="p-4 text-gray-500 font-mono text-xs">{ cat.slug }</td>
                                        <td className="p-4 text-gray-500">{ cat.description || '—' }</td>
                                        <td className="p-4 text-right">
                                            <div className="flex gap-1 justify-end">
                                                <button onClick={ () => openEdit( cat ) } className="px-3 py-1.5 text-xs bg-blue-50 text-blue-700 dark:bg-blue-900 dark:text-blue-200 rounded-lg hover:bg-blue-100 dark:hover:bg-blue-800 transition-colors">
                                                    ✏️ { t( 'common.edit' ) }
                                                </button>
                                                <button
                                                    onClick={ () => { if ( window.confirm( t( 'categories.deleteConfirm' ) ) ) deleteMutation.mutate( cat.id ); } }
                                                    disabled={ deleteMutation.isPending }
                                                    className="px-3 py-1.5 text-xs bg-red-50 text-red-700 dark:bg-red-900 dark:text-red-200 rounded-lg hover:bg-red-100 dark:hover:bg-red-800 transition-colors"
                                                >🗑️</button>
                                            </div>
                                        </td>
                                    </tr>
                                ) ) }
                            </tbody>
                        </table>
                    </>
                ) }
            </div>
        </>
    );
};

/* ------------------------------------------------------------------ */
/*  SimpleRecordTab — reusable CRUD tab for Authors and Publishers     */
/* ------------------------------------------------------------------ */

const SimpleRecordTab: React.FC<{
    endpoint: string;
    queryKey: string;
    addNewLabel: string;
    editLabel: string;
    noItemsLabel: string;
    createdMsg: string;
    updatedMsg: string;
    deletedMsg: string;
    nameRequiredMsg: string;
    deleteConfirmMsg: string;
    flashMessage: ( msg: string ) => void;
}> = ( { endpoint, queryKey, addNewLabel, editLabel, noItemsLabel, createdMsg, updatedMsg, deletedMsg, nameRequiredMsg, deleteConfirmMsg, flashMessage } ) => {
    const { t } = useTranslation();
    const qc = useQueryClient();

    const [ newName, setNewName ] = useState( '' );
    const [ newDescription, setNewDescription ] = useState( '' );
    const [ editingRec, setEditingRec ] = useState<SimpleRecord | null>( null );
    const [ editName, setEditName ] = useState( '' );
    const [ editDescription, setEditDescription ] = useState( '' );
    const [ selectedRecIds, setSelectedRecIds ] = useState<Set<number>>( new Set() );
    const [ bulkDeleting, setBulkDeleting ] = useState( false );

    const { data: records = [], isLoading } = useQuery<SimpleRecord[]>( {
        queryKey: [ queryKey ],
        queryFn: async () => {
            const res = await fetch( `${API_BASE}/${endpoint}`, { headers: { 'X-WP-Nonce': getNonce() } } );
            const json = await res.json();
            if ( json.code ) throw new Error( json.message );
            return Array.isArray( json ) ? json : [];
        },
    } );

    const createMutation = useMutation( {
        mutationFn: async ( payload: { name: string; description: string } ) => {
            const res = await fetch( `${API_BASE}/${endpoint}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'X-WP-Nonce': getNonce() },
                body: JSON.stringify( payload ),
            } );
            const json = await res.json();
            if ( json.code ) throw new Error( json.message );
            return json;
        },
        onSuccess: () => {
            qc.invalidateQueries( { queryKey: [ queryKey ] } );
            setNewName( '' );
            setNewDescription( '' );
            flashMessage( createdMsg );
        },
        onError: ( err: Error ) => flashMessage( `❌ ${err.message}` ),
    } );

    const updateMutation = useMutation( {
        mutationFn: async ( payload: { id: number; name: string; description: string } ) => {
            const res = await fetch( `${API_BASE}/${endpoint}/${payload.id}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json', 'X-WP-Nonce': getNonce() },
                body: JSON.stringify( { name: payload.name, description: payload.description } ),
            } );
            const json = await res.json();
            if ( json.code ) throw new Error( json.message );
            return json;
        },
        onSuccess: () => {
            qc.invalidateQueries( { queryKey: [ queryKey ] } );
            setEditingRec( null );
            setEditName( '' );
            setEditDescription( '' );
            flashMessage( updatedMsg );
        },
        onError: ( err: Error ) => flashMessage( `❌ ${err.message}` ),
    } );

    const deleteMutation = useMutation( {
        mutationFn: async ( id: number ) => {
            const res = await fetch( `${API_BASE}/${endpoint}/${id}`, {
                method: 'DELETE',
                headers: { 'X-WP-Nonce': getNonce() },
            } );
            const json = await res.json();
            if ( json.code ) throw new Error( json.message );
            return json;
        },
        onSuccess: () => {
            qc.invalidateQueries( { queryKey: [ queryKey ] } );
            flashMessage( deletedMsg );
        },
        onError: ( err: Error ) => flashMessage( `❌ ${err.message}` ),
    } );

    const handleCreate = async () => {
        const names = newName.split( ',' ).map( ( n ) => n.trim() ).filter( Boolean );
        if ( names.length === 0 ) { flashMessage( nameRequiredMsg ); return; }
        if ( names.length === 1 ) {
            createMutation.mutate( { name: names[0], description: newDescription.trim() } );
            return;
        }
        for ( const name of names ) {
            await fetch( `${API_BASE}/${endpoint}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'X-WP-Nonce': getNonce() },
                body: JSON.stringify( { name, description: '' } ),
            } );
        }
        qc.invalidateQueries( { queryKey: [ queryKey ] } );
        setNewName( '' );
        setNewDescription( '' );
        flashMessage( createdMsg );
    };

    const handleBulkDelete = async () => {
        if ( selectedRecIds.size === 0 ) return;
        const count = selectedRecIds.size;
        if ( ! window.confirm( t( 'constants.confirmBulkDelete', { N: String( count ) } ) ) ) return;
        setBulkDeleting( true );
        for ( const id of selectedRecIds ) {
            await fetch( `${API_BASE}/${endpoint}/${id}`, { method: 'DELETE', headers: { 'X-WP-Nonce': getNonce() } } );
        }
        qc.invalidateQueries( { queryKey: [ queryKey ] } );
        setSelectedRecIds( new Set() );
        setBulkDeleting( false );
        flashMessage( t( 'constants.bulkDeleted', { N: String( count ) } ) );
    };

    const openEdit = ( rec: SimpleRecord ) => {
        setEditingRec( rec );
        setEditName( rec.name );
        setEditDescription( rec.description || '' );
    };

    const handleUpdate = () => {
        if ( ! editingRec ) return;
        if ( ! editName.trim() ) { flashMessage( nameRequiredMsg ); return; }
        updateMutation.mutate( { id: editingRec.id, name: editName.trim(), description: editDescription.trim() } );
    };

    return (
        <>
            {/* Edit form (inline) */}
            { editingRec && (
                <div className="bg-white dark:bg-gray-800 rounded-xl shadow-md p-6 border border-indigo-200 dark:border-indigo-700 mb-6">
                    <h2 className="font-semibold text-gray-900 dark:text-white mb-4">{ editLabel }</h2>
                    <div className="flex gap-3 flex-wrap items-end">
                        <div className="flex-1 min-w-[200px]">
                            <label className="block text-xs text-gray-500 dark:text-gray-400 mb-1">{ t( 'common.name' ) }</label>
                            <input type="text" value={ editName } onChange={ ( e ) => setEditName( e.target.value ) } onKeyDown={ ( e ) => e.key === 'Enter' && handleUpdate() } className="jr-input w-full text-sm" />
                        </div>
                        <div className="flex-1 min-w-[200px]">
                            <label className="block text-xs text-gray-500 dark:text-gray-400 mb-1">{ t( 'common.description' ) }</label>
                            <input type="text" value={ editDescription } onChange={ ( e ) => setEditDescription( e.target.value ) } onKeyDown={ ( e ) => e.key === 'Enter' && handleUpdate() } className="jr-input w-full text-sm" />
                        </div>
                        <button onClick={ handleUpdate } disabled={ updateMutation.isPending } className="jr-btn-primary text-sm">
                            { updateMutation.isPending ? t( 'constants.saving' ) : t( 'common.save' ) }
                        </button>
                        <button onClick={ () => setEditingRec( null ) } className="px-4 py-2 text-sm bg-gray-200 dark:bg-gray-600 text-gray-700 dark:text-gray-200 rounded-lg hover:bg-gray-300 dark:hover:bg-gray-500 transition-colors">
                            { t( 'common.cancel' ) }
                        </button>
                    </div>
                </div>
            ) }

            {/* Create form */}
            <div className="bg-white dark:bg-gray-800 rounded-xl shadow-md p-6 border border-gray-200 dark:border-gray-700 mb-6">
                <h2 className="font-semibold text-gray-900 dark:text-white mb-4">{ addNewLabel }</h2>
                <div className="flex gap-3 flex-wrap items-end">
                    <div className="flex-1 min-w-[200px]">
                        <label className="block text-xs text-gray-500 dark:text-gray-400 mb-1">{ t( 'common.name' ) }</label>
                        <input type="text" value={ newName } onChange={ ( e ) => setNewName( e.target.value ) } onKeyDown={ ( e ) => e.key === 'Enter' && handleCreate() } className="jr-input w-full text-sm" placeholder={ t( 'constants.namePlaceholder' ) } />
                    </div>
                    <div className="flex-1 min-w-[200px]">
                        <label className="block text-xs text-gray-500 dark:text-gray-400 mb-1">{ t( 'common.descriptionOptional' ) }</label>
                        <input type="text" value={ newDescription } onChange={ ( e ) => setNewDescription( e.target.value ) } onKeyDown={ ( e ) => e.key === 'Enter' && handleCreate() } className="jr-input w-full text-sm" placeholder={ t( 'common.descriptionPlaceholder' ) } />
                    </div>
                    <button onClick={ handleCreate } disabled={ createMutation.isPending } className="jr-btn-primary text-sm">
                        { createMutation.isPending ? t( 'constants.adding' ) : t( 'constants.addButton' ) }
                    </button>
                </div>
                <p className="text-xs text-gray-400 dark:text-gray-500 mt-2">{ t( 'constants.multiAddHint' ) }</p>
            </div>

            {/* Record list */}
            <div className="bg-white dark:bg-gray-800 rounded-xl shadow-md border border-gray-200 dark:border-gray-700">
                { isLoading && <AdminSpinner /> }
                { ! isLoading && records.length === 0 && (
                    <div className="p-8 text-center text-gray-500">{ noItemsLabel }</div>
                ) }
                { records.length > 0 && (
                    <>
                        { selectedRecIds.size > 0 && (
                            <div className="flex items-center gap-3 px-4 py-2.5 bg-blue-50 dark:bg-blue-950/40 border-b border-blue-200 dark:border-blue-800 rounded-t-xl">
                                <span className="text-sm text-blue-700 dark:text-blue-300 font-medium">{ selectedRecIds.size } { t( 'common.selected' ) }</span>
                                <button
                                    onClick={ handleBulkDelete }
                                    disabled={ bulkDeleting }
                                    className="px-3 py-1.5 text-xs bg-red-600 text-white rounded-lg hover:bg-red-700 transition-colors disabled:opacity-50"
                                >
                                    { bulkDeleting ? '...' : t( 'constants.bulkDeleteSelected', { N: String( selectedRecIds.size ) } ) }
                                </button>
                                <button onClick={ () => setSelectedRecIds( new Set() ) } className="text-xs text-gray-500 hover:text-gray-700 dark:hover:text-gray-300 underline ml-auto">
                                    { t( 'common.cancel' ) }
                                </button>
                            </div>
                        ) }
                        <table className="w-full text-sm">
                            <thead>
                                <tr className="border-b border-gray-200 dark:border-gray-700 text-left text-gray-500 dark:text-gray-400">
                                    <th className="p-4 w-10">
                                        <input
                                            type="checkbox"
                                            checked={ selectedRecIds.size === records.length }
                                            onChange={ ( e ) => setSelectedRecIds( e.target.checked ? new Set( records.map( r => r.id ) ) : new Set() ) }
                                            className="rounded accent-blue-600"
                                        />
                                    </th>
                                    <th className="p-4 font-medium">{ t( 'common.name' ) }</th>
                                    <th className="p-4 font-medium">{ t( 'common.slug' ) }</th>
                                    <th className="p-4 font-medium">{ t( 'common.description' ) }</th>
                                    <th className="p-4 font-medium text-right">{ t( 'common.actions' ) }</th>
                                </tr>
                            </thead>
                            <tbody>
                                { records.map( ( rec ) => (
                                    <tr key={ rec.id } className={ `border-b border-gray-100 dark:border-gray-700 hover:bg-gray-50 dark:hover:bg-gray-750 ${ selectedRecIds.has( rec.id ) ? 'bg-blue-50 dark:bg-blue-950/20' : '' }` }>
                                        <td className="p-4">
                                            <input
                                                type="checkbox"
                                                checked={ selectedRecIds.has( rec.id ) }
                                                onChange={ ( e ) => {
                                                    const next = new Set( selectedRecIds );
                                                    e.target.checked ? next.add( rec.id ) : next.delete( rec.id );
                                                    setSelectedRecIds( next );
                                                } }
                                                className="rounded accent-blue-600"
                                            />
                                        </td>
                                        <td className="p-4 font-medium text-gray-900 dark:text-white">{ rec.name }</td>
                                        <td className="p-4 text-gray-500 font-mono text-xs">{ rec.slug }</td>
                                        <td className="p-4 text-gray-500">{ rec.description || '—' }</td>
                                        <td className="p-4 text-right">
                                            <div className="flex gap-1 justify-end">
                                                <button onClick={ () => openEdit( rec ) } className="px-3 py-1.5 text-xs bg-blue-50 text-blue-700 dark:bg-blue-900 dark:text-blue-200 rounded-lg hover:bg-blue-100 dark:hover:bg-blue-800 transition-colors">
                                                    ✏️ { t( 'common.edit' ) }
                                                </button>
                                                <button
                                                    onClick={ () => { if ( window.confirm( deleteConfirmMsg ) ) deleteMutation.mutate( rec.id ); } }
                                                    disabled={ deleteMutation.isPending }
                                                    className="px-3 py-1.5 text-xs bg-red-50 text-red-700 dark:bg-red-900 dark:text-red-200 rounded-lg hover:bg-red-100 dark:hover:bg-red-800 transition-colors"
                                                >🗑️</button>
                                            </div>
                                        </td>
                                    </tr>
                                ) ) }
                            </tbody>
                        </table>
                    </>
                ) }
            </div>
        </>
    );
};

/* ------------------------------------------------------------------ */
/*  ConstantsPage — Sabitler (Kategoriler + Yazarlar + Yayıncılar)    */
/* ------------------------------------------------------------------ */

const ConstantsPage: React.FC = () => {
    const { t } = useTranslation();
    const [ message, setMessage ] = useState( '' );
    const [ mainTab, setMainTab ] = useState<'categories' | 'authors' | 'publishers'>( 'categories' );

    const flashMessage = ( msg: string ) => {
        setMessage( msg );
        setTimeout( () => setMessage( '' ), 3000 );
    };

    const mainTabs = [
        { key: 'categories' as const, label: t( 'constants.tabCategories' ) },
        { key: 'authors'    as const, label: t( 'constants.tabAuthors' ) },
        { key: 'publishers' as const, label: t( 'constants.tabPublishers' ) },
    ];

    return (
        <div className="p-6">
            <h1 className="text-2xl font-bold text-gray-900 dark:text-white mb-1">{ t( 'constants.title' ) }</h1>
            <p className="text-sm text-gray-500 dark:text-gray-400 mb-6">{ t( 'constants.subtitle' ) }</p>

            { message && (
                <div className="mb-4 px-4 py-2 bg-gray-100 dark:bg-gray-700 rounded-lg text-sm text-gray-800 dark:text-gray-200">
                    { message }
                </div>
            ) }

            {/* Main tabs: Kategoriler / Yazarlar / Yayıncılar */}
            <div className="flex gap-1 mb-6 border-b border-gray-200 dark:border-gray-700 overflow-x-auto">
                { mainTabs.map( ( tab ) => (
                    <button
                        key={ tab.key }
                        onClick={ () => setMainTab( tab.key ) }
                        className={ `px-5 py-2.5 text-sm font-semibold border-b-2 transition-colors -mb-px whitespace-nowrap ${
                            mainTab === tab.key
                                ? 'border-blue-500 text-blue-600 dark:text-blue-400'
                                : 'border-transparent text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200'
                        }` }
                    >
                        { tab.label }
                    </button>
                ) ) }
            </div>

            { mainTab === 'categories' && <CategoriesTab flashMessage={ flashMessage } /> }

            { mainTab === 'authors' && (
                <SimpleRecordTab
                    endpoint="authors"
                    queryKey="authors"
                    addNewLabel={ t( 'constants.addNewAuthor' ) }
                    editLabel={ t( 'constants.editAuthor' ) }
                    noItemsLabel={ t( 'constants.noAuthors' ) }
                    createdMsg={ t( 'constants.authorCreated' ) }
                    updatedMsg={ t( 'constants.authorUpdated' ) }
                    deletedMsg={ t( 'constants.authorDeleted' ) }
                    nameRequiredMsg={ t( 'constants.nameRequired' ) }
                    deleteConfirmMsg={ t( 'constants.deleteConfirm' ) }
                    flashMessage={ flashMessage }
                />
            ) }

            { mainTab === 'publishers' && (
                <SimpleRecordTab
                    endpoint="publishers"
                    queryKey="publishers"
                    addNewLabel={ t( 'constants.addNewPublisher' ) }
                    editLabel={ t( 'constants.editPublisher' ) }
                    noItemsLabel={ t( 'constants.noPublishers' ) }
                    createdMsg={ t( 'constants.publisherCreated' ) }
                    updatedMsg={ t( 'constants.publisherUpdated' ) }
                    deletedMsg={ t( 'constants.publisherDeleted' ) }
                    nameRequiredMsg={ t( 'constants.nameRequired' ) }
                    deleteConfirmMsg={ t( 'constants.deleteConfirm' ) }
                    flashMessage={ flashMessage }
                />
            ) }
        </div>
    );
};

/* ------------------------------------------------------------------ */
/*  Shared: ToggleSwitch                                               */
/* ------------------------------------------------------------------ */

const ToggleSwitch: React.FC<{ checked: boolean; onChange: ( v: boolean ) => void; disabled?: boolean }> = ( { checked, onChange, disabled } ) => (
    <label className={`relative inline-flex items-center shrink-0 ${disabled ? 'cursor-not-allowed opacity-50' : 'cursor-pointer'}`}>
        <input
            type="checkbox"
            checked={ checked }
            onChange={ ( e ) => !disabled && onChange( e.target.checked ) }
            disabled={ disabled }
            className="sr-only peer"
        />
        <div className="w-11 h-6 bg-gray-300 dark:bg-gray-600 rounded-full peer peer-checked:bg-primary-500
            peer-checked:after:translate-x-full after:content-[''] after:absolute after:top-[2px] after:start-[2px]
            after:bg-white after:border after:border-gray-300 after:rounded-full after:h-5 after:w-5 after:transition-all" />
    </label>
);

const PremiumLockIcon: React.FC<{ className?: string }> = ( { className = "w-4 h-4" } ) => (
    <svg
        xmlns="http://www.w3.org/2000/svg"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.5"
        strokeLinecap="round"
        strokeLinejoin="round"
        className={ `inline-block text-amber-500 dark:text-amber-400 shrink-0 ${className}` }
    >
        <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
        <path d="M7 11V7a5 5 0 0 1 10 0v4" />
    </svg>
);

const ProBadge: React.FC = () => {
    const locale = ( window as any ).jetreaderSettings?.locale || 'en';
    const label = locale === 'tr' ? 'PRO' : 'PRO';
    return (
        <span className="bg-amber-50 dark:bg-amber-950/30 text-amber-800 dark:text-amber-300 text-[10px] tracking-wide font-bold px-2 py-0.5 rounded border border-amber-200 dark:border-amber-800/40 flex items-center gap-1 shrink-0">
            <PremiumLockIcon className="w-3 h-3" />
            { label }
        </span>
    );
};

/* ------------------------------------------------------------------ */
/*  SettingsPage                                                       */
/* ------------------------------------------------------------------ */

const JR_PALETTES = [
    { slug: 'green',  hex: '#8cbc67' },
    { slug: 'blue',   hex: '#2563eb' },
    { slug: 'amber',  hex: '#d97706' },
    { slug: 'red',    hex: '#dc2626' },
    { slug: 'pink',   hex: '#db2777' },
    { slug: 'purple', hex: '#7c3aed' },
    { slug: 'gray',   hex: '#4b5563' },
    { slug: 'yellow', hex: '#facc15' },
    { slug: 'tan',    hex: '#d4a373' },
    { slug: 'cream',  hex: '#fdf0d5' },
    { slug: 'cyan',   hex: '#00b4d8' },
    { slug: 'rose',   hex: '#a53860' },
    { slug: 'silver', hex: '#ced4da' },
    { slug: 'teal',   hex: '#34a0a4' },
] as const;

const LicenseCard: React.FC<{
    licenseKey: string;
    licenseStatus: string;
    licenseExpires: string;
    onLicenseChange: () => void;
}> = ( { licenseKey, licenseStatus, licenseExpires, onLicenseChange } ) => {
    const { t } = useTranslation();
    const [ keyInput, setKeyInput ] = React.useState( licenseKey );
    const [ working, setWorking ] = React.useState( false );
    const [ msg, setMsg ] = React.useState( '' );
    const [ isError, setIsError ] = React.useState( false );

    const handleActivate = async () => {
        if ( ! keyInput.trim() ) return;
        setWorking( true );
        setMsg( '' );
        setIsError( false );
        try {
            const res = await fetch( `${API_BASE}/settings/license/activate`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'X-WP-Nonce': getNonce(),
                },
                body: JSON.stringify( { license_key: keyInput } ),
            } );
            const data = await res.json();
            if ( res.ok && data.success ) {
                setMsg( data.message || t( 'settings.licenseSuccessActive' ) );
                setTimeout( () => {
                    onLicenseChange();
                }, 1000 );
            } else {
                setIsError( true );
                setMsg( data.message || t( 'settings.licenseFailedActive' ) );
            }
        } catch {
            setIsError( true );
            setMsg( t( 'settings.licenseNetworkError' ) );
        } finally {
            setWorking( false );
        }
    };

    const handleDeactivate = async () => {
        setWorking( true );
        setMsg( '' );
        setIsError( false );
        try {
            const res = await fetch( `${API_BASE}/settings/license/deactivate`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'X-WP-Nonce': getNonce(),
                },
            } );
            const data = await res.json();
            if ( res.ok && data.success ) {
                setMsg( data.message || t( 'settings.licenseSuccessDeactive' ) );
                setTimeout( () => {
                    onLicenseChange();
                }, 1000 );
            } else {
                setIsError( true );
                setMsg( data.message || t( 'settings.licenseFailedDeactive' ) );
            }
        } catch {
            setIsError( true );
            setMsg( t( 'settings.licenseNetworkError' ) );
        } finally {
            setWorking( false );
        }
    };

    const isActive = licenseStatus === 'active';

    return (
        <div className="bg-white dark:bg-gray-800 rounded-xl shadow-md p-6 border border-gray-200 dark:border-gray-700 mb-6 relative overflow-hidden">
            {/* Elegant glassmorphic background highlight */}
            <div className="absolute -top-12 -right-12 w-32 h-32 bg-primary-500/5 rounded-full blur-xl pointer-events-none" />

            <h3 className="font-semibold text-gray-900 dark:text-white mb-2 flex items-center gap-2">
                { t( 'settings.licenseTitle' ) }
                { isActive ? (
                    <span className="bg-emerald-100 text-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-400 text-xs font-semibold px-2.5 py-0.5 rounded-full">
                        { t( 'settings.licenseActivePro' ) }
                    </span>
                ) : (
                    <span className="bg-amber-100 text-amber-800 dark:bg-amber-950/40 dark:text-amber-400 text-xs font-semibold px-2.5 py-0.5 rounded-full">
                        { t( 'settings.licenseFreeVersion' ) }
                    </span>
                ) }
            </h3>
            <p className="text-sm text-gray-500 dark:text-gray-400 mb-4">
                { isActive 
                    ? t( 'settings.licenseActiveDesc' )
                    : t( 'settings.licenseFreeDesc' )
                }
            </p>

            <div className="flex flex-col sm:flex-row gap-3">
                <input
                    type="text"
                    placeholder={ t( 'settings.licenseKeyPlaceholder' ) }
                    value={ keyInput }
                    onChange={ ( e ) => setKeyInput( e.target.value ) }
                    disabled={ isActive || working }
                    className="flex-1 text-sm border border-gray-300 dark:border-gray-600 rounded-lg px-3 py-2 bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 placeholder-gray-400 dark:placeholder-gray-500 font-mono disabled:opacity-70 disabled:bg-gray-50 dark:disabled:bg-gray-800"
                />
                { isActive ? (
                    <button
                        onClick={ handleDeactivate }
                        disabled={ working }
                        className="bg-red-600 hover:bg-red-750 text-white text-sm font-semibold px-4 py-2 rounded-lg transition-colors disabled:opacity-60 shrink-0"
                    >
                        { working ? t( 'settings.licenseProcessing' ) : t( 'settings.licenseDeactivate' ) }
                    </button>
                ) : (
                    <button
                        onClick={ handleActivate }
                        disabled={ working || !keyInput.trim() }
                        className="bg-primary-600 hover:bg-primary-750 text-white text-sm font-semibold px-4 py-2 rounded-lg transition-colors disabled:opacity-60 shrink-0"
                    >
                        { working ? t( 'settings.licenseActivating' ) : t( 'settings.licenseActivate' ) }
                    </button>
                ) }
            </div>

            { licenseExpires && isActive && (
                <p className="text-xs text-gray-500 dark:text-gray-400 mt-2 font-mono">
                    📅 { t( 'settings.licenseExpiryDate' ) }: { licenseExpires }
                </p>
            ) }

            { msg && (
                <div className={ `mt-4 p-3 rounded-lg text-sm ${
                    isError 
                        ? 'bg-red-50 dark:bg-red-950/20 border border-red-200 dark:border-red-800/40 text-red-850 dark:text-red-300' 
                        : 'bg-emerald-50 dark:bg-emerald-950/20 border border-emerald-200 dark:border-emerald-800/40 text-emerald-850 dark:text-emerald-300'
                }` }>
                    { msg }
                </div>
            ) }
        </div>
    );
};

const ProFeatureOverlay: React.FC<{ featureName: string; desc: string }> = ( { featureName, desc } ) => {
    const locale = ( window as any ).jetreaderSettings?.locale || 'en';
    const txt = ( en: string, tr: string ) => locale === 'tr' ? tr : en;

    return (
        <div className="flex flex-col items-center justify-center p-8 sm:p-12 text-center max-w-lg mx-auto my-12 bg-white dark:bg-gray-800 rounded-2xl shadow-xl border border-gray-200 dark:border-gray-700 relative overflow-hidden">
            {/* Background Accent Gradients */}
            <div className="absolute -top-24 -right-24 w-48 h-48 bg-primary-500/10 rounded-full blur-2xl pointer-events-none" />
            <div className="absolute -bottom-24 -left-24 w-48 h-48 bg-indigo-500/10 rounded-full blur-2xl pointer-events-none" />

            <div className="w-16 h-16 bg-amber-50 dark:bg-amber-950/30 rounded-full flex items-center justify-center mb-6 shadow-inner border border-amber-200/40 dark:border-amber-800/30 animate-pulse text-amber-500">
                <PremiumLockIcon className="w-8 h-8" />
            </div>
            
            <h2 className="text-2xl font-bold text-gray-900 dark:text-white mb-3">
                { featureName }
            </h2>
            
            <p className="text-gray-500 dark:text-gray-400 text-sm mb-6 max-w-sm">
                { desc }
            </p>
            
            <div className="flex flex-col sm:flex-row gap-3 justify-center w-full">
                <a
                    href="https://wplector.com"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="bg-primary-600 hover:bg-primary-700 text-white font-semibold px-6 py-2.5 rounded-xl transition-all shadow-md hover:shadow-lg text-sm shrink-0"
                >
                    🚀 { txt( 'Upgrade to JetReader Pro', 'JetReader Pro\'ya Yükselt' ) }
                </a>
                <button
                    onClick={ () => {
                        const popStateEvent = new PopStateEvent('popstate');
                        window.history.pushState(null, '', '#jetreader');
                        window.dispatchEvent(popStateEvent);
                    } }
                    className="bg-gray-100 hover:bg-gray-200 dark:bg-gray-700 dark:hover:bg-gray-650 text-gray-700 dark:text-gray-250 font-semibold px-6 py-2.5 rounded-xl transition-all text-sm shrink-0"
                >
                    { txt( 'Go to Dashboard', 'Kontrol Paneline Git' ) }
                </button>
            </div>
        </div>
    );
};

const sanitizeSlug = ( val: string ) => {
    return val.toLowerCase().replace(/[^a-z0-9-_]/g, '');
};

const SettingsPage: React.FC = () => {
    const { t } = useTranslation();
    const [ settings, setSettings ] = React.useState<Record<string, unknown>>( {} );
    const [ loading, setLoading ] = React.useState( true );
    const [ saving, setSaving ] = React.useState( false );
    const [ message, setMessage ] = React.useState( '' );
    const savedRef = React.useRef<string>( '{}' );
    const [ isDirty, setIsDirty ] = React.useState( false );

    const locale = ( window as any ).jetreaderSettings?.locale || 'en';
    const txt = ( en: string, tr: string ) => locale === 'tr' ? tr : en;
    const isLite = true;
    // Lite edition: only a whitelisted set of settings ships, and every shipped
    // control is fully functional (no locks). Pro-only sections are not rendered
    // at all. In the Pro edition `isPro` continues to reflect the license state.
    const isPro = false;
    const LITE_FILTERS       = [ 'show_filter_category', 'show_filter_language', 'show_filter_year' ];
    const LITE_CARD_FIELDS   = [ 'show_card_image', 'show_card_title' ];
    const LITE_DETAIL_FIELDS = [ 'show_detail_image', 'show_detail_title', 'show_detail_author' ];

    // Available languages from window.jetreaderSettings.
    const availableLanguages: Array<{ code: string; name: string }> =
        ( window as any ).jetreaderSettings?.availableLanguages || [];

    React.useEffect( () => {
        fetch( `${API_BASE}/settings`, {
            headers: { 'X-WP-Nonce': getNonce() },
        } )
            .then( ( res ) => res.json() )
            .then( ( data ) => {
                if ( data && ! data.code ) {
                    savedRef.current = JSON.stringify( data );
                    setSettings( data );
                }
            } )
            .catch( ( err ) => dbg( 'settings fetch error:', err ) )
            .finally( () => setLoading( false ) );
    }, [] );

    const updateSetting = ( key: string, value: unknown ) => {
        setSettings( ( prev ) => {
            const next = { ...prev, [ key ]: value };
            setIsDirty( JSON.stringify( next ) !== savedRef.current );
            return next;
        } );
    };

    // Warn on browser/tab close when there are unsaved changes.
    React.useEffect( () => {
        const handler = ( e: BeforeUnloadEvent ) => {
            if ( ! isDirty ) return;
            e.preventDefault();
            e.returnValue = t( 'settings.leaveWarning' );
        };
        window.addEventListener( 'beforeunload', handler );
        return () => window.removeEventListener( 'beforeunload', handler );
    }, [ isDirty, t ] );

    const saveSettings = async () => {
        setSaving( true );
        setMessage( '' );
        const previousLanguage = ( window as any ).jetreaderSettings?.locale || 'en';
        const newLanguage = settings.plugin_language || 'en';

        try {
            const res = await fetch( `${API_BASE}/settings`, {
                method: 'PUT',
                headers: {
                    'Content-Type': 'application/json',
                    'X-WP-Nonce': getNonce(),
                },
                body: JSON.stringify( settings ),
            } );
            const data = await res.json();
            if ( data && ! data.code ) {
                setMessage( t( 'settings.saved' ) );
                setSettings( data.settings );
                savedRef.current = JSON.stringify( data.settings );
                setIsDirty( false );

                // If the language changed, reload the page so PHP sends new translations.
                if ( newLanguage !== previousLanguage ) {
                    setTimeout( () => {
                        window.location.reload();
                    }, 500 );
                }
            } else {
                setMessage( t( 'settings.saveFailed' ) );
            }
        } catch {
            setMessage( t( 'settings.networkError' ) );
        } finally {
            setSaving( false );
            setTimeout( () => setMessage( '' ), 3000 );
        }
    };

    if ( loading ) {
        return <AdminSpinner />;
    }

    const licenseKey = String( settings.license_key || '' );
    const licenseStatus = String( settings.license_status || '' );
    const licenseExpires = String( settings.license_expires || '' );

    return (
        <div className="p-6 max-w-3xl">
            { isDirty && (
                <div className="mb-5 flex items-center gap-3 bg-amber-50 dark:bg-amber-900/20 border border-amber-300 dark:border-amber-700 rounded-lg px-4 py-3 text-sm text-amber-800 dark:text-amber-200">
                    <span className="shrink-0 text-base">⚠️</span>
                    <span className="flex-1">{ t( 'settings.unsavedWarning' ) }</span>
                    <button
                        onClick={ saveSettings }
                        disabled={ saving }
                        className="shrink-0 bg-amber-600 hover:bg-amber-700 text-white text-xs font-semibold px-3 py-1.5 rounded-lg transition-colors disabled:opacity-60"
                    >
                        { saving ? t( 'settings.saving' ) : t( 'settings.saveButton' ) }
                    </button>
                </div>
            ) }
            { message && (
                <div className={`mb-5 flex items-center gap-3 border rounded-lg px-4 py-3 text-sm ${
                    message === t( 'settings.saved' )
                        ? 'bg-emerald-50 dark:bg-emerald-900/20 border-emerald-300 dark:border-emerald-700 text-emerald-800 dark:text-emerald-200'
                        : 'bg-red-50 dark:bg-red-900/20 border-red-300 dark:border-red-700 text-red-800 dark:text-red-200'
                }`}>
                    <span className="shrink-0 text-base">
                        { message === t( 'settings.saved' ) ? '✅' : '❌' }
                    </span>
                    <span className="flex-1">{ message }</span>
                </div>
            ) }
            <div className="mb-8">
                <h1 className="text-2xl font-bold text-gray-900 dark:text-white">
                    {t('settings.title')}
                </h1>
                <p className="mt-1 text-gray-500 dark:text-gray-400 text-sm">
                    {t('settings.subtitle')}
                </p>
            </div>

            { isLite && <ProUpgradeBanner /> }

            <div className="space-y-6">
                {/* Pro License Verification Card */}
                { !isLite && (
                    <LicenseCard
                        licenseKey={ licenseKey }
                        licenseStatus={ licenseStatus }
                        licenseExpires={ licenseExpires }
                        onLicenseChange={ handleLicenseChange }
                    />
                ) }

                { ! isLite && ( <>
                {/* Plugin Language */}
                <div className="bg-white dark:bg-gray-800 rounded-xl shadow-md p-6 border border-gray-200 dark:border-gray-700">
                    <div className="flex items-center gap-2 mb-2">
                        <h3 className="font-semibold text-gray-900 dark:text-white">
                            🌐 {t('items.languageLabel')}
                        </h3>
                        { !isPro && <PremiumLockIcon className="w-4 h-4" /> }
                    </div>
                    <p className="text-sm text-gray-500 dark:text-gray-400 mb-3">
                        { t( 'settings.languageDesc' ) }
                    </p>
                    { !isPro && (
                        <p className="text-xs text-amber-600 dark:text-amber-400 font-medium mb-3">
                            ⚠️ { t( 'settings.languageProOnly' ) }
                        </p>
                    ) }
                    <select
                        value={ String( settings.plugin_language || 'en' ) }
                        onChange={ ( e ) => updateSetting( 'plugin_language', e.target.value ) }
                        className="text-sm border border-gray-300 dark:border-gray-600 rounded-lg px-3 py-2 bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100"
                    >
                        { availableLanguages.length > 0 ? (
                            availableLanguages.map( ( lang ) => (
                                <option key={ lang.code } value={ lang.code }>
                                    { lang.name }
                                </option>
                            ) )
                        ) : (
                            <>
                                <option value="en">English</option>
                                <option value="tr">Türkçe</option>
                                <option value="ar">العربية</option>
                                <option value="fr">Français</option>
                                <option value="de">Deutsch</option>
                                <option value="id">Bahasa Indonesia</option>
                                <option value="fa">فارسی</option>
                                <option value="ru">Русский</option>
                                <option value="es">Español</option>
                            </>
                        ) }
                    </select>
                </div>

                {/* Reader Logo */}
                <div className="bg-white dark:bg-gray-800 rounded-xl shadow-md p-6 border border-gray-200 dark:border-gray-700">
                    <div className="flex items-center gap-2 mb-2">
                        <h3 className="font-semibold text-gray-900 dark:text-white">
                            🖼️ { t( 'settings.logoTitle' ) }
                        </h3>
                        { !isPro && <PremiumLockIcon className="w-4 h-4" /> }
                    </div>
                    <p className="text-sm text-gray-500 dark:text-gray-400 mb-3">
                        { t( 'settings.logoDesc' ) }
                    </p>
                    { !isPro && (
                        <p className="text-xs text-amber-600 dark:text-amber-400 font-medium mb-3">
                            ⚠️ { t( 'settings.logoProOnly' ) }
                        </p>
                    ) }
                    <div className="flex items-center gap-3">
                        <input
                            type="url"
                            value={ String( settings.reader_logo_url || '' ) }
                            onChange={ ( e ) => updateSetting( 'reader_logo_url', e.target.value ) }
                            placeholder="https://..."
                            disabled={ !isPro }
                            className={ `flex-1 text-sm border border-gray-300 dark:border-gray-600 rounded-lg px-3 py-2 bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 placeholder-gray-400 dark:placeholder-gray-500 ${ !isPro ? 'bg-gray-100 dark:bg-gray-800/50 cursor-not-allowed opacity-60' : '' }` }
                        />
                        { !! settings.reader_logo_url && (
                            <img
                                src={ String( settings.reader_logo_url ) }
                                alt="Logo preview"
                                className="max-h-[40px] w-auto object-contain rounded border border-gray-200 dark:border-gray-600 p-1"
                                onError={ ( e ) => { ( e.target as HTMLImageElement ).style.display = 'none'; } }
                            />
                        ) }
                    </div>
                </div>

                {/* Annotation + Copy + Download */}
                <div className="bg-white dark:bg-gray-800 rounded-xl shadow-md border border-gray-200 dark:border-gray-700 divide-y sm:divide-y-0 sm:divide-x divide-gray-100 dark:divide-gray-700 sm:flex">
                    { [
                        { key: 'annotation_enabled', titleKey: 'settings.annotationTitle', descKey: 'settings.annotationDesc', isPremium: true },
                        { key: 'copy_enabled',        titleKey: 'settings.copyTitle',       descKey: 'settings.copyDesc', isPremium: true },
                        { key: 'download_enabled',    titleKey: 'settings.downloadTitle',   descKey: 'settings.downloadDesc', isPremium: true },
                    ].map( ( f ) => (
                        <div key={ f.key } className="flex items-center justify-between p-6 flex-1 relative">
                            <div className="mr-4">
                                <h3 className="font-semibold text-gray-900 dark:text-white text-sm flex items-center gap-1.5">
                                    { t( f.titleKey ) }
                                    { f.isPremium && !isPro && <PremiumLockIcon /> }
                                </h3>
                                <p className="text-sm text-gray-500 dark:text-gray-400 mt-0.5">{ t( f.descKey ) }</p>
                            </div>
                            <ToggleSwitch
                                checked={ f.isPremium && !isPro ? false : Boolean( settings[ f.key ] ) }
                                onChange={ ( v ) => updateSetting( f.key, v ) }
                                disabled={ f.isPremium && !isPro }
                            />
                        </div>
                    ) ) }
                </div>

                {/* WordPress Search Integration + Library Search */}
                <div className="bg-white dark:bg-gray-800 rounded-xl shadow-md border border-gray-200 dark:border-gray-700">
                    <div className="grid grid-cols-1 md:grid-cols-2 divide-y md:divide-y-0 md:divide-x divide-gray-200 dark:divide-gray-700">
                        <div className="flex items-center justify-between p-6">
                            <div className="mr-4">
                                <h3 className="font-semibold text-gray-900 dark:text-white text-sm flex items-center gap-1.5">
                                    { t( 'settings.wpSearchTitle' ) }
                                    { !isPro && <PremiumLockIcon /> }
                                </h3>
                                <p className="text-sm text-gray-500 dark:text-gray-400 mt-0.5">{ t( 'settings.wpSearchDesc' ) }</p>
                            </div>
                            <ToggleSwitch
                                checked={ !isPro ? false : settings.show_in_wp_search !== false }
                                onChange={ ( v ) => updateSetting( 'show_in_wp_search', v ) }
                                disabled={ !isPro }
                            />
                        </div>
                        <div className="flex items-center justify-between p-6">
                            <div className="mr-4">
                                <h3 className="font-semibold text-gray-900 dark:text-white text-sm flex items-center gap-1.5">
                                    { t( 'settings.librarySearchTitle' ) }
                                    { !isPro && <PremiumLockIcon /> }
                                </h3>
                                <p className="text-sm text-gray-500 dark:text-gray-400 mt-0.5">{ t( 'settings.librarySearchDesc' ) }</p>
                            </div>
                            <ToggleSwitch
                                checked={ !isPro ? false : settings.library_show_search !== false }
                                onChange={ ( v ) => updateSetting( 'library_show_search', v ) }
                                disabled={ !isPro }
                            />
                        </div>
                    </div>
                </div>

                {/* Upload Max Size */}
                <div className="bg-white dark:bg-gray-800 rounded-xl shadow-md p-6 border border-gray-200 dark:border-gray-700">
                    <h3 className="font-semibold text-gray-900 dark:text-white mb-2">
                        { t( 'settings.uploadMaxSize' ) }
                    </h3>
                    <input
                        type="number"
                        min={ 1 }
                        max={ 500 }
                        key={ `upload-size-${ Number( settings.upload_max_size ) || 100 }` }
                        defaultValue={ Number( settings.upload_max_size ) || 100 }
                        onBlur={ ( e ) => updateSetting( 'upload_max_size', Math.max( 1, Math.min( 500, parseInt( e.target.value, 10 ) || 100 ) ) ) }
                        className="w-24 text-sm border border-gray-300 dark:border-gray-600 rounded-lg px-3 py-2 bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100"
                    />
                </div>

                {/* Reader Font Size + Theme */}
                <div className="bg-white dark:bg-gray-800 rounded-xl shadow-md p-6 border border-gray-200 dark:border-gray-700">
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-5">
                        <div>
                            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                                { t( 'settings.fontSize' ) }
                            </label>
                            <select
                                value={ String( settings.reader_font_size || 'medium' ) }
                                onChange={ ( e ) => updateSetting( 'reader_font_size', e.target.value ) }
                                className="text-sm border border-gray-300 dark:border-gray-600 rounded-lg px-3 py-2 bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 w-full"
                            >
                                <option value="small">{ t( 'settings.fontSizeSmall' ) }</option>
                                <option value="medium">{ t( 'settings.fontSizeMedium' ) }</option>
                                <option value="large">{ t( 'settings.fontSizeLarge' ) }</option>
                                <option value="xlarge">{ t( 'settings.fontSizeXLarge' ) }</option>
                            </select>
                        </div>
                        <div>
                            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                                { t( 'settings.theme' ) }
                            </label>
                            <select
                                value={ String( settings.reader_theme || 'auto' ) }
                                onChange={ ( e ) => updateSetting( 'reader_theme', e.target.value ) }
                                className="text-sm border border-gray-300 dark:border-gray-600 rounded-lg px-3 py-2 bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 w-full"
                            >
                                <option value="auto">{ t( 'settings.themeAuto' ) }</option>
                                <option value="light">{ t( 'settings.themeLight' ) }</option>
                                <option value="dark">{ t( 'settings.themeDark' ) }</option>
                                <option value="sepia">{ t( 'settings.themeSepia' ) }</option>
                            </select>
                        </div>
                    </div>
                </div>

                {/* Custom URL Slugs */}
                <div className="bg-white dark:bg-gray-800 rounded-xl shadow-md p-6 border border-gray-200 dark:border-gray-700">
                    <div className="flex items-center gap-2 mb-2">
                        <h3 className="font-semibold text-gray-900 dark:text-white">
                            🔗 { t( 'settings.customSlugsTitle' ) }
                        </h3>
                        { !isPro && <ProBadge /> }
                    </div>
                    <p className="text-sm text-gray-500 dark:text-gray-400 mb-4">
                        { t( 'settings.customSlugsDesc' ) }
                    </p>
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                        { [
                            { key: 'cpt_slug_book',     label: t( 'settings.bookSlugLabel' ),     placeholder: 'jetreader-books',     def: 'jetreader-books' },
                            { key: 'cpt_slug_article',  label: t( 'settings.articleSlugLabel' ),  placeholder: 'jetreader-articles',  def: 'jetreader-articles' },
                            { key: 'cpt_slug_magazine', label: t( 'settings.magazineSlugLabel' ), placeholder: 'jetreader-magazines', def: 'jetreader-magazines' },
                            { key: 'cpt_slug_qa',       label: t( 'settings.qaSlugLabel' ),       placeholder: 'jetreader-qa',        def: 'jetreader-qa' },
                        ].map( ( f ) => (
                            <div key={ f.key }>
                                <label className="block text-xs font-medium text-gray-500 dark:text-gray-400 mb-1">
                                    { f.label }
                                </label>
                                <input
                                    type="text"
                                    value={ isPro ? String( settings[ f.key ] ?? f.def ) : f.def }
                                    onChange={ ( e ) => updateSetting( f.key, sanitizeSlug( e.target.value ) ) }
                                    placeholder={ f.placeholder }
                                    disabled={ !isPro }
                                    className={ `w-full text-sm border border-gray-300 dark:border-gray-600 rounded-lg px-3 py-2 bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 ${ !isPro ? 'bg-gray-100 dark:bg-gray-800/50 cursor-not-allowed opacity-60' : '' }` }
                                />
                            </div>
                        ) ) }
                    </div>
                </div>
                </> ) }

                {/* ---------- LIBRARY DISPLAY ---------- */}
                <div className="bg-white dark:bg-gray-800 rounded-xl shadow-md p-6 border border-gray-200 dark:border-gray-700">
                    <h2 className="text-base font-bold text-gray-900 dark:text-white mb-5 flex items-center gap-2">
                        { t( 'settings.libraryDisplay' ) }
                    </h2>

                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-5 mb-5">
                        {/* Items per page */}
                        <div>
                            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                                { t( 'settings.itemsPerPage' ) }
                            </label>
                            <select
                                value={ Number( settings.items_per_page ) || 24 }
                                onChange={ ( e ) => updateSetting( 'items_per_page', parseInt( e.target.value, 10 ) ) }
                                className="text-sm border border-gray-300 dark:border-gray-600 rounded-lg px-3 py-2 bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 w-full"
                            >
                                { [ 12, 24, 48, 96 ].map( ( n ) => (
                                    <option key={ n } value={ n }>{ n } { t( 'items.item' ) }</option>
                                ) ) }
                            </select>
                        </div>

                        {/* Grid columns */}
                        <div>
                            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                                { t( 'settings.gridColumns' ) }
                            </label>
                            <select
                                value={ Number( settings.grid_columns ) || 4 }
                                onChange={ ( e ) => updateSetting( 'grid_columns', parseInt( e.target.value, 10 ) ) }
                                className="text-sm border border-gray-300 dark:border-gray-600 rounded-lg px-3 py-2 bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 w-full"
                            >
                                { [ 2, 3, 4, 5, 6 ].map( ( n ) => (
                                    <option key={ n } value={ n }>{ n } { t( 'settings.columnUnit' ) }</option>
                                ) ) }
                            </select>
                        </div>
                    </div>

                    {/* Show sidebar */}
                    <div className="flex items-center justify-between py-3 border-t border-gray-100 dark:border-gray-700">
                        <div>
                            <p className="text-sm font-medium text-gray-700 dark:text-gray-300">{ t( 'settings.showSidebar' ) }</p>
                            <p className="text-xs text-gray-500 mt-0.5">{ t( 'settings.showSidebarDesc' ) }</p>
                        </div>
                        <ToggleSwitch
                            checked={ Boolean( settings.show_sidebar ?? true ) }
                            onChange={ ( v ) => updateSetting( 'show_sidebar', v ) }
                        />
                    </div>

                    { /* ── Sidebar filter toggles ── */ }
                    <div className="border-t-2 border-indigo-100 dark:border-indigo-900/40 mt-6 pt-5 mb-3">
                        <p className="text-xs font-bold text-indigo-600 dark:text-indigo-400 uppercase tracking-wider">
                            { t( 'settings.sidebarFilters' ) }
                        </p>
                    </div>
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-6">
                        { [
                            { key: 'show_filter_category', label: t( 'settings.filterCategories' ), desc: t( 'settings.filterCategoriesDesc' ), isPremium: false },
                            { key: 'show_filter_language', label: t( 'settings.filterLanguage' ),   desc: t( 'settings.filterLanguageDesc' ), isPremium: true },
                            { key: 'show_filter_year',     label: t( 'settings.filterYear' ),       desc: t( 'settings.filterYearDesc' ), isPremium: true },
                            { key: 'show_filter_author',     label: t( 'settings.filterAuthor' ),      desc: t( 'settings.filterAuthorDesc' ), isPremium: true },
                            { key: 'show_filter_publisher',  label: t( 'settings.filterPublisher' ),   desc: t( 'settings.filterPublisherDesc' ), isPremium: true },
                            { key: 'show_filter_translator', label: t( 'settings.filterTranslator' ),  desc: t( 'settings.filterTranslatorDesc' ), isPremium: true },
                            { key: 'show_filter_featured',   label: t( 'settings.filterFeatured' ),    desc: t( 'settings.filterFeaturedDesc' ), isPremium: true },
                            { key: 'show_filter_type',       label: t( 'settings.filterType' ),        desc: t( 'settings.filterTypeDesc' ), isPremium: true },
                        ].filter( ( f ) => ! isLite || LITE_FILTERS.includes( f.key ) ).map( ( f ) => (
                            <div key={ f.key } className="flex items-center justify-between py-2.5 border-t border-gray-100 dark:border-gray-700">
                                <div className="min-w-0 mr-3">
                                    <p className="text-sm font-medium text-gray-700 dark:text-gray-300 flex items-center gap-1.5">
                                        { f.label }
                                        { f.isPremium && !isPro && <PremiumLockIcon /> }
                                    </p>
                                    <p className="text-xs text-gray-500 mt-0.5">{ f.desc }</p>
                                </div>
                                <ToggleSwitch
                                    checked={ f.isPremium && !isPro ? false : Boolean( settings[ f.key ] ?? true ) }
                                    onChange={ ( v ) => updateSetting( f.key, v ) }
                                    disabled={ f.isPremium && !isPro }
                                />
                            </div>
                        ) ) }
                    </div>

                    { ! isLite && ( <>
                    { /* ── Library card appearance ── */ }
                    <div className="border-t-2 border-indigo-100 dark:border-indigo-900/40 mt-6 pt-5 mb-3">
                        <p className="text-xs font-bold text-indigo-600 dark:text-indigo-400 uppercase tracking-wider flex items-center gap-1.5">
                            { t( 'settings.libraryCardAppearance' ) }
                            { !isPro && <PremiumLockIcon /> }
                        </p>
                    </div>
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-5 mb-2">
                        <div>
                            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                                { t( 'settings.libraryImageSize' ) }
                            </label>
                            <select
                                value={ !isPro ? 'large' : String( settings.library_image_size ?? 'large' ) }
                                onChange={ ( e ) => updateSetting( 'library_image_size', e.target.value ) }
                                disabled={ !isPro }
                                className={ `text-sm border border-gray-300 dark:border-gray-600 rounded-lg px-3 py-2 bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 w-full ${ !isPro ? 'bg-gray-100 dark:bg-gray-800/50 cursor-not-allowed opacity-60' : '' }` }
                            >
                                <option value="small">{ t( 'displays.imageSizeSmall' ) }</option>
                                <option value="medium">{ t( 'displays.imageSizeMedium' ) }</option>
                                <option value="large">{ t( 'displays.imageSizeLarge' ) }</option>
                                <option value="xlarge">{ t( 'displays.imageSizeXLarge' ) }</option>
                                <option value="xxlarge">{ t( 'displays.imageSizeXXLarge' ) }</option>
                            </select>
                        </div>
                        <div>
                            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                                { t( 'settings.libraryImageFit' ) }
                            </label>
                            <select
                                value={ !isPro ? 'cover' : String( settings.library_image_fit ?? 'cover' ) }
                                onChange={ ( e ) => updateSetting( 'library_image_fit', e.target.value ) }
                                disabled={ !isPro }
                                className={ `text-sm border border-gray-300 dark:border-gray-600 rounded-lg px-3 py-2 bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 w-full ${ !isPro ? 'bg-gray-100 dark:bg-gray-800/50 cursor-not-allowed opacity-60' : '' }` }
                            >
                                <option value="cover">{ t( 'displays.imageFitCover' ) }</option>
                                <option value="contain">{ t( 'displays.imageFitContain' ) }</option>
                                <option value="fill">{ t( 'displays.imageFitFill' ) }</option>
                            </select>
                        </div>
                        <div>
                            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                                { t( 'displays.cardRadius' ) }
                            </label>
                            <select
                                value={ !isPro ? 'medium' : String( settings.library_card_radius ?? 'medium' ) }
                                onChange={ ( e ) => updateSetting( 'library_card_radius', e.target.value ) }
                                disabled={ !isPro }
                                className={ `text-sm border border-gray-300 dark:border-gray-600 rounded-lg px-3 py-2 bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 w-full ${ !isPro ? 'bg-gray-100 dark:bg-gray-800/50 cursor-not-allowed opacity-60' : '' }` }
                            >
                                <option value="none">{ t( 'displays.radiusNone' ) }</option>
                                <option value="small">{ t( 'displays.radiusSmall' ) }</option>
                                <option value="medium">{ t( 'displays.radiusMedium' ) }</option>
                                <option value="large">{ t( 'displays.radiusLarge' ) }</option>
                                <option value="xlarge">{ t( 'displays.radiusXLarge' ) }</option>
                            </select>
                        </div>
                        <div>
                            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                                { t( 'displays.cardBorder' ) }
                            </label>
                            <select
                                value={ !isPro ? 'subtle' : String( settings.library_card_border ?? 'subtle' ) }
                                onChange={ ( e ) => updateSetting( 'library_card_border', e.target.value ) }
                                disabled={ !isPro }
                                className={ `text-sm border border-gray-300 dark:border-gray-600 rounded-lg px-3 py-2 bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 w-full ${ !isPro ? 'bg-gray-100 dark:bg-gray-800/50 cursor-not-allowed opacity-60' : '' }` }
                            >
                                <option value="none">{ t( 'displays.borderNone' ) }</option>
                                <option value="subtle">{ t( 'displays.borderSubtle' ) }</option>
                                <option value="thick">{ t( 'displays.borderThick' ) }</option>
                            </select>
                        </div>
                        <div>
                            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                                { t( 'displays.cardShadow' ) }
                            </label>
                            <select
                                value={ !isPro ? 'subtle' : String( settings.library_card_shadow ?? 'subtle' ) }
                                onChange={ ( e ) => updateSetting( 'library_card_shadow', e.target.value ) }
                                disabled={ !isPro }
                                className={ `text-sm border border-gray-300 dark:border-gray-600 rounded-lg px-3 py-2 bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 w-full ${ !isPro ? 'bg-gray-100 dark:bg-gray-800/50 cursor-not-allowed opacity-60' : '' }` }
                            >
                                <option value="none">{ t( 'displays.shadowNone' ) }</option>
                                <option value="subtle">{ t( 'displays.shadowSubtle' ) }</option>
                                <option value="medium">{ t( 'displays.shadowMedium' ) }</option>
                                <option value="large">{ t( 'displays.shadowLarge' ) }</option>
                            </select>
                        </div>
                        <div>
                            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                                { t( 'displays.cardHover' ) }
                            </label>
                            <select
                                value={ !isPro ? 'zoom' : String( settings.library_card_hover ?? 'zoom' ) }
                                onChange={ ( e ) => updateSetting( 'library_card_hover', e.target.value ) }
                                disabled={ !isPro }
                                className={ `text-sm border border-gray-300 dark:border-gray-600 rounded-lg px-3 py-2 bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 w-full ${ !isPro ? 'bg-gray-100 dark:bg-gray-800/50 cursor-not-allowed opacity-60' : '' }` }
                            >
                                <option value="none">{ t( 'displays.hoverNone' ) }</option>
                                <option value="lift">{ t( 'displays.hoverLift' ) }</option>
                                <option value="zoom">{ t( 'displays.hoverZoom' ) }</option>
                                <option value="glow">{ t( 'displays.hoverGlow' ) }</option>
                                <option value="shadow">{ t( 'displays.hoverShadow' ) }</option>
                            </select>
                        </div>
                        <div>
                            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                                { t( 'displays.cardAlign' ) }
                            </label>
                            <select
                                value={ !isPro ? 'left' : String( settings.library_card_align ?? 'left' ) }
                                onChange={ ( e ) => updateSetting( 'library_card_align', e.target.value ) }
                                disabled={ !isPro }
                                className={ `text-sm border border-gray-300 dark:border-gray-600 rounded-lg px-3 py-2 bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 w-full ${ !isPro ? 'bg-gray-100 dark:bg-gray-800/50 cursor-not-allowed opacity-60' : '' }` }
                            >
                                <option value="left">{ t( 'displays.alignLeft' ) }</option>
                                <option value="center">{ t( 'displays.alignCenter' ) }</option>
                            </select>
                        </div>
                        <div>
                            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                                { t( 'displays.cardLayout' ) }
                            </label>
                            <select
                                value={ !isPro ? 'vertical' : String( settings.library_card_layout ?? 'vertical' ) }
                                onChange={ ( e ) => updateSetting( 'library_card_layout', e.target.value ) }
                                disabled={ !isPro }
                                className={ `text-sm border border-gray-300 dark:border-gray-600 rounded-lg px-3 py-2 bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 w-full ${ !isPro ? 'bg-gray-100 dark:bg-gray-800/50 cursor-not-allowed opacity-60' : '' }` }
                            >
                                <option value="vertical">{ t( 'displays.layoutVertical' ) }</option>
                                <option value="horizontal">{ t( 'displays.layoutHorizontal' ) }</option>
                            </select>
                        </div>
                    </div>
                    <div className="flex items-center justify-between py-3 border-t border-gray-100 dark:border-gray-700">
                        <div>
                            <p className="text-sm font-medium text-gray-700 dark:text-gray-300">{ t( 'settings.libraryCardMinWidth' ) }</p>
                            <p className="text-xs text-gray-500 mt-0.5">{ t( 'settings.libraryCardMinWidthDesc' ) }</p>
                        </div>
                        <div className="flex items-center gap-1.5">
                            <input
                                type="number" min={ 80 } max={ 600 }
                                key={ `card-min-width-${ !isPro ? 180 : (settings.library_card_min_width ?? 180) }` }
                                defaultValue={ !isPro ? 180 : Number( settings.library_card_min_width ?? 180 ) }
                                onBlur={ ( e ) => updateSetting( 'library_card_min_width', Math.max( 80, Math.min( 600, parseInt( e.target.value ) || 180 ) ) ) }
                                disabled={ !isPro }
                                className={ `w-24 text-sm border border-gray-300 dark:border-gray-600 rounded-lg px-3 py-1.5 bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 text-right ${ !isPro ? 'opacity-60 bg-gray-100 dark:bg-gray-800 cursor-not-allowed' : '' }` }
                            />
                            <span className="text-sm text-gray-400">px</span>
                        </div>
                    </div>

                    </> ) }

                    { /* ── Card field visibility (includes buttons) ── */ }
                    <div className="border-t-2 border-indigo-100 dark:border-indigo-900/40 mt-6 pt-5 mb-3">
                        <p className="text-xs font-bold text-indigo-600 dark:text-indigo-400 uppercase tracking-wider">
                            { t( 'settings.cardFieldsVisibility' ) }
                        </p>
                    </div>
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-6">
                        { [
                            { key: 'show_card_image',       label: t( 'settings.cardImage' ),       desc: t( 'settings.cardImageDesc' ),       def: true,  isPremium: true },
                            { key: 'show_card_title',       label: t( 'settings.cardTitle' ),       desc: t( 'settings.cardTitleDesc' ),       def: true,  isPremium: false },
                            { key: 'show_card_author',      label: t( 'settings.cardAuthor' ),      desc: t( 'settings.cardAuthorDesc' ),      def: true,  isPremium: true },
                            { key: 'show_card_translator',  label: t( 'settings.cardTranslator' ),  desc: t( 'settings.cardTranslatorDesc' ),  def: false, isPremium: true },
                            { key: 'show_card_publisher',   label: t( 'settings.cardPublisher' ),   desc: t( 'settings.cardPublisherDesc' ),   def: false, isPremium: true },
                            { key: 'show_card_year',        label: t( 'settings.cardYear' ),        desc: t( 'settings.cardYearDesc' ),        def: true,  isPremium: true },
                            { key: 'show_card_type',        label: t( 'settings.cardType' ),        desc: t( 'settings.cardTypeDesc' ),        def: true,  isPremium: true },
                            { key: 'show_card_language',    label: t( 'settings.cardLanguage' ),    desc: t( 'settings.cardLanguageDesc' ),    def: false, isPremium: true },
                        ].filter( ( f ) => ! isLite || LITE_CARD_FIELDS.includes( f.key ) ).map( ( f ) => (
                            <div key={ f.key } className="flex items-center justify-between py-2.5 border-t border-gray-100 dark:border-gray-700">
                                <div className="min-w-0 mr-3">
                                    <p className="text-sm font-medium text-gray-700 dark:text-gray-300 flex items-center gap-1.5">
                                        { f.label }
                                        { f.isPremium && !isPro && <PremiumLockIcon /> }
                                    </p>
                                    <p className="text-xs text-gray-500 mt-0.5">{ f.desc }</p>
                                </div>
                                <ToggleSwitch
                                    checked={ f.isPremium && !isPro ? false : Boolean( settings[ f.key ] ?? f.def ) }
                                    onChange={ ( v ) => updateSetting( f.key, v ) }
                                    disabled={ f.isPremium && !isPro }
                                />
                            </div>
                        ) ) }
                        { ! isLite && ( <>
                        <div className="flex items-center justify-between py-2.5 border-t border-gray-100 dark:border-gray-700">
                            <div className="min-w-0 mr-3">
                                <p className="text-sm font-medium text-gray-700 dark:text-gray-300 flex items-center gap-1.5">
                                    { t( 'settings.libraryShowReadBtn' ) }
                                    { !isPro && <PremiumLockIcon /> }
                                </p>
                                <p className="text-xs text-gray-500 mt-0.5">{ t( 'settings.libraryShowReadBtnDesc' ) }</p>
                            </div>
                            <ToggleSwitch
                                checked={ !isPro ? true : settings.library_show_read_button !== false }
                                onChange={ ( v ) => updateSetting( 'library_show_read_button', v ) }
                                disabled={ !isPro }
                            />
                        </div>
                        <div className="flex items-center justify-between py-2.5 border-t border-gray-100 dark:border-gray-700">
                            <div className="min-w-0 mr-3">
                                <p className="text-sm font-medium text-gray-700 dark:text-gray-300 flex items-center gap-1.5">
                                    { t( 'settings.libraryShowInfoBtn' ) }
                                    { !isPro && <PremiumLockIcon /> }
                                </p>
                                <p className="text-xs text-gray-500 mt-0.5">{ t( 'settings.libraryShowInfoBtnDesc' ) }</p>
                            </div>
                            <ToggleSwitch
                                checked={ !isPro ? true : settings.library_show_info_button !== false }
                                onChange={ ( v ) => updateSetting( 'library_show_info_button', v ) }
                                disabled={ !isPro }
                            />
                        </div>
                        </> ) }
                    </div>

                    { /* ── Detail field visibility ── */ }
                    <div className="border-t-2 border-indigo-100 dark:border-indigo-900/40 mt-6 pt-5 mb-3">
                        <p className="text-xs font-bold text-indigo-600 dark:text-indigo-400 uppercase tracking-wider">
                            { t( 'settings.detailFieldsVisibility' ) }
                        </p>
                        <p className="text-xs text-gray-500 mt-0.5">{ t( 'settings.detailFieldsVisibilityDesc' ) }</p>
                    </div>
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-6">
                        { [
                            { key: 'show_detail_image',       label: t( 'settings.detailImage' ),       desc: t( 'settings.detailImageDesc' ),       def: true,  isPremium: true },
                            { key: 'show_detail_title',       label: t( 'settings.detailTitle' ),       desc: t( 'settings.detailTitleDesc' ),       def: true,  isPremium: false },
                            { key: 'show_detail_author',      label: t( 'settings.detailAuthor' ),      desc: t( 'settings.detailAuthorDesc' ),      def: true,  isPremium: false },
                            { key: 'show_detail_translator',  label: t( 'settings.detailTranslator' ),  desc: t( 'settings.detailTranslatorDesc' ),  def: true,  isPremium: true },
                            { key: 'show_detail_publisher',   label: t( 'settings.detailPublisher' ),   desc: t( 'settings.detailPublisherDesc' ),   def: true,  isPremium: true },
                            { key: 'show_detail_year',        label: t( 'settings.detailYear' ),        desc: t( 'settings.detailYearDesc' ),        def: true,  isPremium: true },
                            { key: 'show_detail_type',        label: t( 'settings.detailType' ),        desc: t( 'settings.detailTypeDesc' ),        def: true,  isPremium: true },
                            { key: 'show_detail_language',    label: t( 'settings.detailLanguage' ),    desc: t( 'settings.detailLanguageDesc' ),    def: true,  isPremium: true },
                        ].filter( ( f ) => ! isLite || LITE_DETAIL_FIELDS.includes( f.key ) ).map( ( f ) => (
                            <div key={ f.key } className="flex items-center justify-between py-2.5 border-t border-gray-100 dark:border-gray-700">
                                <div className="min-w-0 mr-3">
                                    <p className="text-sm font-medium text-gray-700 dark:text-gray-300 flex items-center gap-1.5">
                                        { f.label }
                                        { f.isPremium && !isPro && <PremiumLockIcon /> }
                                    </p>
                                    <p className="text-xs text-gray-500 mt-0.5">{ f.desc }</p>
                                </div>
                                <ToggleSwitch
                                    checked={ f.isPremium && !isPro ? false : Boolean( settings[ f.key ] ?? f.def ) }
                                    onChange={ ( v ) => updateSetting( f.key, v ) }
                                    disabled={ f.isPremium && !isPro }
                                />
                            </div>
                        ) ) }
                    </div>
                </div>

                { ! isLite && ( <>
                {/* Color Themes */}
                <div className="bg-white dark:bg-gray-800 rounded-xl shadow-md p-6 border border-gray-200 dark:border-gray-700">
                    <h3 className="font-semibold text-gray-900 dark:text-white mb-1">
                        { t( 'colors.sectionTitle' ) }
                    </h3>
                    <p className="text-sm text-gray-500 dark:text-gray-400 mb-5">
                        { t( 'colors.sectionDesc' ) }
                    </p>
                    { [
                        { key: 'library_palette', labelKey: 'colors.libraryLabel', isPremium: true },
                        { key: 'grid_palette',    labelKey: 'colors.gridLabel',    isPremium: true },
                        { key: 'slider_palette',  labelKey: 'colors.sliderLabel',  isPremium: true },
                    ].map( ( { key, labelKey, isPremium } ) => (
                        <div key={ key } className="py-4 border-t border-gray-100 dark:border-gray-700 first:border-t-0 first:pt-0">
                            <p className="text-sm font-medium text-gray-700 dark:text-gray-300 mb-3 flex items-center gap-1.5">
                                { t( labelKey ) }
                                { isPremium && !isPro && <PremiumLockIcon /> }
                            </p>
                            <div className="flex gap-3 flex-wrap">
                                { JR_PALETTES.map( ( p ) => {
                                    const active = ( ( settings as Record<string, unknown> )[ key ] ?? 'green' ) === p.slug;
                                    const disabled = !isPro && p.slug !== 'green';
                                    return (
                                        <button
                                            key={ p.slug }
                                            title={ t( `colors.${p.slug}` ) }
                                            onClick={ () => !disabled && updateSetting( key, p.slug ) }
                                            style={ { backgroundColor: p.hex } }
                                            disabled={ disabled }
                                            className={ `relative w-9 h-9 rounded-full border-2 transition-all duration-150 ${ active ? 'border-gray-800 dark:border-white scale-110 shadow-md' : 'border-transparent hover:scale-105 hover:shadow-sm' } ${ disabled ? 'opacity-25 cursor-not-allowed scale-95' : '' }` }
                                        >
                                            { active && (
                                                <span className="absolute inset-0 flex items-center justify-center text-white text-sm font-bold drop-shadow">✓</span>
                                            ) }
                                        </button>
                                    );
                                } ) }
                            </div>
                        </div>
                    ) ) }
                </div>

                {/* Display Defaults */}
                <div className="bg-white dark:bg-gray-800 rounded-xl shadow-md p-6 border border-gray-200 dark:border-gray-700">
                    <h3 className="font-semibold text-gray-900 dark:text-white mb-1 flex items-center gap-1.5">
                        🖼 { t( 'displays.displayDefaultsTitle' ) }
                        { !isPro && <PremiumLockIcon /> }
                    </h3>
                    <div className="flex items-start justify-between gap-4 mb-4">
                        <p className="text-sm text-gray-500 dark:text-gray-400">
                            { t( 'displays.displayDefaultsDesc' ) }
                        </p>
                        <NavLink
                            page="jetreader-displays"
                            className="shrink-0 text-xs px-3 py-1.5 rounded-lg border border-gray-300 dark:border-gray-600 text-gray-600 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700 transition-colors whitespace-nowrap"
                        >
                            { t( 'displays.goToDisplays' ) }
                        </NavLink>
                    </div>

                    <p className="text-xs font-semibold text-gray-400 dark:text-gray-500 uppercase tracking-wider mb-3">
                        { t( 'displays.cardFieldsSection' ) }
                    </p>
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-6">
                        { [
                            { key: 'display_show_image',        label: t( 'displays.showCoverImage' ),      desc: t( 'displays.showCoverImageDesc' ),    def: true  },
                            { key: 'display_show_description',  label: t( 'displays.showDescriptionLabel' ), desc: t( 'displays.showDescriptionDesc' ),   def: false },
                            { key: 'display_show_type',         label: t( 'displays.showTypeBadge' ),       desc: t( 'displays.showTypeBadgeDesc' ),     def: true  },
                            { key: 'display_show_author',       label: t( 'displays.showAuthorName' ),      desc: t( 'displays.showAuthorNameDesc' ),    def: true  },
                            { key: 'display_show_read_button',  label: t( 'displays.showReadButton' ),      desc: t( 'displays.showReadButtonDesc' ),    def: true  },
                            { key: 'display_show_info_button',  label: t( 'displays.showInfoButton' ),      desc: t( 'displays.showInfoButtonDesc' ),    def: true  },
                        ].map( f => (
                            <div key={ f.key } className="flex items-center justify-between py-2.5 border-t border-gray-100 dark:border-gray-700">
                                <div className="min-w-0 mr-3">
                                    <p className="text-sm font-medium text-gray-700 dark:text-gray-300 flex items-center gap-1.5">
                                        { f.label }
                                        { !isPro && <PremiumLockIcon /> }
                                    </p>
                                    <p className="text-xs text-gray-500 mt-0.5">{ f.desc }</p>
                                </div>
                                <ToggleSwitch
                                    checked={ !isPro ? (f.key !== 'display_show_description') : Boolean( settings[ f.key ] ?? f.def ) }
                                    onChange={ v => updateSetting( f.key, v ) }
                                    disabled={ !isPro }
                                />
                            </div>
                        ) ) }
                    </div>

                    <p className="text-xs font-semibold text-gray-400 dark:text-gray-500 uppercase tracking-wider mt-5 mb-3">
                        { t( 'displays.gridDefaultsSection' ) }
                    </p>
                    { [
                        { key: 'grid_columns_desktop', label: t( 'displays.desktopColumns' ), min: 1, max: 6, def: 4 },
                        { key: 'grid_columns_tablet',  label: t( 'displays.tabletColumns' ),  min: 1, max: 4, def: 2 },
                        { key: 'grid_columns_mobile',  label: t( 'displays.mobileColumns' ),  min: 1, max: 2, def: 1 },
                    ].map( f => (
                        <div key={ f.key } className="flex items-center justify-between py-2.5 border-t border-gray-100 dark:border-gray-700">
                            <p className="text-sm font-medium text-gray-700 dark:text-gray-300 flex items-center gap-1.5">
                                { f.label }
                                { !isPro && <PremiumLockIcon /> }
                            </p>
                            <input
                                type="number"
                                min={ f.min }
                                max={ f.max }
                                key={ `${ f.key }-${ !isPro ? f.def : Number( settings[ f.key ] ?? f.def ) }` }
                                defaultValue={ !isPro ? f.def : Number( settings[ f.key ] ?? f.def ) }
                                onBlur={ e => updateSetting( f.key, Math.max( f.min, Math.min( f.max, parseInt( e.target.value ) || f.def ) ) ) }
                                disabled={ !isPro }
                                className={ `w-20 text-sm border border-gray-300 dark:border-gray-600 rounded-lg px-3 py-1.5 bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 text-center ${ !isPro ? 'opacity-60 bg-gray-100 dark:bg-gray-800 cursor-not-allowed' : '' }` }
                            />
                        </div>
                    ) ) }

                    <p className="text-xs font-semibold text-gray-400 dark:text-gray-500 uppercase tracking-wider mt-5 mb-3">
                        { t( 'displays.sliderDefaultsSection' ) }
                    </p>
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-6">
                        { [
                            { key: 'slider_show_arrows',      label: t( 'displays.showNavigationArrows' ), desc: t( 'displays.showNavigationArrowsDesc' ) },
                            { key: 'slider_show_dots',        label: t( 'displays.showDotNavigation' ),    desc: t( 'displays.showDotNavigationDesc' ) },
                            { key: 'slider_drag',             label: t( 'displays.enableMouseDrag' ),      desc: t( 'displays.enableMouseDragDesc' ) },
                            { key: 'slider_autoplay_default', label: t( 'displays.autoplayDefault' ),      desc: t( 'displays.autoplayDefaultDesc' ) },
                        ].map( f => (
                            <div key={ f.key } className="flex items-center justify-between py-2.5 border-t border-gray-100 dark:border-gray-700">
                                <div className="min-w-0 mr-3">
                                    <p className="text-sm font-medium text-gray-700 dark:text-gray-300 flex items-center gap-1.5">
                                        { f.label }
                                        { !isPro && <PremiumLockIcon /> }
                                    </p>
                                    <p className="text-xs text-gray-500 mt-0.5">{ f.desc }</p>
                                </div>
                                <ToggleSwitch
                                    checked={ !isPro ? (f.key !== 'slider_autoplay_default') : Boolean( settings[ f.key ] ?? ( f.key !== 'slider_autoplay_default' ) ) }
                                    onChange={ v => updateSetting( f.key, v ) }
                                    disabled={ !isPro }
                                />
                            </div>
                        ) ) }
                    </div>
                    <div className="flex items-center justify-between py-2.5 border-t border-gray-100 dark:border-gray-700">
                        <p className="text-sm font-medium text-gray-700 dark:text-gray-300 flex items-center gap-1.5">
                            { t( 'displays.autoplaySpeedLabel' ) }
                            { !isPro && <PremiumLockIcon /> }
                        </p>
                        <input
                            type="number"
                            min={ 500 }
                            max={ 10000 }
                            step={ 500 }
                            key={ `autoplay-speed-${ !isPro ? 3000 : (settings.slider_autoplay_speed ?? 3000) }` }
                            defaultValue={ !isPro ? 3000 : Number( settings.slider_autoplay_speed ?? 3000 ) }
                            onBlur={ e => updateSetting( 'slider_autoplay_speed', Math.max( 500, Math.min( 10000, parseInt( e.target.value ) || 3000 ) ) ) }
                            disabled={ !isPro }
                            className={ `w-24 text-sm border border-gray-300 dark:border-gray-600 rounded-lg px-3 py-1.5 bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 text-center ${ !isPro ? 'opacity-60 bg-gray-100 dark:bg-gray-800 cursor-not-allowed' : '' }` }
                        />
                    </div>
                </div>
                </> ) }
            </div>{/* /space-y-6 */}

            {/* Save Button + Message */}
            <div className="mt-8 flex items-center gap-4">
                <button onClick={ saveSettings } disabled={ !isDirty || saving } className="jr-btn-primary disabled:opacity-50 disabled:cursor-not-allowed">
                    { saving ? t( 'settings.saving' ) : t( 'settings.saveButton' ) }
                </button>
                { message && (
                    <p className="text-sm text-gray-700 dark:text-gray-300">{ message }</p>
                ) }
            </div>
        </div>
    );
};

const handleLicenseChange = () => {
    window.location.reload();
};

/* ------------------------------------------------------------------ */
/*  AboutPage — Plugin info, support links, system info               */
/* ------------------------------------------------------------------ */

declare const jetreaderSettings: {
    apiUrl: string;
    nonce: string;
    pluginUrl: string;
    locale: string;
    translations: Record<string, unknown>;
    availableLanguages: string[];
    isLoggedIn: boolean;
    siteUrl: string;
    isPro?: boolean;
    systemInfo?: {
        pluginVersion: string;
        wpVersion: string;
        phpVersion: string;
        elementor: string | false;
    };
};

const REBUILD_BATCH_SIZE = 3; // items per request — small enough to stay under server timeouts

const AboutPage: React.FC = () => {
    const { t } = useTranslation();
    const isPro = ( window as any ).jetreaderSettings?.isPro ?? false;
    const info = ( window as unknown as { jetreaderSettings?: typeof jetreaderSettings } ).jetreaderSettings?.systemInfo;

    type RebuildPhase = 'idle' | 'preparing' | 'indexing' | 'cleanup' | 'done' | 'error';

    const [ phase,        setPhase        ] = React.useState<RebuildPhase>( 'idle' );
    const [ progress,     setProgress     ] = React.useState( { current: 0, total: 0, title: '' } );
    const [ resultMsg,    setResultMsg     ] = React.useState( '' );
    const [ failCount,    setFailCount     ] = React.useState( 0 );
    const abortRef = React.useRef<AbortController | null>( null );

    // Warn user if they try to close/navigate away while indexing.
    React.useEffect( () => {
        if ( phase !== 'indexing' && phase !== 'preparing' && phase !== 'cleanup' ) return;
        const handler = ( e: BeforeUnloadEvent ) => {
            e.preventDefault();
            e.returnValue = t( 'about.rebuildLeaveWarning' );
        };
        window.addEventListener( 'beforeunload', handler );
        return () => window.removeEventListener( 'beforeunload', handler );
    }, [ phase, t ] );

    const handleRebuildIndex = async () => {
        setPhase( 'preparing' );
        setProgress( { current: 0, total: 0, title: '' } );
        setResultMsg( '' );
        setFailCount( 0 );

        const ctrl    = new AbortController();
        abortRef.current = ctrl;

        const apiBase = ( window as any ).jetreaderSettings?.apiUrl ?? '/wp-json/jetreader/v1/';
        const base    = apiBase.replace( /\/$/, '' );
        const nonce   = ( window as any ).jetreaderSettings?.nonce ?? '';
        const headers = { 'X-WP-Nonce': nonce, 'Content-Type': 'application/json' };

        const post = async ( body: object ) => {
            const res = await fetch( `${ base }/rebuild-index`, {
                method: 'POST',
                headers,
                body:   JSON.stringify( body ),
                signal: AbortSignal.timeout( 300_000 ), // 5 min per request
            } );
            if ( !res.ok ) {
                const err = await res.json().catch( () => ( {} ) );
                throw new Error( err.message ?? `HTTP ${ res.status }` );
            }
            return res.json();
        };

        try {
            // --- Step 1: get item list ---
            const prep = await post( { phase: 'prepare' } );
            const items: { id: number; title: string }[] = prep.items ?? [];
            const total = items.length;

            if ( total === 0 ) {
                setPhase( 'done' );
                setResultMsg( t( 'about.rebuildDoneEmpty' ) );
                return;
            }

            setPhase( 'indexing' );
            setProgress( { current: 0, total, title: '' } );

            // --- Step 2: process in batches ---
            let indexed  = 0;
            let failures = 0;
            const startMs = Date.now();

            for ( let i = 0; i < items.length; i += REBUILD_BATCH_SIZE ) {
                if ( ctrl.signal.aborted ) break;

                const batch     = items.slice( i, i + REBUILD_BATCH_SIZE );
                const batchIds  = batch.map( ( it ) => it.id );
                const batchTitle = batch[ 0 ]?.title ?? '';

                setProgress( { current: Math.min( i + REBUILD_BATCH_SIZE, total ), total, title: batchTitle } );

                try {
                    const batchRes = await post( { phase: 'batch', item_ids: batchIds } );
                    indexed  += batchRes.indexed ?? 0;
                    failures += ( batchRes.failed ?? [] ).length;
                } catch ( batchErr ) {
                    failures += batch.length;
                }
            }

            // --- Step 3: clean up orphaned rows ---
            setPhase( 'cleanup' );
            try {
                await post( { phase: 'cleanup' } );
            } catch { /* non-fatal */ }

            const elapsedS = ( ( Date.now() - startMs ) / 1000 ).toFixed( 1 );
            setPhase( 'done' );
            setFailCount( failures );

            if ( failures === 0 ) {
                setResultMsg(
                    t( 'about.rebuildDoneItems' )
                        .replace( '{N}', String( indexed ) )
                        .replace( '{S}', elapsedS )
                );
            } else {
                setResultMsg(
                    t( 'about.rebuildPartialError' )
                        .replace( '{N}', String( indexed ) )
                        .replace( '{F}', String( failures ) )
                );
            }

        } catch ( e: any ) {
            setPhase( 'error' );
            setResultMsg( e?.message ? `${ t( 'about.rebuildError' ) }: ${ e.message }` : t( 'about.rebuildError' ) );
        }
    };

    const isRunning = phase === 'preparing' || phase === 'indexing' || phase === 'cleanup';
    const pct = progress.total > 0 ? Math.round( ( progress.current / progress.total ) * 100 ) : 0;

    const links = [
        {
            icon: '📚',
            label: t( 'about.docs' ),
            href: 'https://wplector.com',
        },
        {
            icon: '🐛',
            label: t( 'about.reportBug' ),
            href: 'https://wplector.com',
        },
        {
            icon: '✉️',
            label: t( 'about.support' ),
            href: 'https://wplector.com',
        },
        {
            icon: '⭐',
            label: t( 'about.rate' ),
            href: 'https://wordpress.org/plugins/jetreader/',
        },
    ];

    return (
        <div className="p-6 max-w-2xl mx-auto">
            { !isPro && <ProUpgradeBanner /> }
            { /* Header card */ }
            <div className="rounded-2xl bg-white dark:bg-gray-800 shadow-sm border border-gray-200 dark:border-gray-700 overflow-hidden mb-6">
                <div className="bg-gradient-to-r from-primary-600 to-primary-500 px-6 py-8 text-white">
                    <div className="flex items-center gap-4">
                        <span className="text-5xl">📖</span>
                        <div>
                            <h1 className="text-2xl font-bold">JetReader</h1>
                            <p className="text-primary-100 text-sm mt-1">{ t( 'about.tagline' ) }</p>
                        </div>
                        <span className="ml-auto bg-white/20 rounded-full px-3 py-1 text-sm font-mono">
                            v{ info?.pluginVersion ?? '—' }
                        </span>
                    </div>
                </div>

                { /* Links */ }
                <div className="divide-y divide-gray-100 dark:divide-gray-700">
                    { links.map( ( link ) => (
                        <a
                            key={ link.href }
                            href={ link.href }
                            target="_blank"
                            rel="noopener noreferrer"
                            className="flex items-center gap-3 px-6 py-4 hover:bg-gray-50 dark:hover:bg-gray-750 transition-colors"
                        >
                            <span className="text-xl w-7 text-center">{ link.icon }</span>
                            <span className="text-gray-800 dark:text-gray-200 font-medium">{ link.label }</span>
                            <span className="ml-auto text-gray-400 text-sm">↗</span>
                        </a>
                    ) ) }
                </div>
            </div>

            { /* Tools card */ }
            <div className="rounded-2xl bg-white dark:bg-gray-800 shadow-sm border border-gray-200 dark:border-gray-700 p-6 mb-6">
                <h2 className="text-sm font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wider mb-4">
                    { t( 'about.tools' ) }
                </h2>
                <div className="space-y-3">
                    <div className="flex items-start justify-between gap-4">
                        <div className="flex-1 min-w-0">
                            <p className="text-sm font-medium text-gray-800 dark:text-gray-200">
                                { t( 'about.rebuildIndex' ) }
                            </p>
                            <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
                                { t( 'about.rebuildIndexDesc' ) }
                            </p>

                            { /* Progress area */ }
                            { isRunning && (
                                <div className="mt-3 space-y-1.5">
                                    { /* Warning: keep page open */ }
                                    <p className="text-xs font-medium text-amber-700 dark:text-amber-400 bg-amber-50 dark:bg-amber-900/30 px-3 py-2 rounded-lg">
                                        ⚠️ { t( 'about.rebuildKeepOpen' ) }
                                    </p>

                                    { /* Status label */ }
                                    <p className="text-xs text-gray-500 dark:text-gray-400">
                                        { phase === 'preparing' && t( 'about.rebuildPreparing' ) }
                                        { phase === 'cleanup'   && t( 'about.rebuildCleanup' ) }
                                        { phase === 'indexing'  && progress.total > 0 && (
                                            t( 'about.rebuildIndexing' )
                                                .replace( '{current}', String( progress.current ) )
                                                .replace( '{total}',   String( progress.total   ) )
                                        ) }
                                        { phase === 'indexing' && progress.title && (
                                            <span className="block truncate text-gray-400 dark:text-gray-500 italic mt-0.5">
                                                { progress.title }
                                            </span>
                                        ) }
                                    </p>

                                    { /* Progress bar */ }
                                    { phase === 'indexing' && progress.total > 0 && (
                                        <div className="w-full bg-gray-200 dark:bg-gray-700 rounded-full h-1.5">
                                            <div
                                                className="bg-primary-500 h-1.5 rounded-full transition-all duration-300"
                                                style={ { width: `${ pct }%` } }
                                            />
                                        </div>
                                    ) }
                                </div>
                            ) }
                        </div>

                        <button
                            onClick={ handleRebuildIndex }
                            disabled={ isRunning }
                            className="shrink-0 px-4 py-2 text-sm font-medium rounded-lg border transition-colors disabled:opacity-50
                                bg-primary-600 border-primary-600 text-white hover:bg-primary-700 disabled:cursor-not-allowed"
                        >
                            { isRunning ? t( 'about.rebuildRunning' ) : t( 'about.rebuildIndexBtn' ) }
                        </button>
                    </div>

                    { /* Result message (done / error) */ }
                    { resultMsg && !isRunning && (
                        <p className={ `text-xs px-3 py-2 rounded-lg ${ phase === 'done' && failCount === 0
                            ? 'bg-green-50 text-green-700 dark:bg-green-900/30 dark:text-green-400'
                            : 'bg-red-50 text-red-700 dark:bg-red-900/30 dark:text-red-400' }` }>
                            { resultMsg }
                        </p>
                    ) }
                </div>
            </div>

            { /* System info card */ }
            <div className="rounded-2xl bg-white dark:bg-gray-800 shadow-sm border border-gray-200 dark:border-gray-700 p-6">
                <h2 className="text-sm font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wider mb-4">
                    { t( 'about.systemInfo' ) }
                </h2>
                <dl className="space-y-3">
                    { [
                        { label: 'JetReader', value: info?.pluginVersion ?? '—' },
                        { label: 'WordPress', value: info?.wpVersion ?? '—' },
                        { label: 'PHP', value: info?.phpVersion ?? '—' },
                        {
                            label: 'Elementor',
                            value: info?.elementor
                                ? `${ t( 'about.active' ) } (${ info.elementor })`
                                : t( 'about.inactive' ),
                        },
                    ].map( ( row ) => (
                        <div key={ row.label } className="flex justify-between items-center">
                            <dt className="text-sm text-gray-600 dark:text-gray-400">{ row.label }</dt>
                            <dd className="text-sm font-mono text-gray-900 dark:text-gray-100 bg-gray-100 dark:bg-gray-700 px-2 py-0.5 rounded">
                                { row.value }
                            </dd>
                        </div>
                    ) ) }
                </dl>
            </div>
        </div>
    );
};

/* ------------------------------------------------------------------ */

const DisplaysPage: React.FC = () => null;
const ImportExportPage: React.FC = () => null;

const App: React.FC = () => {
    // Initialise from the URL so direct links and page refreshes work.
    const [ currentPage, setCurrentPage ] = React.useState( () =>
        new URLSearchParams( window.location.search ).get( 'page' ) || 'jetreader'
    );

    // A ref lets navigateTo read the latest page without being recreated on
    // every render — keeps the document click listener stable.
    const currentPageRef = React.useRef( currentPage );
    React.useEffect( () => { currentPageRef.current = currentPage; }, [ currentPage ] );

    const navigateTo = React.useCallback( ( page: string ) => {
        if ( page === currentPageRef.current ) return;
        const url = new URL( window.location.href );
        url.searchParams.set( 'page', page );
        window.history.pushState( { jrPage: page }, '', url.toString() );
        setCurrentPage( page );
        updateWpMenuActive( page );
        window.scrollTo( 0, 0 );
    }, [] ); // stable — never recreated

    React.useEffect( () => {
        // Handle browser back / forward buttons.
        const onPopState = () => {
            const p = new URLSearchParams( window.location.search ).get( 'page' ) || 'jetreader';
            setCurrentPage( p );
            updateWpMenuActive( p );
        };

        // Intercept clicks on WP admin sidebar links that point to our pages.
        // This prevents full page reloads when the user clicks the left menu.
        const onMenuClick = ( e: MouseEvent ) => {
            const link = ( e.target as Element ).closest( 'a' ) as HTMLAnchorElement | null;
            if ( ! link ) return;
            const href = link.getAttribute( 'href' ) || '';
            if ( ! href.includes( 'page=jetreader' ) ) return;
            const match = href.match( /[?&]page=(jetreader[^&]*)/ );
            if ( ! match ) return;
            e.preventDefault();
            navigateTo( match[ 1 ] );
        };

        window.addEventListener( 'popstate', onPopState );
        document.addEventListener( 'click', onMenuClick );

        return () => {
            window.removeEventListener( 'popstate', onPopState );
            document.removeEventListener( 'click', onMenuClick );
        };
    }, [ navigateTo ] );

    const renderPage = () => {
        const isLite = true;
        const isPro  = ( window as any ).jetreaderSettings?.isPro ?? false;
        const locale = ( window as any ).jetreaderSettings?.locale || 'en';
        const txt = ( en: string, tr: string ) => locale === 'tr' ? tr : en;

        switch ( currentPage ) {
            case 'jetreader':            return <LectorDashboard />;
            case 'jetreader-items':      return <ItemsPage />;
            case 'jetreader-constants':
            case 'jetreader-categories': return <ConstantsPage />;
            case 'jetreader-settings':   return <SettingsPage />;
            case 'jetreader-displays':
                // Lite: feature doesn't exist in this build — send back to dashboard.
                if ( isLite ) { return <LectorDashboard />; }
                return isPro ? (
                    <DisplaysPage />
                ) : (
                    <ProFeatureOverlay
                        featureName={ txt( 'Visual Displays Builder', 'Görsel Görünüm Oluşturucu' ) }
                        desc={ txt(
                            'Build custom grid and slider layouts based on categories or authors. Configure columns, navigation, colors, and other advanced display settings.',
                            'Kategorilere veya yazarlara göre özel ızgara ve slayt düzenleri oluşturun. Sütunları, navigasyonu, renkleri ve diğer gelişmiş görünüm ayarlarını yapılandırın.'
                        ) }
                    />
                );
            case 'jetreader-about':      return <AboutPage />;
            case 'jetreader-import':
                // Lite: feature doesn't exist in this build — send back to dashboard.
                if ( isLite ) { return <LectorDashboard />; }
                return isPro ? (
                    <ImportExportPage />
                ) : (
                    <ProFeatureOverlay
                        featureName={ txt( 'Library Import & Export', 'Kütüphane İçe/Dışa Aktarma' ) }
                        desc={ txt(
                            'Bulk import library items (books, magazines, articles, Q&As) from JSON, CSV, or XLSX files, or export your library database.',
                            'Kitap, dergi, makale ve soru-cevap ögelerini JSON, CSV veya XLSX dosyalarından toplu olarak içe aktarın ya da kütüphanenizi dışa aktarın.'
                        ) }
                    />
                );
            default:                      return <LectorDashboard />;
        }
    };

    return (
        <NavigationContext.Provider value={ { currentPage, navigateTo } }>
            <QueryClientProvider client={ queryClient }>
                <I18nProvider>
                    <div className="jetreader-admin min-h-screen bg-gray-50 dark:bg-gray-900 text-gray-900 dark:text-white">
                        { renderPage() }
                    </div>
                </I18nProvider>
            </QueryClientProvider>
        </NavigationContext.Provider>
    );
};

export default App;
