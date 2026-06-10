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
    page_count?: number;
    encoding?: string;
}

interface ImportError {
    row: number;
    title: string;
    message: string;
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
    page_count?: number;
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

// Helper: format size
const formatBytes = ( bytes: number ) => {
    if ( bytes === 0 ) return '0 Bytes';
    const k = 1024;
    const sizes = [ 'Bytes', 'KB', 'MB', 'GB' ];
    const i = Math.floor( Math.log( bytes ) / Math.log( k ) );
    return parseFloat( ( bytes / Math.pow( k, i ) ).toFixed( 2 ) ) + ' ' + sizes[ i ];
};

// Helper: format date
const formatDate = ( timestamp: number ) => {
    return new Date( timestamp * 1000 ).toLocaleString();
};

interface JetReaderFileSelectorModalProps {
    isOpen: boolean;
    onClose: () => void;
    onSelect: ( url: string ) => void;
    imageOnly?: boolean;
    title: string;
}

const JetReaderFileSelectorModal: React.FC<JetReaderFileSelectorModalProps> = ( {
    isOpen,
    onClose,
    onSelect,
    imageOnly = false,
    title,
} ) => {
    const { t } = useTranslation();
    const queryClient = useQueryClient();
    const apiBase = ( window as any ).jetreaderSettings?.apiUrl?.replace( /\/$/, '' ) ?? '/wp-json/jetreader/v1';
    const nonce = ( window as any ).jetreaderSettings?.nonce ?? '';
    const authHeader = React.useMemo( () => ( { 'X-WP-Nonce': nonce } ), [ nonce ] );

    const [ searchTerm, setSearchTerm ] = useState( '' );
    const [ activeTab, setActiveTab ] = useState<'pdf' | 'epub' | 'docx' | 'txt' | 'images'>(
        imageOnly ? 'images' : 'pdf'
    );
    const [ uploading, setUploading ] = useState( false );
    const [ uploadProgress, setUploadProgress ] = useState( 0 );
    const [ uploadError, setUploadError ] = useState( '' );
    const [ isDragging, setIsDragging ] = useState( false );
    const dragCounterRef = React.useRef( 0 );

    const { data: files = [], isLoading } = useQuery<any[]>({
        queryKey: [ 'files' ],
        queryFn: async () => {
            const res = await fetch( `${ apiBase }/files`, { headers: authHeader } );
            const json = await res.json();
            return Array.isArray( json ) ? json : [];
        },
        enabled: isOpen,
    });

    if ( ! isOpen ) return null;

    const filteredFiles = files.filter( ( f: any ) => {
        if ( searchTerm.trim() && ! f.name.toLowerCase().includes( searchTerm.toLowerCase() ) ) {
            return false;
        }

        const ext = f.extension;
        const isImage = [ 'png', 'jpg', 'jpeg', 'webp', 'gif', 'svg' ].includes( ext );
        
        if ( activeTab === 'images' && ! isImage ) return false;
        if ( activeTab !== 'images' && ext !== activeTab ) return false;

        return true;
    } );

    const getTabCount = ( tab: string ) => {
        return files.filter( ( f: any ) => {
            const ext = f.extension;
            const isImage = [ 'png', 'jpg', 'jpeg', 'webp', 'gif', 'svg' ].includes( ext );
            if ( tab === 'images' ) return isImage;
            return ext === tab;
        } ).length;
    };

    const handleUpload = async ( file: File ) => {
        setUploadError( '' );
        setUploading( true );
        setUploadProgress( 10 );

        const formData = new FormData();
        formData.append( 'file', file );

        try {
            const xhr = new XMLHttpRequest();
            xhr.open( 'POST', `${ apiBase }/upload` );
            xhr.setRequestHeader( 'X-WP-Nonce', nonce );

            xhr.upload.onprogress = ( event ) => {
                if ( event.lengthComputable ) {
                    const pct = Math.round( ( event.loaded / event.total ) * 90 ) + 10;
                    setUploadProgress( pct );
                }
            };

            xhr.onload = () => {
                if ( xhr.status === 200 ) {
                    try {
                        const res = JSON.parse( xhr.responseText );
                        if ( res.file_url ) {
                            queryClient.invalidateQueries( { queryKey: [ 'files' ] } );
                            onSelect( res.file_url );
                        } else {
                            setUploadError( 'Upload response missing file URL.' );
                        }
                    } catch {
                        setUploadError( 'Failed to parse upload response.' );
                    }
                } else {
                    try {
                        const err = JSON.parse( xhr.responseText );
                        setUploadError( err.message || 'Upload failed.' );
                    } catch {
                        setUploadError( 'Upload failed.' );
                    }
                }
                setUploading( false );
            };

            xhr.onerror = () => {
                setUploadError( 'Network error.' );
                setUploading( false );
            };

            xhr.send( formData );
        } catch ( e ) {
            setUploadError( 'Upload error.' );
            setUploading( false );
        }
    };

    const onDragOver = ( e: React.DragEvent ) => {
        e.preventDefault();
        e.stopPropagation();
    };

    const onDragEnter = ( e: React.DragEvent ) => {
        e.preventDefault();
        e.stopPropagation();
        dragCounterRef.current++;
        if ( dragCounterRef.current === 1 ) {
            setIsDragging( true );
        }
    };

    const onDragLeave = ( e: React.DragEvent ) => {
        e.preventDefault();
        e.stopPropagation();
        dragCounterRef.current--;
        if ( dragCounterRef.current === 0 ) {
            setIsDragging( false );
        }
    };

    const onDrop = ( e: React.DragEvent ) => {
        e.preventDefault();
        e.stopPropagation();
        setIsDragging( false);
        dragCounterRef.current = 0;
        if ( e.dataTransfer.files && e.dataTransfer.files.length > 0 ) {
            handleUpload( e.dataTransfer.files[0] );
        }
    };

    const triggerWpMedia = () => {
        onClose();
        openWpMedia( title, imageOnly, onSelect );
    };

    return (
        <AnimatePresence>
            <motion.div
                initial={ { opacity: 0 } }
                animate={ { opacity: 1 } }
                exit={ { opacity: 0 } }
                className="fixed inset-0 bg-black/60 backdrop-blur-sm z-[60] flex items-center justify-center p-4"
                onClick={ onClose }
            >
                <motion.div
                    initial={ { scale: 0.95, opacity: 0 } }
                    animate={ { scale: 1, opacity: 1 } }
                    exit={ { scale: 0.95, opacity: 0 } }
                    className="bg-white dark:bg-gray-800 rounded-2xl shadow-2xl max-w-2xl w-full relative flex flex-col max-h-[85vh] overflow-hidden border border-gray-255 dark:border-gray-700"
                    onClick={ ( e ) => e.stopPropagation() }
                >
                    {/* Header */}
                    <div className="flex items-center justify-between p-5 border-b border-gray-150 dark:border-gray-700 bg-gray-50/50 dark:bg-gray-800">
                        <h3 className="font-bold text-gray-900 dark:text-white flex items-center gap-2">
                            📂 { title }
                        </h3>
                        <button onClick={ onClose } className="p-2 hover:bg-gray-100 dark:hover:bg-gray-700 rounded-lg transition-colors text-gray-500 dark:text-gray-400" type="button">
                            ✕
                        </button>
                    </div>

                    {/* Content */}
                    <div className="p-5 flex-1 overflow-y-auto space-y-4">
                        
                        {/* WP Media & Upload Area */}
                        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                            {/* WP Media Button */}
                            <button
                                type="button"
                                onClick={ triggerWpMedia }
                                className="flex flex-col items-center justify-center gap-2 p-5 rounded-xl border border-gray-300 dark:border-gray-700 bg-gray-50 dark:bg-gray-750/30 hover:bg-gray-100 dark:hover:bg-gray-750 hover:border-blue-400 dark:hover:border-blue-500 transition-all group cursor-pointer text-center"
                            >
                                <span className="text-2xl group-hover:scale-110 transition-transform" role="img" aria-label="world">🌐</span>
                                <div className="text-sm font-semibold text-gray-700 dark:text-gray-200">
                                    { t( 'files.wpMediaLibrary' ) }
                                </div>
                                <div className="text-xs text-gray-400 dark:text-gray-500">
                                    { t( 'files.selectStandardLibrary' ) }
                                </div>
                            </button>

                            {/* Upload area */}
                            <div
                                onDragOver={ onDragOver }
                                onDragEnter={ onDragEnter }
                                onDragLeave={ onDragLeave }
                                onDrop={ onDrop }
                                onClick={ () => {
                                    const inputId = imageOnly ? 'modal-upload-input-img' : 'modal-upload-input-file';
                                    document.getElementById( inputId )?.click();
                                } }
                                className={`border border-dashed rounded-xl p-5 text-center cursor-pointer transition-all flex flex-col items-center justify-center gap-1.5 ${
                                    isDragging
                                        ? 'border-primary-500 bg-primary-50/50 dark:bg-primary-950/20'
                                        : 'border-gray-300 dark:border-gray-700 hover:border-primary-400 bg-white dark:bg-gray-800 hover:bg-gray-50/50 dark:hover:bg-gray-750/30'
                                }`}
                            >
                                <input
                                    type="file"
                                    id={ imageOnly ? 'modal-upload-input-img' : 'modal-upload-input-file' }
                                    accept={ imageOnly ? 'image/*' : '.pdf,.epub,.docx,.txt,.doc' }
                                    onChange={ ( e ) => { if ( e.target.files?.[0] ) handleUpload( e.target.files[0] ); } }
                                    className="hidden"
                                />
                                <span className="text-2xl animate-pulse" role="img" aria-label="upload">📥</span>
                                <div className="text-sm font-semibold text-gray-700 dark:text-gray-255">
                                    { t( 'files.uploadAndSelect' ) }
                                </div>
                                <div className="text-xs text-gray-400 dark:text-gray-500">
                                    { imageOnly ? 'PNG, JPG, WEBP, GIF, SVG' : 'PDF, EPUB, TXT, DOCX' }
                                </div>
                            </div>
                        </div>

                        { uploadProgress > 0 && (
                            <div className="space-y-1 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 p-3 rounded-xl shadow-sm">
                                <div className="flex justify-between text-xs text-gray-700 dark:text-gray-300 font-semibold">
                                    <span>{ uploading ? t( 'files.uploading' ) : t( 'files.processing' ) }</span>
                                    <span>{ uploadProgress }%</span>
                                </div>
                                <div className="w-full bg-gray-100 dark:bg-gray-700 rounded-full h-1.5 overflow-hidden">
                                    <div className="bg-primary-500 h-1.5 rounded-full transition-all duration-300" style={ { width: `${ uploadProgress }%` } } />
                                </div>
                            </div>
                        ) }

                        { uploadError && (
                            <div className="text-xs text-red-655 dark:text-red-400 bg-red-50 dark:bg-red-950/20 border border-red-200/40 p-2.5 rounded-lg">
                                ❌ { uploadError }
                            </div>
                        ) }

                        {/* Search & Tabs */}
                        <div className="space-y-3 pt-2">
                            <div className="text-xs font-bold text-gray-400 dark:text-gray-500 uppercase tracking-wider">
                                { t( 'files.selectExistingJetReader' ) }
                            </div>

                            <div className="flex flex-col sm:flex-row gap-3">
                                <input
                                    type="text"
                                    placeholder={ t( 'files.searchPlaceholder' ) }
                                    value={ searchTerm }
                                    onChange={ e => setSearchTerm( e.target.value ) }
                                    className="text-sm border border-gray-300 dark:border-gray-600 rounded-lg px-3 py-2 bg-white dark:bg-gray-750 text-gray-900 dark:text-gray-100 placeholder-gray-450 dark:placeholder-gray-500 flex-1 focus:ring-2 focus:ring-primary-500/20 focus:outline-none"
                                />
                            </div>

                            {/* Tabs (only show tabs if NOT imageOnly) */}
                            { ! imageOnly && (
                                <div className="flex border-b border-gray-250 dark:border-gray-700 overflow-x-auto gap-2 text-xs">
                                    {( [ 'pdf', 'epub', 'docx', 'txt', 'images' ] as const ).map( tab => {
                                        const isActive = activeTab === tab;
                                        const count = getTabCount( tab );
                                        return (
                                            <button
                                                key={ tab }
                                                type="button"
                                                onClick={ () => setActiveTab( tab ) }
                                                className={ `py-2 px-3 font-medium border-b-2 transition-all whitespace-nowrap flex items-center gap-1.5 ${
                                                    isActive
                                                        ? 'border-primary-600 text-primary-650 dark:text-primary-400'
                                                        : 'border-transparent text-gray-550 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200'
                                                }` }
                                            >
                                                <span>
                                                    { tab === 'pdf' && 'PDF' }
                                                    { tab === 'epub' && 'EPUB' }
                                                    { tab === 'docx' && 'DOCX' }
                                                    { tab === 'txt' && 'TXT' }
                                                    { tab === 'images' && t( 'files.tabImages' ) }
                                                </span>
                                                <span className="text-[10px] px-1.5 py-0.2 bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-400 rounded-full">
                                                    { count }
                                                </span>
                                            </button>
                                        );
                                    } ) }
                                </div>
                            ) }
                        </div>

                        {/* Files list */}
                        { isLoading ? (
                            <div className="flex items-center justify-center py-10">
                                <div className="animate-spin rounded-full h-6 w-6 border-b-2 border-primary-500" />
                            </div>
                        ) : filteredFiles.length === 0 ? (
                            <div className="text-center py-10 text-gray-450 dark:text-gray-500 text-xs">
                                📁 { t( 'files.noFilesFound' ) }
                            </div>
                        ) : (
                            <div className="max-h-[30vh] overflow-y-auto border border-gray-200 dark:border-gray-700 rounded-xl divide-y divide-gray-150 dark:divide-gray-700 bg-gray-50/20">
                                { filteredFiles.map( ( file: any ) => (
                                    <div
                                        key={ file.name }
                                        onClick={ () => onSelect( file.url ) }
                                        className="p-3 flex items-center justify-between hover:bg-primary-50/30 dark:hover:bg-primary-950/10 cursor-pointer transition-colors group"
                                    >
                                        <div className="flex items-center gap-2 min-w-0 flex-1">
                                            { file.extension === 'png' || file.extension === 'jpg' || file.extension === 'jpeg' || file.extension === 'webp' || file.extension === 'gif' || file.extension === 'svg' ? (
                                                <img src={ file.url } alt="" className="w-8 h-8 rounded border border-gray-250 dark:border-gray-700 object-cover bg-white" />
                                            ) : (
                                                <span className="text-xl shrink-0">
                                                    { file.extension === 'pdf' && '📕' }
                                                    { file.extension === 'epub' && '📘' }
                                                    { file.extension === 'docx' && '📄' }
                                                    { file.extension === 'txt' && '📝' }
                                                </span>
                                            )}
                                            <div className="min-w-0 flex-1">
                                                <div className="font-mono text-xs truncate text-gray-900 dark:text-white group-hover:text-primary-650 dark:group-hover:text-primary-400 font-semibold" title={ file.name }>
                                                    { file.name }
                                                </div>
                                                <div className="text-[10px] text-gray-455 dark:text-gray-500 flex items-center gap-1.5 mt-0.5">
                                                    <span>{ formatBytes( file.size ) }</span>
                                                    <span>•</span>
                                                    <span>{ formatDate( file.modified ) }</span>
                                                </div>
                                            </div>
                                        </div>
                                        <button
                                            type="button"
                                            className="px-2.5 py-1 text-[11px] font-bold bg-white dark:bg-gray-750 hover:bg-primary-600 hover:text-white dark:hover:bg-primary-500 border border-gray-200 dark:border-gray-650 rounded-lg shadow-sm transition-all text-gray-700 dark:text-gray-300"
                                        >
                                            { t( 'files.choose' ) }
                                        </button>
                                    </div>
                                ) ) }
                            </div>
                        ) }
                    </div>
                </motion.div>
            </motion.div>
        </AnimatePresence>
    );
};

const WpMediaButton: React.FC<{
    onSelect: ( url: string ) => void;
    imageOnly?: boolean;
    title: string;
    disabled?: boolean;
}> = ( { onSelect, imageOnly = false, title, disabled } ) => {
    const [ isModalOpen, setIsModalOpen ] = useState( false );

    return (
        <>
            <button
                type="button"
                disabled={ disabled }
                title={ title }
                onClick={ () => ! disabled && setIsModalOpen( true ) }
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
            <JetReaderFileSelectorModal
                isOpen={ isModalOpen }
                onClose={ () => setIsModalOpen( false ) }
                onSelect={ ( url ) => { onSelect( url ); setIsModalOpen( false ); } }
                imageOnly={ imageOnly }
                title={ title }
            />
        </>
    );
};

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
    const [ statsLoading, setStatsLoading ] = React.useState( false );

    const fetchStats = React.useCallback( ( force = false ) => {
        setStatsLoading( true );
        fetch( `${API_BASE}/dashboard${force ? '?force=1' : ''}`, {
            headers: { 'X-WP-Nonce': getNonce() },
        } )
            .then( ( res ) => res.json() )
            .then( ( data ) => {
                if ( data && ! data.code ) setStats( data );
                else dbg( 'dashboard stats error:', data );
            } )
            .catch( ( err ) => dbg( 'dashboard fetch error:', err ) )
            .finally( () => setStatsLoading( false ) );
    }, [] );

    React.useEffect( () => { fetchStats(); }, [] );

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
            <div className="mb-6 flex items-start justify-between gap-4">
                <div>
                    <h1 className="text-2xl font-bold text-gray-900 dark:text-white">
                        {t('dashboard.title')}
                    </h1>
                    <p className="mt-1 text-gray-500 dark:text-gray-400 text-sm">
                        {t('dashboard.welcome')}
                    </p>
                </div>
                <button
                    onClick={ () => fetchStats( true ) }
                    disabled={ statsLoading }
                    className="shrink-0 flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-gray-600 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-750 disabled:opacity-50 transition-colors"
                    title="Refresh statistics"
                >
                    <span className={ statsLoading ? 'animate-spin' : '' }>↻</span>
                    { statsLoading ? 'Loading…' : 'Refresh Stats' }
                </button>
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
    category_names: string;
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
    title: '', category_names: '', author: '', translator: '', publisher: '',
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
    const [ isDraggingModal, setIsDraggingModal ] = useState( false );
    const [ activeDragRowIndex, setActiveDragRowIndex ] = useState<number | null>( null );
    const dragCounter = React.useRef( 0 );

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
        row.category_names.trim() !== '' ||
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

    const handleModalDragEnter = ( e: React.DragEvent ) => {
        e.preventDefault();
        e.stopPropagation();
        dragCounter.current++;
        if ( dragCounter.current === 1 ) {
            setIsDraggingModal( true );
        }
    };

    const handleModalDragLeave = ( e: React.DragEvent ) => {
        e.preventDefault();
        e.stopPropagation();
        dragCounter.current--;
        if ( dragCounter.current === 0 ) {
            setIsDraggingModal( false );
        }
    };

    const handleModalDragOver = ( e: React.DragEvent ) => {
        e.preventDefault();
        e.stopPropagation();
    };

    const uploadAndParseFile = async ( file: File ) => {
        const formData = new FormData();
        formData.append( 'file', file );

        const res = await fetch( `${ API_BASE }/upload`, {
            method: 'POST',
            headers: { 'X-WP-Nonce': getNonce() },
            body: formData,
        } );
        const json = await res.json();
        if ( json.code ) throw new Error( json.message );
        return json;
    };

    const handleModalDrop = async ( e: React.DragEvent ) => {
        e.preventDefault();
        e.stopPropagation();
        dragCounter.current = 0;
        setIsDraggingModal( false );

        const files = Array.from( e.dataTransfer.files || [] );
        if ( files.length === 0 ) return;

        setSaving( true );
        flashMessage( `⚡ Uploading and parsing ${ files.length } files...` );

        let updatedRows = [ ...rows ];
        let successCount = 0;

        for ( const file of files ) {
            const ext = file.name.split( '.' ).pop()?.toLowerCase();
            const supported = [ 'epub', 'pdf', 'txt', 'docx', 'doc' ];
            if ( ! ext || ! supported.includes( ext ) ) {
                flashMessage( `❌ Unsupported file type: .${ ext }` );
                continue;
            }

            try {
                const json = await uploadAndParseFile( file );
                const meta = json.metadata || {};

                const itemData: BulkAddItem = {
                    title: meta.title || file.name.replace( /\.[^/.]+$/, "" ),
                    category_names: meta.category || '',
                    author: meta.author || '',
                    translator: meta.translator || '',
                    publisher: meta.publisher || '',
                    publication_year: meta.publication_year ? String( meta.publication_year ) : '',
                    description: meta.description || '',
                    visibility: 'publish',
                    featured: false,
                    cover_image: meta.cover_image || '',
                    file_path: json.file_url || '',
                    file_type: json.file_type || ext,
                };

                if ( successCount === 0 && updatedRows.length === 1 && updatedRows[0].title.trim() === '' && updatedRows[0].file_path.trim() === '' ) {
                    updatedRows[0] = itemData;
                } else {
                    updatedRows.push( itemData );
                }
                successCount++;
            } catch ( err ) {
                flashMessage( `❌ Upload failed for "${ file.name }": ${ err instanceof Error ? err.message : 'Unknown error' }` );
            }
        }

        setRows( updatedRows );
        setSaving( false );
        if ( successCount > 0 ) {
            flashMessage( `✅ ${ successCount } files uploaded and parsed!` );
        }
    };

    const handleSave = async () => {
        const validRows = rows.filter( ( r ) => r.title.trim() );
        if ( validRows.length === 0 ) {
            flashMessage( t( 'items.addItemError' ) );
            return;
        }
        setSaving( true );
        const payloadItems = validRows.map( ( row ) => {
            const payload: Record<string, unknown> = {
                type:           activeType,
                title:          row.title.trim(),
                visibility:     row.visibility || 'publish',
                featured:       row.featured,
                category_names: row.category_names,
                description:    row.description,
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
            return payload;
        } );

        let ok = 0, fail = 0;
        try {
            const res = await fetch( `${API_BASE}/items/bulk-create`, {
                method:  'POST',
                headers: { 'Content-Type': 'application/json', 'X-WP-Nonce': getNonce() },
                body:    JSON.stringify( { items: payloadItems } ),
            } );
            const json = await res.json();
            ok = json.success ?? 0;
            fail = json.failed ?? 0;
        } catch {
            fail = payloadItems.length;
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
                    className={ `bg-white dark:bg-gray-800 rounded-2xl shadow-2xl w-full max-w-5xl mb-6 border transition-all duration-300 overflow-hidden relative ${
                        isDraggingModal
                            ? 'border-blue-500 ring-2 ring-blue-500/20 shadow-[0_0_20px_rgba(59,130,246,0.15)] bg-blue-50/5 dark:bg-blue-900/5'
                            : 'border-gray-100 dark:border-gray-700/60'
                    }` }
                    onClick={ ( e ) => e.stopPropagation() }
                    onDragEnter={ handleModalDragEnter }
                    onDragOver={ handleModalDragOver }
                    onDragLeave={ handleModalDragLeave }
                    onDrop={ handleModalDrop }
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
                        {/* Drag & Drop Hint Banner */}
                        <div className="bg-blue-50 dark:bg-blue-950/20 border border-blue-100 dark:border-blue-900/40 rounded-xl p-3 text-xs text-blue-700 dark:text-blue-300 flex items-start gap-2.5 shadow-sm">
                            <span className="text-base shrink-0">💡</span>
                            <div>
                                <p className="font-semibold">{ t( 'items.bulkDragDropHintTitle' ) }</p>
                                <p className="mt-0.5 opacity-90">{ t( 'items.bulkDragDropHintDesc' ) }</p>
                            </div>
                        </div>

                        { rows.map( ( row, idx ) => (
                            <div
                                key={ idx }
                                onDragEnter={ ( e ) => {
                                    e.preventDefault();
                                    e.stopPropagation();
                                    setActiveDragRowIndex( idx );
                                } }
                                onDragOver={ ( e ) => {
                                    e.preventDefault();
                                    e.stopPropagation();
                                } }
                                onDragLeave={ ( e ) => {
                                    e.preventDefault();
                                    e.stopPropagation();
                                    setActiveDragRowIndex( null );
                                } }
                                onDrop={ async ( e ) => {
                                    e.preventDefault();
                                    e.stopPropagation();
                                    setActiveDragRowIndex( null );

                                    const file = e.dataTransfer.files?.[0];
                                    if ( ! file ) return;

                                    const ext = file.name.split( '.' ).pop()?.toLowerCase();
                                    const supported = [ 'epub', 'pdf', 'txt', 'docx', 'doc' ];
                                    if ( ! ext || ! supported.includes( ext ) ) {
                                        flashMessage( `❌ Unsupported file type: .${ ext }` );
                                        return;
                                    }

                                    setSaving( true );
                                    flashMessage( `⚡ Uploading and parsing "${ file.name }" for row #${ idx + 1 }...` );
                                    try {
                                        const json = await uploadAndParseFile( file );
                                        const meta = json.metadata || {};

                                        setRows( ( prev ) => prev.map( ( r, i ) => i === idx ? {
                                            ...r,
                                            title: meta.title || r.title || file.name.replace( /\.[^/.]+$/, "" ),
                                            category_names: meta.category || r.category_names || '',
                                            author: meta.author || r.author || '',
                                            translator: meta.translator || r.translator || '',
                                            publisher: meta.publisher || r.publisher || '',
                                            publication_year: meta.publication_year ? String( meta.publication_year ) : r.publication_year || '',
                                            description: meta.description || r.description || '',
                                            cover_image: meta.cover_image || r.cover_image || '',
                                            file_path: json.file_url || '',
                                            file_type: json.file_type || ext,
                                        } : r ) );

                                        flashMessage( `✅ Row #${ idx + 1 } populated!` );
                                    } catch ( err ) {
                                        flashMessage( `❌ Upload failed for row #${ idx + 1 }: ${ err instanceof Error ? err.message : 'Unknown error' }` );
                                    } finally {
                                        setSaving( false );
                                    }
                                } }
                                className={ `bg-white dark:bg-gray-800 rounded-xl border p-4 space-y-4 shadow-sm hover:border-gray-300 dark:hover:border-gray-650 transition-all duration-200 relative ${
                                    activeDragRowIndex === idx
                                        ? 'border-dashed border-2 border-blue-500 bg-blue-50/20 dark:bg-blue-900/10'
                                        : 'border-gray-200 dark:border-gray-700'
                                }` }
                            >
                                { activeDragRowIndex === idx && (
                                    <div className="absolute inset-0 bg-blue-500/5 backdrop-blur-[1px] rounded-xl flex items-center justify-center pointer-events-none z-10">
                                        <div className="bg-white dark:bg-gray-850 px-3 py-1.5 rounded-lg shadow-md border border-blue-200 dark:border-blue-900/50 flex items-center gap-1.5 text-xs font-semibold text-blue-600 dark:text-blue-400 animate-pulse">
                                            <span>📥</span>
                                            <span>{ t( 'items.dropToFillRow' ) || 'Drop to populate row' }</span>
                                        </div>
                                    </div>
                                ) }

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
                                                <input
                                                    type="text"
                                                    value={ row.category_names }
                                                    onChange={ ( e ) => updateRow( idx, 'category_names', e.target.value ) }
                                                    list="bulk-categories-list"
                                                    className="jr-input text-sm w-full"
                                                    placeholder={ t( 'itemForm.categoryPlaceholder' ) || 'e.g. Felsefe, Mantık' }
                                                />
                                                <CopyToAll idx={ idx } field="category_names" />
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
                                        <div className="flex items-center justify-between border border-gray-250 dark:border-gray-700 bg-gray-50/50 dark:bg-gray-900/10 rounded-xl px-3.5 py-2 hover:border-gray-300 dark:hover:border-gray-655 transition-colors">
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
                                                <input
                                                    type="text"
                                                    value={ row.category_names }
                                                    onChange={ ( e ) => updateRow( idx, 'category_names', e.target.value ) }
                                                    list="bulk-categories-list"
                                                    className="jr-input text-sm w-full"
                                                    placeholder={ t( 'itemForm.categoryPlaceholder' ) || 'e.g. Felsefe, Mantık' }
                                                />
                                                <CopyToAll idx={ idx } field="category_names" />
                                            </div>
                                        </div>

                                        {/* Author */}
                                        <div className="space-y-1">
                                            <label className="block text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide">
                                                { t( 'items.authorLabel' ) }
                                            </label>
                                            <div className="flex items-center gap-1.5">
                                                <input
                                                    type="text"
                                                    value={ row.author }
                                                    onChange={ ( e ) => updateRow( idx, 'author', e.target.value ) }
                                                    list="bulk-authors-list"
                                                    className="jr-input w-full text-sm"
                                                    placeholder={ t( 'itemForm.authorPlaceholder' ) || 'Enter author name' }
                                                />
                                                <CopyToAll idx={ idx } field="author" />
                                            </div>
                                        </div>

                                        {/* Publisher */}
                                        <div className="space-y-1">
                                            <label className="block text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide">
                                                { t( 'itemForm.publisherLabel' ) }
                                            </label>
                                            <div className="flex items-center gap-1.5">
                                                <input
                                                    type="text"
                                                    value={ row.publisher }
                                                    onChange={ ( e ) => updateRow( idx, 'publisher', e.target.value ) }
                                                    list="bulk-publishers-list"
                                                    className="jr-input w-full text-sm"
                                                    placeholder={ t( 'itemForm.publisherPlaceholder' ) || 'Enter publisher name' }
                                                />
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
                                            <label className="flex items-center gap-2.5 text-xs font-semibold text-gray-650 dark:text-gray-455 uppercase tracking-wide cursor-pointer select-none">
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

                    {/* Datalists for autocompletion */}
                    <datalist id="bulk-categories-list">
                        { bulkCategories.map( ( c ) => (
                            <option key={ c.id } value={ c.name } />
                        ) ) }
                    </datalist>
                    <datalist id="bulk-authors-list">
                        { bulkAuthors.map( ( a ) => (
                            <option key={ a.id } value={ a.name } />
                        ) ) }
                    </datalist>
                    <datalist id="bulk-publishers-list">
                        { bulkPublishers.map( ( p ) => (
                            <option key={ p.id } value={ p.name } />
                        ) ) }
                    </datalist>
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
    const [ formCategoriesText, setFormCategoriesText ] = useState( '' );
    const [ isDragging, setIsDragging ] = useState( false );

    const isMultiVolType = ( type: string ) => type === 'book' || type === 'magazine';
    const volLabel = ( type: string ) => type === 'magazine' ? t( 'reader.volLabelMagazine' ) : t( 'reader.volLabelBook' );

    const handleDragEnter = ( e: React.DragEvent ) => {
        e.preventDefault();
        e.stopPropagation();
        setIsDragging( true );
    };

    const handleDragLeave = ( e: React.DragEvent ) => {
        e.preventDefault();
        e.stopPropagation();
        if ( e.currentTarget === e.target ) {
            setIsDragging( false );
        }
    };

    const handleDragOver = ( e: React.DragEvent ) => {
        e.preventDefault();
        e.stopPropagation();
    };

    const handleDrop = async ( e: React.DragEvent ) => {
        e.preventDefault();
        e.stopPropagation();
        setIsDragging( false );

        const file = e.dataTransfer.files?.[0];
        if ( ! file ) return;

        const ext = file.name.split( '.' ).pop()?.toLowerCase();
        const supported = [ 'epub', 'pdf', 'txt', 'docx', 'doc' ];
        if ( ! ext || ! supported.includes( ext ) ) {
            flashMessage( `❌ Unsupported file type: .${ ext }` );
            return;
        }

        setSaving( true );
        flashMessage( `⚡ Uploading and parsing "${ file.name }"...` );
        try {
            const formData = new FormData();
            formData.append( 'file', file );

            const res = await fetch( `${ API_BASE }/upload`, {
                method: 'POST',
                headers: { 'X-WP-Nonce': getNonce() },
                body: formData,
            } );
            const json = await res.json();
            if ( json.code ) throw new Error( json.message );

            const meta = json.metadata || {};
            setForm( ( prev ) => ( {
                ...prev,
                title: meta.title || prev.title || file.name.replace( /\.[^/.]+$/, "" ),
                author: meta.author || prev.author || '',
                language: meta.language || prev.language || 'en',
                file_path: json.file_url || '',
                file_type: json.file_type || ext,
                publisher: meta.publisher || prev.publisher || '',
                isbn: meta.isbn || prev.isbn || '',
                cover_image: meta.cover_image || prev.cover_image || '',
            } ) );

            if ( isMultiVolType( form.type ) ) {
                setVolumes( [ {
                    vol: 1,
                    file_path: json.file_url || '',
                    file_type: json.file_type || ext,
                    cover_image: meta.cover_image || '',
                } ] );
                if ( meta.cover_image ) {
                    setSharedCover( meta.cover_image );
                }
            }

            flashMessage( `✅ File uploaded and form fields populated!` );
        } catch ( err ) {
            flashMessage( `❌ Upload failed: ${ err instanceof Error ? err.message : 'Unknown error' }` );
        } finally {
            setSaving( false );
        }
    };

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
            if ( editingItem.category_ids && formCategories.length > 0 ) {
                const names = formCategories
                    .filter( ( c ) => editingItem.category_ids?.includes( c.id ) )
                    .map( ( c ) => c.name );
                setFormCategoriesText( names.join( ', ' ) );
            } else {
                setFormCategoriesText( '' );
            }
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
            setFormCategoriesText( '' );
            resetVolumes();
        }
    }, [ editingItem, formCategories ] );

    const updateField = ( field: string, value: string | boolean ) => {
        if ( field === 'type' ) {
            setSelectedCategoryIds( [] );
            setFormCategoriesText( '' );
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

            payload.category_names = formCategoriesText;

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
                    className="bg-white dark:bg-gray-800 rounded-2xl shadow-2xl max-w-2xl w-full relative"
                    onClick={ ( e ) => e.stopPropagation() }
                    onDragEnter={ handleDragEnter }
                    onDragOver={ handleDragOver }
                    onDragLeave={ handleDragLeave }
                    onDrop={ handleDrop }
                >
                    { isDragging && (
                        <div className="absolute inset-0 bg-blue-500/10 backdrop-blur-sm border-2 border-dashed border-blue-500 rounded-2xl flex flex-col items-center justify-center z-50 pointer-events-none">
                            <div className="bg-white dark:bg-gray-800 p-6 rounded-2xl shadow-xl flex flex-col items-center gap-2">
                                <span className="text-4xl animate-bounce">📥</span>
                                <p className="text-sm font-semibold text-gray-800 dark:text-white">{ t( 'itemForm.dropToUpload' ) || 'Drop file here to upload & autofill' }</p>
                                <p className="text-xs text-gray-500 dark:text-gray-400">{ t( 'itemForm.supportedFormats' ) || 'Supports EPUB, PDF, TXT, DOCX' }</p>
                            </div>
                        </div>
                    ) }
                    <div className="flex items-center justify-between p-6 border-b border-gray-200 dark:border-gray-700">
                        <h2 className="text-xl font-bold text-gray-900 dark:text-white">
                            { editingItem ? t('itemForm.editTitle') : t('itemForm.createTitle') }
                        </h2>
                        <button onClick={ onClose } className="p-2 hover:bg-gray-100 dark:hover:bg-gray-700 rounded-lg transition-colors text-gray-500 dark:text-gray-400">
                            ✕
                        </button>
                    </div>

                    <div className="p-6 space-y-4 max-h-[70vh] overflow-y-auto">
                        {/* Drag & Drop Hint Banner */}
                        <div className="bg-blue-50 dark:bg-blue-950/20 border border-blue-100 dark:border-blue-900/40 rounded-xl p-3 text-xs text-blue-700 dark:text-blue-300 flex items-start gap-2.5 shadow-sm">
                            <span className="text-base shrink-0">💡</span>
                            <div>
                                <p className="font-semibold">{ t( 'itemForm.dragDropHintTitle' ) }</p>
                                <p className="mt-0.5 opacity-90">{ t( 'itemForm.dragDropHintDesc' ) }</p>
                            </div>
                        </div>

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
                                <input
                                    type="text"
                                    value={ formCategoriesText }
                                    onChange={ ( e ) => setFormCategoriesText( e.target.value ) }
                                    placeholder={ t( 'itemForm.categoryPlaceholder' ) || 'e.g. Felsefe, Mantık' }
                                    className="jr-input w-full text-sm"
                                />
                                { formCategories.length > 0 && (
                                    <div className="flex flex-wrap gap-1 mt-1.5 max-h-24 overflow-y-auto p-1.5 bg-gray-50 dark:bg-gray-900/20 border border-gray-100 dark:border-gray-700/50 rounded-lg">
                                        { formCategories.map( ( cat ) => {
                                            const isSelected = formCategoriesText.split( ',' ).map( s => s.trim().toLowerCase() ).includes( cat.name.toLowerCase() );
                                            return (
                                                <button
                                                    key={ cat.id }
                                                    type="button"
                                                    onClick={ () => {
                                                        const currentNames = formCategoriesText.split( ',' ).map( s => s.trim() ).filter( Boolean );
                                                        const exists = currentNames.map( s => s.toLowerCase() ).indexOf( cat.name.toLowerCase() );
                                                        if ( exists >= 0 ) {
                                                            currentNames.splice( exists, 1 );
                                                        } else {
                                                            currentNames.push( cat.name );
                                                        }
                                                        setFormCategoriesText( currentNames.join( ', ' ) );
                                                    } }
                                                    className={ `px-2 py-0.5 text-xs rounded-full border transition-colors ${
                                                        isSelected
                                                            ? 'bg-blue-100 dark:bg-blue-900/40 border-blue-200 dark:border-blue-800 text-blue-700 dark:text-blue-300 font-semibold'
                                                            : 'bg-white dark:bg-gray-800 border-gray-200 dark:border-gray-700 text-gray-600 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-gray-700'
                                                    }` }
                                                >
                                                    { cat.name }
                                                </button>
                                            );
                                        } ) }
                                    </div>
                                ) }
                            </div>
                            <div>
                                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">{ t( 'itemForm.authorLabel' ) }</label>
                                <input
                                    type="text"
                                    disabled={ form.type === 'qa' }
                                    value={ form.author }
                                    onChange={ ( e ) => updateField( 'author', e.target.value ) }
                                    list="form-authors-list"
                                    className="jr-input w-full text-sm disabled:opacity-50"
                                    placeholder={ t( 'itemForm.authorPlaceholder' ) || 'Enter author name' }
                                />
                                <datalist id="form-authors-list">
                                    { formAuthors.map( ( a ) => (
                                        <option key={ a.id } value={ a.name } />
                                    ) ) }
                                </datalist>
                            </div>
                            <div>
                                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">{ t( 'itemForm.publisherLabel' ) }</label>
                                <input
                                    type="text"
                                    disabled={ form.type === 'qa' }
                                    value={ form.publisher }
                                    onChange={ ( e ) => updateField( 'publisher', e.target.value ) }
                                    list="form-publishers-list"
                                    className="jr-input w-full text-sm disabled:opacity-50"
                                    placeholder={ t( 'itemForm.publisherPlaceholder' ) || 'Enter publisher name' }
                                />
                                <datalist id="form-publishers-list">
                                    { formPublishers.map( ( p ) => (
                                        <option key={ p.id } value={ p.name } />
                                    ) ) }
                                </datalist>
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
    const [ settings, setSettings ] = React.useState<Record<string, any>>( {} );
    const [ loading, setLoading ] = React.useState( true );
    const [ saving, setSaving ] = React.useState( false );
    const [ message, setMessage ] = React.useState( '' );
    const savedRef = React.useRef<string>( '{}' );
    const [ isDirty, setIsDirty ] = React.useState( false );

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
                    ⚙️ JetReader Settings
                </h1>
                <p className="mt-1 text-gray-500 dark:text-gray-400 text-sm">
                    Configure plugin behavior and reader options.
                </p>
            </div>

            <ProUpgradeBanner />

            <div className="space-y-6">
                {/* Upload Max Size */}
                <div className="bg-white dark:bg-gray-800 rounded-xl shadow-md p-6 border border-gray-200 dark:border-gray-700">
                    <h3 className="font-semibold text-gray-900 dark:text-white mb-2">
                        📁 Maximum Upload Size (MB)
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
                                🔤 Default Reader Font Size
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
                                🎨 Default Reader Theme
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

                {/* ---------- LIBRARY DISPLAY ---------- */}
                <div className="bg-white dark:bg-gray-800 rounded-xl shadow-md p-6 border border-gray-200 dark:border-gray-700">
                    <h2 className="text-base font-bold text-gray-900 dark:text-white mb-5 flex items-center gap-2">
                        🗂️ Library View
                    </h2>

                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-5 mb-5">
                        {/* Items per page */}
                        <div>
                            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                                Items per page
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
                                Grid columns (desktop)
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
                            <p className="text-sm font-medium text-gray-700 dark:text-gray-300">Show filter sidebar</p>
                            <p className="text-xs text-gray-500 mt-0.5">Display the left sidebar on the library page</p>
                        </div>
                        <ToggleSwitch
                            checked={ Boolean( settings.show_sidebar ?? true ) }
                            onChange={ ( v ) => updateSetting( 'show_sidebar', v ) }
                        />
                    </div>

                    { /* ── Sidebar filter toggles ── */ }
                    <div className="border-t-2 border-indigo-100 dark:border-indigo-900/40 mt-6 pt-5 mb-3">
                        <p className="text-xs font-bold text-indigo-600 dark:text-indigo-400 uppercase tracking-wider">
                            Sidebar Filters — Show / Hide
                        </p>
                    </div>
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-6">
                        { [
                            { key: 'show_filter_category', label: '🏷️ Categories', desc: 'Filter by category' },
                            { key: 'show_filter_language', label: '🌐 Language',   desc: 'Filter by language' },
                            { key: 'show_filter_year',     label: '📅 Year Range',       desc: 'Filter by publication year' },
                        ].map( ( f ) => (
                            <div key={ f.key } className="flex items-center justify-between py-2.5 border-t border-gray-100 dark:border-gray-700">
                                <div className="min-w-0 mr-3">
                                    <p className="text-sm font-medium text-gray-700 dark:text-gray-300 flex items-center gap-1.5">
                                        { f.label }
                                    </p>
                                    <p className="text-xs text-gray-500 mt-0.5">{ f.desc }</p>
                                </div>
                                <ToggleSwitch
                                    checked={ Boolean( settings[ f.key ] ?? true ) }
                                    onChange={ ( v ) => updateSetting( f.key, v ) }
                                />
                            </div>
                        ) ) }
                    </div>

                    { /* ── Card field visibility ── */ }
                    <div className="border-t-2 border-indigo-100 dark:border-indigo-900/40 mt-6 pt-5 mb-3">
                        <p className="text-xs font-bold text-indigo-600 dark:text-indigo-400 uppercase tracking-wider">
                            Card Fields — Show / Hide
                        </p>
                    </div>
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-6">
                        { [
                            { key: 'show_card_image',       label: '🖼️ Cover Image',       desc: 'Show the cover image on library cards',       def: true },
                            { key: 'show_card_title',       label: '📝 Item Title',       desc: 'Show the item title on cards',       def: true },
                        ].map( ( f ) => (
                            <div key={ f.key } className="flex items-center justify-between py-2.5 border-t border-gray-100 dark:border-gray-700">
                                <div className="min-w-0 mr-3">
                                    <p className="text-sm font-medium text-gray-700 dark:text-gray-300 flex items-center gap-1.5">
                                        { f.label }
                                    </p>
                                    <p className="text-xs text-gray-500 mt-0.5">{ f.desc }</p>
                                </div>
                                <ToggleSwitch
                                    checked={ Boolean( settings[ f.key ] ?? f.def ) }
                                    onChange={ ( v ) => updateSetting( f.key, v ) }
                                />
                            </div>
                        ) ) }
                    </div>

                    { /* ── Detail field visibility ── */ }
                    <div className="border-t-2 border-indigo-100 dark:border-indigo-900/40 mt-6 pt-5 mb-3">
                        <p className="text-xs font-bold text-indigo-600 dark:text-indigo-400 uppercase tracking-wider">
                            Detail Fields — Show / Hide
                        </p>
                        <p className="text-xs text-gray-500 mt-0.5">Affects all detail modals in library, grid, and slider views.</p>
                    </div>
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-6">
                        { [
                            { key: 'show_detail_image',       label: '🖼️ Cover Image',       desc: 'Show the cover image in the detail modal',       def: true },
                            { key: 'show_detail_title',       label: '📝 Item Title',       desc: 'Show the item title in the detail modal',       def: true },
                            { key: 'show_detail_author',      label: '✍️ Author',      desc: 'Show the author name in the detail modal',      def: true },
                        ].map( ( f ) => (
                            <div key={ f.key } className="flex items-center justify-between py-2.5 border-t border-gray-100 dark:border-gray-700">
                                <div className="min-w-0 mr-3">
                                    <p className="text-sm font-medium text-gray-700 dark:text-gray-300 flex items-center gap-1.5">
                                        { f.label }
                                    </p>
                                    <p className="text-xs text-gray-500 mt-0.5">{ f.desc }</p>
                                </div>
                                <ToggleSwitch
                                    checked={ Boolean( settings[ f.key ] ?? f.def ) }
                                    onChange={ ( v ) => updateSetting( f.key, v ) }
                                />
                            </div>
                        ) ) }
                    </div>
                </div>
            </div>
            <div className="mt-8 flex items-center gap-4">
                <button
                    onClick={ saveSettings }
                    disabled={ ! isDirty || saving }
                    className="jr-btn-primary disabled:opacity-50 disabled:cursor-not-allowed"
                >
                    { saving ? t( 'settings.saving' ) : t( 'settings.saveButton' ) }
                </button>
                { message && <p className="text-sm text-gray-700 dark:text-gray-300">{ message }</p> }
            </div>
        </div>
    );
};

const AboutPage: React.FC = () => {
    const { t } = useTranslation();
    const isPro = false;
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
/*  DisplaysPage — Visual shortcode builder                           */
/* ------------------------------------------------------------------ */

interface DisplayPreset {
    id: string;
    label: string;
    mode: 'grid' | 'slider';
    type: string;
    category: string;
    author: string;
    columns: number;
    columnsTablet: number;
    columnsMobile: number;
    visible: number;
    visibleTablet: number;
    visibleMobile: number;
    rows: number;
    limit: number;
    orderby: string;
    items: string;
    showFilter: boolean;
    showImage: boolean;
    showDescription: boolean;
    showType: boolean;
    showAuthor: boolean;
    showTranslator: boolean;
    showPublisher: boolean;
    showYear: boolean;
    showLanguage: boolean;
    showPageCount: boolean;
    showReadButton: boolean;
    showInfoButton: boolean;
    showArrows: boolean;
    showDots: boolean;
    drag: boolean;
    autoplay: boolean;
    autoplaySpeed: number;
    cardWidth: string;
    imageSize: 'small' | 'medium' | 'large' | 'xlarge' | 'xxlarge';
    imageFit:  'cover' | 'contain' | 'fill';
    cardMinWidth: number;
    width: string;
    height: string;
    title: string;
    cardRadius: 'none' | 'small' | 'medium' | 'large' | 'xlarge';
    cardBorder: 'none' | 'subtle' | 'thick';
    cardShadow: 'none' | 'subtle' | 'medium' | 'large';
    cardHover: 'none' | 'lift' | 'zoom' | 'glow' | 'shadow';
    cardAlign: 'left' | 'center';
    cardLayout: 'vertical' | 'horizontal';
}

const PRESET_DEFAULTS: DisplayPreset = {
    id: '',
    label: 'My Display',
    mode: 'grid',
    type: '',
    category: '',
    author: '',
    columns: 4,
    columnsTablet: 2,
    columnsMobile: 1,
    visible: 4,
    visibleTablet: 2,
    visibleMobile: 1,
    rows: 1,
    limit: 12,
    orderby: 'newest',
    items: '',
    showFilter: true,
    showImage: true,
    showDescription: false,
    showType: true,
    showAuthor: true,
    showReadButton: true,
    showInfoButton: true,
    showTranslator: false,
    showPublisher: false,
    showYear: true,
    showLanguage: true,
    showPageCount: true,
    showArrows: true,
    showDots: true,
    drag: true,
    autoplay: false,
    autoplaySpeed: 3000,
    cardWidth: '',
    imageSize: 'medium',
    imageFit:  'cover',
    cardMinWidth: 180,
    width: '100%',
    height: 'auto',
    title: '',
    cardRadius: 'medium',
    cardBorder: 'subtle',
    cardShadow: 'subtle',
    cardHover: 'zoom',
    cardAlign: 'left',
    cardLayout: 'vertical',
};

function buildShortcode( p: DisplayPreset ): string {
    const tag = p.mode === 'grid' ? 'jetreader_grid' : 'jetreader_slider';
    const parts: string[] = [];

    const add = ( key: string, val: string | number | boolean, def: string | number | boolean ) => {
        if ( String( val ) !== String( def ) ) parts.push( `${ key }="${ val }"` );
    };

    if ( p.type )     parts.push( `type="${ p.type }"` );
    if ( p.category ) parts.push( `category="${ p.category }"` );
    if ( p.author )   parts.push( `author="${ p.author }"` );
    if ( p.items )    parts.push( `items="${ p.items }"` );
    if ( p.title )    parts.push( `title="${ p.title }"` );

    add( 'orderby', p.orderby, 'newest' );
    add( 'limit',   p.limit,   p.mode === 'grid' ? 12 : 10 );

    if ( p.mode === 'grid' ) {
        add( 'columns',        p.columns,       4 );
        add( 'columns_tablet', p.columnsTablet, 2 );
        add( 'columns_mobile', p.columnsMobile, 1 );
        add( 'show_filter',    p.showFilter,    true );
    } else {
        add( 'visible',        p.visible,       4 );
        add( 'visible_tablet', p.visibleTablet, 2 );
        add( 'visible_mobile', p.visibleMobile, 1 );
        add( 'rows',           p.rows,          1 );
        add( 'show_arrows',    p.showArrows,    true );
        add( 'show_dots',      p.showDots,      true );
        add( 'drag',           p.drag,          true );
        add( 'autoplay',       p.autoplay,      false );
        if ( p.autoplay ) add( 'autoplay_speed', p.autoplaySpeed, 3000 );
        if ( p.cardWidth ) parts.push( `card_width="${ p.cardWidth }"` );
    }

    add( 'show_image',        p.showImage,        true );
    add( 'show_description',  p.showDescription,  false );
    add( 'show_type',         p.showType,         true );
    add( 'show_author',       p.showAuthor,       true );
    add( 'show_read_button',  p.showReadButton,   true );
    add( 'show_info_button',  p.showInfoButton,   true );
    add( 'show_translator',   p.showTranslator,   false );
    add( 'show_publisher',    p.showPublisher,    false );
    add( 'show_year',         p.showYear,         true );
    add( 'show_language',     p.showLanguage,     true );
    add( 'show_page_count',   p.showPageCount,   true );
    add( 'image_size',        p.imageSize,        'medium' );
    add( 'image_fit',        p.imageFit,        'cover' );
    add( 'card_min_width',   p.cardMinWidth,    p.mode === 'grid' ? 180 : 160 );
    add( 'card_radius',      p.cardRadius,      'medium' );
    add( 'card_border',      p.cardBorder,      'subtle' );
    add( 'card_shadow',      p.cardShadow,      'subtle' );
    add( 'card_hover',       p.cardHover,       'zoom' );
    add( 'card_align',       p.cardAlign,       'left' );
    add( 'card_layout',      p.cardLayout,      'vertical' );
    add( 'width',            p.width,           '100%' );
    add( 'height',           p.height,          'auto' );

    return `[${ tag }${ parts.length ? ' ' + parts.join( ' ' ) : '' }]`;
}

const STORAGE_KEY = 'jetreader_display_presets';
function loadPresets(): DisplayPreset[] {
    try { const raw = localStorage.getItem( STORAGE_KEY ); return raw ? JSON.parse( raw ) : []; } catch { return []; }
}
function savePresets( list: DisplayPreset[] ) { localStorage.setItem( STORAGE_KEY, JSON.stringify( list ) ); }

/* Shared UI primitives (scoped to Displays page) */
const DSection: React.FC<{ title: string; children: React.ReactNode }> = ( { title, children } ) => (
    <div className="bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 p-5">
        <p className="text-xs font-semibold text-gray-400 dark:text-gray-500 uppercase tracking-wider mb-4">{ title }</p>
        <div className="space-y-3">{ children }</div>
    </div>
);
const DRow: React.FC<{ label: string; children: React.ReactNode }> = ( { label, children } ) => (
    <div className="flex items-center justify-between gap-4">
        <span className="text-sm text-gray-700 dark:text-gray-300 shrink-0 w-44">{ label }</span>
        <div className="flex-1">{ children }</div>
    </div>
);
const DSel: React.FC<{ value: string; onChange: ( v: string ) => void; options: { value: string; label: string }[] }> = ( { value, onChange, options } ) => (
    <select value={ value } onChange={ e => onChange( e.target.value ) }
        className="w-full text-sm border border-gray-300 dark:border-gray-600 rounded-lg px-3 py-1.5 bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100">
        { options.map( o => <option key={ o.value } value={ o.value }>{ o.label }</option> ) }
    </select>
);
const DNum: React.FC<{ value: number; min: number; max: number; onChange: ( v: number ) => void }> = ( { value, min, max, onChange } ) => {
    const [ draft, setDraft ] = React.useState( String( value ) );
    const committed = React.useRef( value );
    if ( committed.current !== value ) {
        committed.current = value;
        setDraft( String( value ) );
    }
    const commit = () => {
        const n = Math.max( min, Math.min( max, parseInt( draft, 10 ) || min ) );
        setDraft( String( n ) );
        if ( n !== value ) onChange( n );
    };
    return (
        <input type="number" value={ draft } min={ min } max={ max }
            onChange={ e => setDraft( e.target.value ) }
            onBlur={ commit }
            className="w-full text-sm border border-gray-300 dark:border-gray-600 rounded-lg px-3 py-1.5 bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100" />
    );
};
const DTxt: React.FC<{ value: string; placeholder?: string; onChange: ( v: string ) => void }> = ( { value, placeholder, onChange } ) => (
    <input type="text" value={ value } placeholder={ placeholder } onChange={ e => onChange( e.target.value ) }
        className="w-full text-sm border border-gray-300 dark:border-gray-600 rounded-lg px-3 py-1.5 bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100" />
);
const DToggle = ToggleSwitch;


const DisplaysPage: React.FC = () => null;
const ImportExportPage: React.FC = () => null;

const FilesPage: React.FC = () => {
    const { t } = useTranslation();
    const queryClient = useQueryClient();
    const apiBase  = ( window as any ).jetreaderSettings?.apiUrl?.replace( /\/$/, '' ) ?? '/wp-json/jetreader/v1';
    const nonce    = ( window as any ).jetreaderSettings?.nonce ?? '';
    const authHeader = { 'X-WP-Nonce': nonce, 'Content-Type': 'application/json' };

    // Search and tab filter states
    const [ searchTerm, setSearchTerm ] = React.useState( '' );
    const [ activeTab, setActiveTab ] = React.useState< 'pdf' | 'epub' | 'docx' | 'txt' | 'images' >( 'pdf' );
    const [ ghostOnly, setGhostOnly ] = React.useState( false );

    // Rename state
    const [ renamingFile, setRenamingFile ] = React.useState<string | null>( null );
    const [ newName, setNewName ] = React.useState( '' );
    const [ renameError, setRenameError ] = React.useState( '' );
    const [ renameProcessing, setRenameProcessing ] = React.useState( false );

    // Delete state
    const [ deletingFile, setDeletingFile ] = React.useState<any | null>( null );
    const [ deleteProcessing, setDeleteProcessing ] = React.useState( false );

    // Bulk selection state
    const [ selectedFiles, setSelectedFiles ] = React.useState<string[]>( [] );
    const [ bulkDeleteConfirm, setBulkDeleteConfirm ] = React.useState( false );

    // Upload state
    const [ isDragging, setIsDragging ] = React.useState( false );
    const [ uploadProgress, setUploadProgress ] = React.useState<{ [key: string]: number }>({});
    const [ uploadErrors, setUploadErrors ] = React.useState<string[]>([]);
    const dragCounterRef = React.useRef( 0 );

    // Copy notice state
    const [ copyNotice, setCopyNotice ] = React.useState( '' );

    // Query for files list
    const { data: files = [], isLoading } = useQuery<any[]>({
        queryKey: [ 'files' ],
        queryFn: async () => {
            const res = await fetch( `${ apiBase }/files`, { headers: { 'X-WP-Nonce': nonce } } );
            const json = await res.json();
            return Array.isArray( json ) ? json : [];
        }
    });



    // Filtered files logic
    const filteredFiles = files.filter( f => {
        // Search term check
        if ( searchTerm.trim() && ! f.name.toLowerCase().includes( searchTerm.toLowerCase() ) ) {
            return false;
        }

        // Tab category check
        const ext = f.extension;
        const isImage = [ 'png', 'jpg', 'jpeg', 'webp', 'gif', 'svg' ].includes( ext );
        
        if ( activeTab === 'images' && ! isImage ) return false;
        if ( activeTab !== 'images' && ext !== activeTab ) return false;

        // Ghost files toggle check
        if ( ghostOnly && f.linked_items.length > 0 ) return false;

        return true;
    } );

    // Tabs item counts
    const getTabCount = ( tab: string ) => {
        return files.filter( f => {
            const ext = f.extension;
            const isImage = [ 'png', 'jpg', 'jpeg', 'webp', 'gif', 'svg' ].includes( ext );
            if ( tab === 'images' ) return isImage;
            return ext === tab;
        } ).length;
    };

    // Copy to clipboard
    const copyUrlToClipboard = ( url: string ) => {
        navigator.clipboard.writeText( url );
        setCopyNotice( t( 'files.urlCopied' ) );
        setTimeout( () => setCopyNotice( '' ), 2000 );
    };

    // Handle single delete
    const handleDelete = async () => {
        if ( ! deletingFile ) return;
        setDeleteProcessing( true );
        try {
            const res = await fetch( `${ apiBase }/files?filename=${ encodeURIComponent( deletingFile.name ) }`, {
                method: 'DELETE',
                headers: { 'X-WP-Nonce': nonce }
            } );
            if ( res.ok ) {
                queryClient.invalidateQueries( { queryKey: [ 'files' ] } );
                setDeletingFile( null );
            }
        } catch ( e ) {
            console.error( e );
        } finally {
            setDeleteProcessing( false );
        }
    };

    // Handle bulk delete
    const handleBulkDelete = async () => {
        if ( selectedFiles.length === 0 ) return;
        setDeleteProcessing( true );
        try {
            const res = await fetch( `${ apiBase }/files`, {
                method: 'DELETE',
                headers: authHeader,
                body: JSON.stringify( { filenames: selectedFiles } )
            } );
            if ( res.ok ) {
                queryClient.invalidateQueries( { queryKey: [ 'files' ] } );
                setSelectedFiles( [] );
                setBulkDeleteConfirm( false );
            }
        } catch ( e ) {
            console.error( e );
        } finally {
            setDeleteProcessing( false );
        }
    };

    // Handle rename file
    const handleRename = async () => {
        if ( ! renamingFile || ! newName.trim() ) return;
        setRenameProcessing( true );
        setRenameError( '' );
        try {
            const ext = renamingFile.split('.').pop() || '';
            let finalNewName = newName.trim();
            if ( ! finalNewName.endsWith( `.${ ext }` ) ) {
                finalNewName = `${ finalNewName }.${ ext }`;
            }

            const res = await fetch( `${ apiBase }/files/rename`, {
                method: 'PUT',
                headers: authHeader,
                body: JSON.stringify( { old_name: renamingFile, new_name: finalNewName } )
            } );
            const data = await res.json();
            if ( res.ok && data.success ) {
                queryClient.invalidateQueries( { queryKey: [ 'files' ] } );
                setRenamingFile( null );
                setNewName( '' );
            } else {
                setRenameError( data.message || 'Rename failed' );
            }
        } catch ( e ) {
            setRenameError( 'Network error.' );
        } finally {
            setRenameProcessing( false );
        }
    };

    // File upload logic
    const handleUploadFiles = async ( filesToUpload: FileList | File[] ) => {
        setUploadErrors( [] );
        for ( let i = 0; i < filesToUpload.length; i++ ) {
            const file = filesToUpload[i];
            const key = `${ file.name }-${ Date.now() }`;
            setUploadProgress( prev => ( { ...prev, [ key ]: 10 } ) );

            const formData = new FormData();
            formData.append( 'file', file );

            try {
                const xhr = new XMLHttpRequest();
                xhr.open( 'POST', `${ apiBase }/upload` );
                xhr.setRequestHeader( 'X-WP-Nonce', nonce );

                xhr.upload.onprogress = ( event ) => {
                    if ( event.lengthComputable ) {
                        const pct = Math.round( ( event.loaded / event.total ) * 90 ) + 10;
                        setUploadProgress( prev => ( { ...prev, [ key ]: pct } ) );
                    }
                };

                xhr.onload = () => {
                    if ( xhr.status === 200 ) {
                        setUploadProgress( prev => {
                            const copy = { ...prev };
                            delete copy[ key ];
                            return copy;
                        } );
                        queryClient.invalidateQueries( { queryKey: [ 'files' ] } );
                    } else {
                        try {
                            const err = JSON.parse( xhr.responseText );
                            setUploadErrors( prev => [ ...prev, `${ file.name }: ${ err.message || 'Upload failed' }` ] );
                        } catch {
                            setUploadErrors( prev => [ ...prev, `${ file.name }: Upload failed` ] );
                        }
                        setUploadProgress( prev => {
                            const copy = { ...prev };
                            delete copy[ key ];
                            return copy;
                        } );
                    }
                };

                xhr.onerror = () => {
                    setUploadErrors( prev => [ ...prev, `${ file.name }: Network error.` ] );
                    setUploadProgress( prev => {
                        const copy = { ...prev };
                        delete copy[ key ];
                        return copy;
                    } );
                };

                xhr.send( formData );
            } catch ( e ) {
                setUploadErrors( prev => [ ...prev, `${ file.name }: Upload error.` ] );
            }
        }
    };

    const onDragOver = ( e: React.DragEvent ) => {
        e.preventDefault();
        e.stopPropagation();
    };

    const onDragEnter = ( e: React.DragEvent ) => {
        e.preventDefault();
        e.stopPropagation();
        dragCounterRef.current++;
        if ( dragCounterRef.current === 1 ) {
            setIsDragging( true );
        }
    };

    const onDragLeave = ( e: React.DragEvent ) => {
        e.preventDefault();
        e.stopPropagation();
        dragCounterRef.current--;
        if ( dragCounterRef.current === 0 ) {
            setIsDragging( false );
        }
    };

    const onDrop = ( e: React.DragEvent ) => {
        e.preventDefault();
        e.stopPropagation();
        setIsDragging( false);
        dragCounterRef.current = 0;
        if ( e.dataTransfer.files && e.dataTransfer.files.length > 0 ) {
            handleUploadFiles( e.dataTransfer.files );
        }
    };

    const handleFileSelect = ( e: React.ChangeEvent<HTMLInputElement> ) => {
        if ( e.target.files && e.target.files.length > 0 ) {
            handleUploadFiles( e.target.files );
        }
    };

    const toggleSelectFile = ( name: string ) => {
        setSelectedFiles( prev => {
            if ( prev.includes( name ) ) {
                return prev.filter( n => n !== name );
            } else {
                return [ ...prev, name ];
            }
        } );
    };

    const toggleSelectAll = () => {
        const pageFileNames = filteredFiles.map( f => f.name );
        const allSelected = pageFileNames.every( name => selectedFiles.includes( name ) );
        if ( allSelected ) {
            setSelectedFiles( prev => prev.filter( name => ! pageFileNames.includes( name ) ) );
        } else {
            setSelectedFiles( prev => [ ...Array.from( new Set( [ ...prev, ...pageFileNames ] ) ) ] as string[] );
        }
    };

    const isAllSelected = filteredFiles.length > 0 && filteredFiles.map( f => f.name ).every( name => selectedFiles.includes( name ) );

    return (
        <div className="p-6 max-w-7xl mx-auto">
            <div className="flex flex-col md:flex-row md:items-center justify-between mb-6 gap-4">
                <div>
                    <h1 className="text-2xl font-bold text-gray-900 dark:text-white flex items-center gap-2">
                        { t( 'files.title' ) }
                    </h1>
                    <p className="mt-1 text-gray-500 dark:text-gray-400 text-sm">
                        { t( 'files.subtitle' ) }
                    </p>
                </div>

                <div className="flex flex-wrap items-center gap-3">
                    <input
                        type="text"
                        placeholder={ t( 'files.searchPlaceholder' ) }
                        value={ searchTerm }
                        onChange={ e => setSearchTerm( e.target.value ) }
                        className="text-sm border border-gray-300 dark:border-gray-600 rounded-lg px-3 py-2 bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 placeholder-gray-400 dark:placeholder-gray-500 w-64"
                    />

                    <label className="flex items-center gap-2 cursor-pointer bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg px-3 py-2 text-xs text-gray-700 dark:text-gray-250 hover:bg-gray-50 dark:hover:bg-gray-700 transition-colors">
                        <input
                            type="checkbox"
                            checked={ ghostOnly }
                            onChange={ e => setGhostOnly( e.target.checked ) }
                            className="rounded border-gray-300 dark:border-gray-600 text-primary-600 focus:ring-primary-500"
                        />
                        <span>{ t( 'files.ghostFilesOnly' ) }</span>
                    </label>
                </div>
            </div>

            <div
                onDragOver={ onDragOver }
                onDragEnter={ onDragEnter }
                onDragLeave={ onDragLeave }
                onDrop={ onDrop }
                onClick={ () => document.getElementById( 'file-manager-upload-input' )?.click() }
                className={ `border-2 border-dashed rounded-xl p-8 mb-6 text-center cursor-pointer transition-all ${
                    isDragging
                        ? 'border-primary-500 bg-primary-50/50 dark:bg-primary-950/20 scale-[1.01] shadow-md'
                        : 'border-gray-300 dark:border-gray-700 hover:border-primary-400 bg-white dark:bg-gray-800 hover:bg-gray-50/50 dark:hover:bg-gray-750/30'
                }` }
            >
                <input
                    type="file"
                    id="file-manager-upload-input"
                    multiple
                    onChange={ handleFileSelect }
                    className="hidden"
                />
                <div className="flex flex-col items-center justify-center">
                    <div className="w-12 h-12 bg-primary-50 dark:bg-primary-950/40 rounded-full flex items-center justify-center mb-3 text-primary-500">
                        <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12" />
                        </svg>
                    </div>
                    <p className="text-sm font-semibold text-gray-700 dark:text-gray-250">
                        { t( 'files.uploadFiles' ) }
                    </p>
                    <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
                        { t( 'files.dropToUpload' ) }
                    </p>
                </div>
            </div>

            { copyNotice && (
                <div className="mb-4 bg-emerald-50 dark:bg-emerald-950/20 border border-emerald-200 dark:border-emerald-800/40 text-emerald-850 dark:text-emerald-300 rounded-lg px-4 py-2 text-xs font-semibold animate-pulse">
                    ✅ { copyNotice }
                </div>
            ) }

            { uploadErrors.length > 0 && (
                <div className="mb-4 bg-red-50 dark:bg-red-950/20 border border-red-200 dark:border-red-800/40 text-red-850 dark:text-red-300 rounded-lg p-3 text-xs">
                    <div className="font-bold mb-1">Upload errors occurred:</div>
                    <ul className="list-disc list-inside space-y-1">
                        { uploadErrors.map( ( err, idx ) => <li key={ idx }>{ err }</li> ) }
                    </ul>
                </div>
            ) }

            { Object.keys( uploadProgress ).length > 0 && (
                <div className="mb-6 space-y-2 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 p-4 rounded-xl shadow-sm">
                    <div className="text-xs font-semibold text-gray-500 dark:text-gray-450">Uploading files...</div>
                    { Object.entries( uploadProgress ).map( ([ name, pct ]) => (
                        <div key={ name } className="space-y-1">
                            <div className="flex justify-between text-[11px] text-gray-700 dark:text-gray-300">
                                <span className="truncate max-w-[80%] font-mono">{ name.substring( 0, name.lastIndexOf( '-' ) ) }</span>
                                <span>{ pct }%</span>
                            </div>
                            <div className="w-full bg-gray-100 dark:bg-gray-700 rounded-full h-1.5 overflow-hidden">
                                <div className="bg-primary-500 h-1.5 rounded-full transition-all duration-300" style={ { width: `${ pct }%` } } />
                            </div>
                        </div>
                    ) ) }
                </div>
            ) }

            <div className="flex border-b border-gray-200 dark:border-gray-700 mb-6 overflow-x-auto gap-2">
                {( [ 'pdf', 'epub', 'docx', 'txt', 'images' ] as const ).map( tab => {
                    const isActive = activeTab === tab;
                    const count = getTabCount( tab );
                    return (
                        <button
                            key={ tab }
                            onClick={ () => { setActiveTab( tab ); setSelectedFiles( [] ); } }
                            className={ `py-3 px-4 text-sm font-medium border-b-2 transition-all whitespace-nowrap flex items-center gap-2 ${
                                isActive
                                    ? 'border-primary-600 text-primary-650 dark:text-primary-400 border-b-primary-600 dark:border-b-primary-400'
                                    : 'border-transparent text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200'
                            }` }
                        >
                            <span>
                                { tab === 'pdf' && 'PDF' }
                                { tab === 'epub' && 'EPUB' }
                                { tab === 'docx' && 'DOCX' }
                                { tab === 'txt' && 'TXT' }
                                { tab === 'images' && t( 'files.tabImages' ) }
                            </span>
                            <span className={ `text-xs px-2 py-0.5 rounded-full ${
                                isActive ? 'bg-primary-100 text-primary-800 dark:bg-primary-950/40 dark:text-primary-300' : 'bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400'
                            }` }>
                                { count }
                            </span>
                        </button>
                    );
                } ) }
            </div>

            { selectedFiles.length > 0 && (
                <div className="bg-primary-50 dark:bg-primary-950/20 border border-primary-100 dark:border-primary-900/40 p-4 rounded-xl mb-4 flex items-center justify-between shadow-sm">
                    <span className="text-sm text-primary-800 dark:text-primary-300 font-medium">
                        📎 { selectedFiles.length } { t( 'common.selected' ) }
                    </span>
                    <div className="flex gap-2">
                        <button
                            onClick={ () => setSelectedFiles([]) }
                            className="bg-white dark:bg-gray-800 hover:bg-gray-50 text-gray-700 dark:text-gray-250 border border-gray-200 dark:border-gray-750 text-xs px-3 py-1.5 rounded-lg transition-colors font-semibold"
                        >
                            { t( 'items.deselect' ) }
                        </button>
                        <button
                            onClick={ () => setBulkDeleteConfirm( true ) }
                            className="bg-red-650 hover:bg-red-750 text-white text-xs px-3 py-1.5 rounded-lg transition-colors font-semibold shadow-sm hover:shadow"
                        >
                            { t( 'files.bulkDelete' ) }
                        </button>
                    </div>
                </div>
            ) }

            { isLoading ? (
                <div className="bg-white dark:bg-gray-800 rounded-2xl shadow p-12 text-center border border-gray-200 dark:border-gray-700 flex items-center justify-center">
                    <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary-500" />
                </div>
            ) : filteredFiles.length === 0 ? (
                <div className="bg-white dark:bg-gray-800 rounded-2xl shadow p-12 text-center border border-gray-200 dark:border-gray-700 text-gray-500 dark:text-gray-400">
                    <div className="text-3xl mb-2">📁</div>
                    <p className="text-sm font-semibold">{ t( 'files.noFilesFound' ) }</p>
                </div>
            ) : (
                <div className="bg-white dark:bg-gray-800 rounded-2xl shadow border border-gray-200 dark:border-gray-700 overflow-hidden">
                    <div className="overflow-x-auto">
                        <table className="w-full text-left border-collapse text-sm">
                            <thead>
                                <tr className="border-b border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-750 text-gray-500 dark:text-gray-400 font-semibold text-xs uppercase select-none">
                                    <th className="p-4 w-12 text-center">
                                        <input
                                            type="checkbox"
                                            checked={ isAllSelected }
                                            onChange={ toggleSelectAll }
                                            className="rounded border-gray-300 dark:border-gray-600 text-primary-600 focus:ring-primary-500"
                                        />
                                    </th>
                                    <th className="p-4">{ t( 'files.fileName' ) }</th>
                                    <th className="p-4 w-28">{ t( 'files.fileSize' ) }</th>
                                    <th className="p-4 w-44">{ t( 'files.uploadDate' ) }</th>
                                    <th className="p-4">{ t( 'files.linkedItem' ) }</th>
                                    <th className="p-4 w-36 text-right">{ t( 'files.actions' ) }</th>
                                </tr>
                            </thead>
                            <tbody className="divide-y divide-gray-200 dark:divide-gray-700">
                                { filteredFiles.map( file => {
                                    const isSelected = selectedFiles.includes( file.name );
                                    const isLinked = file.linked_items.length > 0;
                                    return (
                                        <tr
                                            key={ file.name }
                                            className={ `hover:bg-gray-50/50 dark:hover:bg-gray-750/30 transition-colors ${
                                                isSelected ? 'bg-primary-50/20 dark:bg-primary-950/5' : ''
                                            }` }
                                        >
                                            <td className="p-4 text-center">
                                                <input
                                                    type="checkbox"
                                                    checked={ isSelected }
                                                    onChange={ () => toggleSelectFile( file.name ) }
                                                    className="rounded border-gray-300 dark:border-gray-600 text-primary-600 focus:ring-primary-500"
                                                />
                                            </td>
                                            <td className="p-4 font-mono text-xs max-w-sm truncate text-gray-900 dark:text-white flex items-center gap-2">
                                                { activeTab === 'images' ? (
                                                    <img src={ file.url } alt="" className="w-8 h-8 rounded border border-gray-250 dark:border-gray-700 object-cover bg-gray-50 p-0.5 shadow-sm shrink-0" />
                                                ) : (
                                                    <span className="text-lg shrink-0 select-none">
                                                        { file.extension === 'pdf' && '📕' }
                                                        { file.extension === 'epub' && '📘' }
                                                        { file.extension === 'docx' && '📄' }
                                                        { file.extension === 'txt' && '📝' }
                                                    </span>
                                                ) }
                                                <span className="truncate select-all cursor-text" title={ file.name }>{ file.name }</span>
                                            </td>
                                            <td className="p-4 text-gray-500 dark:text-gray-400 whitespace-nowrap">
                                                { formatBytes( file.size ) }
                                            </td>
                                            <td className="p-4 text-gray-500 dark:text-gray-400 whitespace-nowrap">
                                                { formatDate( file.modified ) }
                                            </td>
                                            <td className="p-4">
                                                { isLinked ? (
                                                    <div className="flex flex-col gap-1.5 max-w-xs">
                                                        { file.linked_items.map( ( item: any ) => (
                                                            <div key={ item.id } className="flex items-center gap-1.5 text-xs text-gray-700 dark:text-gray-300">
                                                                <span className="shrink-0 select-none">
                                                                    { item.type === 'book' && '📚' }
                                                                    { item.type === 'article' && '📰' }
                                                                    { item.type === 'magazine' && '📔' }
                                                                    { item.type === 'qa' && '❓' }
                                                                </span>
                                                                <span className="font-semibold truncate" title={ item.title }>
                                                                    { item.title }
                                                                </span>
                                                            </div>
                                                        ) ) }
                                                    </div>
                                                ) : (
                                                    <span className="inline-flex items-center gap-1 text-[11px] font-semibold text-amber-700 dark:text-amber-400 bg-amber-50 dark:bg-amber-950/20 border border-amber-200/40 dark:border-amber-800/20 px-2 py-0.5 rounded-full select-none">
                                                        ⚠️ { t( 'files.ghostFile' ) }
                                                    </span>
                                                ) }
                                            </td>
                                            <td className="p-4 text-right space-x-1.5 whitespace-nowrap">
                                                <button
                                                    title={ t( 'files.copyUrl' ) }
                                                    onClick={ () => copyUrlToClipboard( file.url ) }
                                                    className="p-1.5 text-gray-400 hover:text-primary-600 hover:bg-gray-100 dark:hover:bg-gray-700 rounded-lg transition-colors inline-block"
                                                >
                                                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2.5" d="M8 5H6a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2v-1M8 5a2 2 0 002 2h2a2 2 0 002-2M8 5a2 2 0 012-2h2a2 2 0 012 2m0 0h2a2 2 0 012 2v3m2 4H10m0 0l3-3m-3 3l3 3" />
                                                    </svg>
                                                </button>
                                                <button
                                                    title={ t( 'files.rename' ) }
                                                    onClick={ () => { setRenamingFile( file.name ); setNewName( file.name.substring( 0, file.name.lastIndexOf('.') ) || file.name ); setRenameError( '' ); } }
                                                    className="p-1.5 text-gray-400 hover:text-indigo-600 hover:bg-gray-100 dark:hover:bg-gray-700 rounded-lg transition-colors inline-block"
                                                >
                                                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2.5" d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
                                                    </svg>
                                                </button>
                                                <button
                                                    title={ t( 'files.delete' ) }
                                                    onClick={ () => setDeletingFile( file ) }
                                                    className="p-1.5 text-gray-400 hover:text-red-650 hover:bg-gray-100 dark:hover:bg-gray-700 rounded-lg transition-colors inline-block"
                                                >
                                                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2.5" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                                                    </svg>
                                                </button>
                                            </td>
                                        </tr>
                                    );
                                } ) }
                            </tbody>
                        </table>
                    </div>
                </div>
            ) }

            { renamingFile && (
                <div className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm flex items-center justify-center p-4">
                    <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 shadow-2xl rounded-2xl w-full max-w-md overflow-hidden">
                        <div className="p-6 border-b border-gray-150 dark:border-gray-700 bg-gray-50/50 dark:bg-gray-800">
                            <h3 className="font-bold text-gray-900 dark:text-white flex items-center gap-2">
                                📝 { t( 'files.renameTitle' ) }
                            </h3>
                        </div>
                        <div className="p-6 space-y-4">
                            <div className="space-y-1.5">
                                <label className="text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wider block">
                                    { t( 'files.renameLabel' ) }
                                </label>
                                <input
                                    type="text"
                                    value={ newName }
                                    onChange={ e => setNewName( e.target.value ) }
                                    className="w-full text-sm border border-gray-300 dark:border-gray-600 rounded-lg px-3 py-2 bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-primary-500/20"
                                />
                            </div>
                            { renameError && (
                                <div className="text-xs text-red-600 dark:text-red-400 bg-red-50 dark:bg-red-950/20 border border-red-200/40 p-2.5 rounded-lg animate-pulse">
                                    ❌ { renameError }
                                </div>
                            ) }
                        </div>
                        <div className="p-6 bg-gray-50/50 dark:bg-gray-850 border-t border-gray-150 dark:border-gray-700 flex justify-end gap-2.5">
                            <button
                                disabled={ renameProcessing }
                                onClick={ () => setRenamingFile( null ) }
                                className="bg-white dark:bg-gray-850 hover:bg-gray-50 text-gray-700 dark:text-gray-250 border border-gray-300 text-xs px-4 py-2 rounded-lg transition-colors font-semibold disabled:opacity-50"
                            >
                                { t( 'common.cancel' ) }
                            </button>
                            <button
                                disabled={ renameProcessing || ! newName.trim() || newName.trim() === renamingFile.substring( 0, renamingFile.lastIndexOf('.') ) }
                                onClick={ handleRename }
                                className="bg-primary-600 hover:bg-primary-750 disabled:bg-primary-300 disabled:dark:bg-primary-900/45 text-white text-xs px-4 py-2 rounded-lg transition-colors font-semibold flex items-center gap-1.5 shadow-sm hover:shadow"
                            >
                                { renameProcessing ? 'Processing...' : t( 'common.save' ) }
                            </button>
                        </div>
                    </div>
                </div>
            ) }

            { deletingFile && (
                <div className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm flex items-center justify-center p-4">
                    <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 shadow-2xl rounded-2xl w-full max-w-md overflow-hidden">
                        <div className="p-6 border-b border-gray-150 dark:border-gray-700 bg-red-50/10 dark:bg-gray-800">
                            <h3 className="font-bold text-red-600 dark:text-red-400 flex items-center gap-2">
                                ⚠️ { t( 'files.deleteConfirmTitle' ) }
                            </h3>
                        </div>
                        <div className="p-6 space-y-4">
                            <p className="text-sm text-gray-600 dark:text-gray-300">
                                { t( 'files.deleteConfirmMsg' ) }
                            </p>
                            <p className="font-mono text-xs p-2 rounded bg-gray-50 dark:bg-gray-700 border border-gray-200 dark:border-gray-700 truncate max-w-full text-gray-900 dark:text-white">
                                { deletingFile.name }
                            </p>
                            { deletingFile.linked_items.length > 0 && (
                                <div className="text-xs text-amber-700 dark:text-amber-400 bg-amber-50 dark:bg-amber-950/20 border border-amber-200/40 p-3 rounded-lg space-y-2">
                                    <div className="font-bold">⚠️ Linked Items Warning:</div>
                                    <ul className="list-disc list-inside space-y-1">
                                        { deletingFile.linked_items.map( ( item: any ) => (
                                            <li key={ item.id } className="truncate">
                                                { t( 'files.deleteLinkedWarning' ).replace( '{title}', item.title ) }
                                            </li>
                                        ) ) }
                                    </ul>
                                </div>
                            ) }
                        </div>
                        <div className="p-6 bg-gray-50/50 dark:bg-gray-850 border-t border-gray-150 dark:border-gray-700 flex justify-end gap-2.5">
                            <button
                                disabled={ deleteProcessing }
                                onClick={ () => setDeletingFile( null ) }
                                className="bg-white dark:bg-gray-850 hover:bg-gray-50 text-gray-700 dark:text-gray-250 border border-gray-300 text-xs px-4 py-2 rounded-lg transition-colors font-semibold disabled:opacity-50"
                            >
                                { t( 'common.cancel' ) }
                            </button>
                            <button
                                disabled={ deleteProcessing }
                                onClick={ handleDelete }
                                className="bg-red-600 hover:bg-red-750 text-white text-xs px-4 py-2 rounded-lg transition-colors font-semibold flex items-center gap-1.5 shadow-sm hover:shadow"
                            >
                                { deleteProcessing ? 'Deleting...' : t( 'common.delete' ) }
                            </button>
                        </div>
                    </div>
                </div>
            ) }

            { bulkDeleteConfirm && (
                <div className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm flex items-center justify-center p-4">
                    <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 shadow-2xl rounded-2xl w-full max-w-md overflow-hidden">
                        <div className="p-6 border-b border-gray-150 dark:border-gray-700 bg-red-50/10 dark:bg-gray-800">
                            <h3 className="font-bold text-red-600 dark:text-red-400 flex items-center gap-2">
                                ⚠️ { t( 'files.deleteConfirmTitle' ) }
                            </h3>
                        </div>
                        <div className="p-6 space-y-4">
                            <p className="text-sm text-gray-600 dark:text-gray-300">
                                Are you sure you want to delete the { selectedFiles.length } selected files from disk? This action cannot be undone.
                            </p>
                        </div>
                        <div className="p-6 bg-gray-50/50 dark:bg-gray-850 border-t border-gray-150 dark:border-gray-700 flex justify-end gap-2.5">
                            <button
                                disabled={ deleteProcessing }
                                onClick={ () => setBulkDeleteConfirm( false ) }
                                className="bg-white dark:bg-gray-850 hover:bg-gray-550 text-gray-700 dark:text-gray-250 border border-gray-300 text-xs px-4 py-2 rounded-lg transition-colors font-semibold disabled:opacity-50"
                            >
                                { t( 'common.cancel' ) }
                            </button>
                            <button
                                disabled={ deleteProcessing }
                                onClick={ handleBulkDelete }
                                className="bg-red-600 hover:bg-red-750 text-white text-xs px-4 py-2 rounded-lg transition-colors font-semibold flex items-center gap-1.5 shadow-sm hover:shadow"
                            >
                                { deleteProcessing ? 'Deleting...' : t( 'common.delete' ) }
                            </button>
                        </div>
                    </div>
                </div>
            ) }
        </div>
    );
};

/* ------------------------------------------------------------------ */
/*  Main App with routing                                              */
/* ------------------------------------------------------------------ */

/**
 * Sync the WP admin sidebar active state with the current SPA page.
 * Called after every pushState navigation so the left menu stays in sync.
 */
function updateWpMenuActive( page: string ) {
    // Remove "current" from every JetReader submenu item.
    document.querySelectorAll( '#adminmenu .wp-submenu li' ).forEach( ( el ) => {
        el.classList.remove( 'current' );
    } );
    // Mark the matching submenu item as active.
    const link = document.querySelector(
        `#adminmenu a[href*="page=${ page }"]`
    ) as HTMLElement | null;
    if ( link ) link.closest( 'li' )?.classList.add( 'current' );
}

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
        switch ( currentPage ) {
            case 'jetreader':            return <LectorDashboard />;
            case 'jetreader-items':      return <ItemsPage />;
            case 'jetreader-constants':
            case 'jetreader-categories': return <ConstantsPage />;
            case 'jetreader-settings':   return <SettingsPage />;
            case 'jetreader-about':      return <AboutPage />;
            default:                     return <LectorDashboard />;
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
