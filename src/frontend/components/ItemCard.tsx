import React, { useState } from 'react';
import { createPortal } from 'react-dom';
import { motion, AnimatePresence } from 'framer-motion';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from '../../i18n/I18nContext';
import { WORLD_LANGUAGES } from '../../data/world-languages';
import type { DisplayItem } from './types';
import type { ReaderFormat } from '../../reader/ReaderEngine';

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

const API_BASE = ( window as any ).jetreaderSettings?.apiUrl?.replace( /\/$/, '' ) ?? '/wp-json/jetreader/v1';
const getNonce = (): string =>
    ( window as any ).jetreaderSettings?.nonce
    || ( window as any ).wpApiSettings?.nonce
    || '';
const TYPE_ICON: Record<string, string> = {
    book: '📖',
    article: '📄',
    magazine: '🗞️',
    qa: '💬',
};

const TYPE_EMOJI: Record<string, string> = {
    book: '📖',
    article: '📄',
    magazine: '🗞️',
    qa: '💬',
};

const TYPE_LABEL: Record<string, string> = {
    book: 'Kitap',
    article: 'Makale',
    magazine: 'Dergi',
    qa: 'Soru-Cevap',
};

/* ------------------------------------------------------------------ */
/*  Stable portal container — created once, never moved                */
/* ------------------------------------------------------------------ */

function getModalPortal(): HTMLElement {
    const id = 'jr-modal-portal';
    let el = document.getElementById( id );
    if ( ! el ) {
        el = document.createElement( 'div' );
        el.id = id;
        el.className = 'jetreader-modal-root';
        document.body.appendChild( el );
    }
    return el;
}

/* ------------------------------------------------------------------ */
/*  Full Info Modal — identical layout to the main library modal       */
/* ------------------------------------------------------------------ */

const InfoModalInner: React.FC<{
    item: DisplayItem;
    onClose: () => void;
    t: ( k: string ) => string;
    showReadButton: boolean;
    showDownloadButton: boolean;
}> = ( { item, onClose, t, showReadButton, showDownloadButton } ) => {
    const { locale } = useTranslation();
    const [ selectedVol, setSelectedVol ] = React.useState<{ vol: number; file_path: string; file_type: string; cover_image: string } | null>( null );

    const { data: settings } = useQuery<Record<string, any>>( {
        queryKey: [ 'jr-public-settings' ],
        queryFn: async () => {
            const res = await fetch( `${ API_BASE }/public/settings` );
            return res.json();
        },
        staleTime: 1000 * 60 * 10,
    } );

    const isMultiVol = !! ( item.volumes && item.volumes.length > 1 );

    React.useEffect( () => {
        if ( item.file_path && item.type !== 'qa' && item.file_path.trim() !== '' ) {
            import( '../../reader/ReaderEngine' ).then( ( { ReaderEngine } ) => {
                ReaderEngine.prefetchBook( item.file_path, ( item.file_type || '' ).toLowerCase() as ReaderFormat );
            } ).catch( () => {} );
        }
    }, [ item.file_path, item.file_type, item.type ] );

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
    }, [ item.id ] );

    const handleRead = () => {
        if ( item.cpt_url ) window.location.href = item.cpt_url;
        onClose();
    };

    const dlHref  = isMultiVol ? ( selectedVol?.file_path ?? '' ) : item.file_path;
    const showDl  = showDownloadButton && ( isMultiVol ? !! selectedVol?.file_path : !! item.file_path );

    const metaFields = ( [
        settings?.show_detail_year !== false ? [ t( 'frontend.infoModalYear' ),     item.publication_year > 0 ? String( item.publication_year ) : null ] : null,
        settings?.show_detail_type !== false ? [ t( 'frontend.infoModalFormat' ),   item.file_type ? item.file_type.toUpperCase() : null ] : null,
        settings?.show_detail_language !== false ? [ t( 'frontend.infoModalLanguage' ), item.language ? getLangDisplayName( item.language, locale ) : null ] : null,
        settings?.show_detail_publisher !== false ? [ t( 'frontend.infoModalPublisher' ), item.publisher || null ] : null,
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
                { /* ── Close button ── */ }
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

                { /* ── Body: image panel + content panel ── */ }
                <div style={ { display: 'flex', flexDirection: 'row', flex: 1, minHeight: 0, overflow: 'hidden' } } className="jr-info-body">

                    { /* ── Left: Cover ── */ }
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
                                        { showDownloadButton && (
                                            <span style={ { fontSize: '11px', fontWeight: 500, letterSpacing: 0, textTransform: 'none', color: 'var(--jr-p400, #818cf8)' } }>
                                                { t( 'frontend.infoModalDownloadHint' ) }
                                            </span>
                                        ) }
                                    </p>
                                    <div style={ { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(140px, 1fr))', gap: '8px' } }>
                                        { item.volumes.map( ( vol ) => {
                                            const isSelected = selectedVol?.vol === vol.vol;
                                            return (
                                                <div
                                                    key={ vol.vol }
                                                    onClick={ () => setSelectedVol( isSelected ? null : vol ) }
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
                                                            { item.type === 'magazine' ? `${ t( 'frontend.infoModalVolItemMagazine' ) } ${ vol.vol }` : `${ t( 'frontend.infoModalVolItemBook' ) } ${ vol.vol }` }
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

                            { /* Description */ }
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
                            { showDownloadButton && (
                                isMultiVol && ! selectedVol ? (
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

            { /* ── Responsive CSS ── */ }
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

const InfoModal: React.FC<{
    item: DisplayItem;
    onClose: () => void;
    isOpen: boolean;
    showReadButton?: boolean;
    showDownloadButton?: boolean;
}> = ( { item, onClose, isOpen, showReadButton = true, showDownloadButton = false } ) => {
    const { t } = useTranslation();
    return createPortal(
        <AnimatePresence>
            { isOpen && (
                <InfoModalInner
                    item={ item }
                    onClose={ onClose }
                    t={ t }
                    showReadButton={ showReadButton }
                    showDownloadButton={ showDownloadButton }
                />
            ) }
        </AnimatePresence>,
        getModalPortal()
    );
};

/* ------------------------------------------------------------------ */
/*  ItemCard                                                           */
/* ------------------------------------------------------------------ */

export interface ItemCardProps {
    item: DisplayItem;
    showImage: boolean;
    showDescription: boolean;
    showType: boolean;
    showAuthor: boolean;
    showReadButton?: boolean;
    showInfoButton?: boolean;
    showDownloadButton?: boolean;
    showTranslator?: boolean;
    showPublisher?: boolean;
    showYear?: boolean;
    showLanguage?: boolean;
    showPageCount?: boolean;
    compact?: boolean;
    imageSize?: 'small' | 'medium' | 'large' | 'xlarge' | 'xxlarge';
    imageFit?:  'cover' | 'contain' | 'fill';
    cardRadius?: 'none' | 'small' | 'medium' | 'large' | 'xlarge';
    cardBorder?: 'none' | 'subtle' | 'thick';
    cardShadow?: 'none' | 'subtle' | 'medium' | 'large';
    cardHover?: 'none' | 'lift' | 'zoom' | 'glow' | 'shadow';
    cardAlign?: 'left' | 'center';
    cardLayout?: 'vertical' | 'horizontal';
}

const SIZE_CLASS: Record<string, string> = {
    small:  'h-24',
    medium: 'h-36',
    large:  'h-52',
    xlarge: 'h-72',
    xxlarge: 'h-[308px]',
};

const ItemCard: React.FC<ItemCardProps> = ( {
    item, showImage, showDescription, showType, showAuthor,
    showReadButton = true, showInfoButton = true, showDownloadButton = false,
    showTranslator = true, showPublisher = true, showYear = true, showLanguage = true,
    showPageCount = true,
    compact = false, imageSize, imageFit = 'cover',
    cardRadius = 'medium', cardBorder = 'subtle', cardShadow = 'subtle',
    cardHover = 'zoom', cardAlign = 'left', cardLayout = 'vertical',
} ) => {
    const { t, locale } = useTranslation();
    const [ infoOpen, setInfoOpen ] = useState( false );
 
    const isQA    = item.type === 'qa';
    const hasFile = !! item.file_path;
    const icon    = TYPE_ICON[ item.type ] ?? '📖';
    const coverH  = imageSize ? ( SIZE_CLASS[ imageSize ] ?? 'h-36' ) : ( compact ? 'h-36' : 'h-52' );
    const fitClass   = imageFit === 'contain' ? 'object-contain' : imageFit === 'fill' ? 'object-fill' : 'object-cover';
    const scaleClass = ( ! imageFit || imageFit === 'cover' ) ? 'group-hover:scale-[1.03] transition-transform duration-500 ease-out' : '';
 
    const handleRead = () => {
        if ( item.cpt_url ) window.location.href = item.cpt_url;
    };
 
    // Collect visible meta badges (file type, year, language, volumes)
    const metaBadges: { label: string; key: string }[] = [];
    if ( showType && item.file_type ) {
        metaBadges.push( { label: item.file_type.toUpperCase(), key: 'format' } );
    }
    if ( showYear && item.publication_year > 0 ) {
        metaBadges.push( { label: String( item.publication_year ), key: 'year' } );
    }
    if ( showLanguage && item.language ) {
        metaBadges.push( { label: getLangDisplayName( item.language, locale ), key: 'lang' } );
    }
    if ( showPageCount && item.page_count && item.page_count > 0 ) {
        metaBadges.push( { label: `${ item.page_count } ${ t( 'reader.pages' ) }`, key: 'page_count' } );
    }
    if ( item.volumes && item.volumes.length > 1 ) {
        metaBadges.push( { label: `${ item.volumes.length } ${ item.type === 'magazine' ? t( 'frontend.volumeMagazine' ) : t( 'frontend.volumeBook' ) }`, key: 'volumes' } );
    }

    // Publisher + translator combo line
    const hasSubtitleLine = ( showPublisher && item.publisher ) || ( showTranslator && item.translator );
    const hasReadingTime  = item.reading_time > 0;

    const prefetchRef = React.useRef<NodeJS.Timeout | null>( null );

    const handleMouseEnter = () => {
        if ( hasFile && ! isQA && item.file_path.trim() !== '' ) {
            prefetchRef.current = setTimeout( () => {
                import( '../../reader/ReaderEngine' ).then( ( { ReaderEngine } ) => {
                    ReaderEngine.prefetchBook( item.file_path, ( item.file_type || '' ).toLowerCase() as ReaderFormat );
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

    React.useEffect( () => {
        return () => {
            if ( prefetchRef.current ) clearTimeout( prefetchRef.current );
        };
    }, [] );

    const radiusClass = `jr-radius-${ cardRadius }`;
    const borderClass = `jr-border-${ cardBorder }`;
    const shadowClass = `jr-shadow-${ cardShadow }`;
    const hoverClass  = `jr-hover-${ cardHover }`;
    const alignClass  = `jr-align-${ cardAlign }`;
    const layoutClass = cardLayout === 'horizontal' ? 'flex flex-row items-stretch' : 'flex flex-col';

    const isHorizontal = cardLayout === 'horizontal';
    const coverW = imageSize === 'small' ? 'w-20 min-w-[80px]' : imageSize === 'medium' ? 'w-28 min-w-[112px]' : imageSize === 'xlarge' ? 'w-48 min-w-[192px]' : imageSize === 'xxlarge' ? 'w-56 min-w-[224px]' : 'w-36 min-w-[144px]';

    return (
        <>
            <motion.div
                layout
                initial={ { opacity: 0, y: 12 } }
                animate={ { opacity: 1, y: 0 } }
                exit={ { opacity: 0, scale: 0.96 } }
                transition={ { duration: 0.2 } }
                className={ `jr-card group h-full transition-all duration-300 ${ layoutClass } ${ radiusClass } ${ borderClass } ${ shadowClass } ${ hoverClass } ${ alignClass }`.replace(/\s+/g, ' ').trim() }
                onMouseEnter={ handleMouseEnter }
                onMouseLeave={ handleMouseLeave }
            >
                { /* ── Cover / Image Section ── */ }
                { showImage && (
                    isQA ? (
                        <div className={ `${ isHorizontal ? `${ coverW } h-auto min-h-full` : coverH } bg-gradient-to-br from-amber-400 to-orange-500 flex items-center justify-center shrink-0 relative overflow-hidden` }>
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
                                    <span className="text-4xl opacity-60">{ icon }</span>
                                    <p className="mt-1.5 text-[11px] font-medium line-clamp-2 opacity-70">{ item.title }</p>
                                </div>
                            ) }
                            { /* Overlay on hover — subtle gradient */ }
                            <div className="absolute inset-0 bg-gradient-to-t from-black/5 to-transparent opacity-0 group-hover:opacity-100 transition-opacity duration-300 pointer-events-none" />

                            { /* Top badges: type + featured */ }
                            <div className="absolute top-2 left-2 flex items-center gap-1.5">
                                { showType && (
                                    <span className="bg-white/90 dark:bg-black/60 backdrop-blur-sm text-slate-700 dark:text-slate-200 text-[10px] font-semibold px-2 py-0.5 rounded-full shadow-sm flex items-center gap-1">
                                        <span className="text-[11px] leading-none">{ icon }</span>
                                    </span>
                                ) }
                            </div>
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
                    { /* Type badge (if image hidden, show type here) */ }
                    { showType && ! showImage && (
                        <div className={ `flex items-center gap-1.5 ${ cardAlign === 'center' ? 'justify-center' : '' }` }>
                            <span className="text-[10px] bg-primary-100 dark:bg-primary-900/50 text-primary-700 dark:text-primary-300 px-2 py-0.5 rounded-full font-semibold uppercase tracking-wide flex items-center gap-1">
                                <span className="text-[11px] leading-none">{ icon }</span>
                                <span>{ TYPE_LABEL[ item.type ] ?? item.type }</span>
                            </span>
                            { item.featured && (
                                <span className="text-[10px] bg-yellow-100 dark:bg-yellow-900/50 text-yellow-700 dark:text-yellow-300 px-1.5 py-0.5 rounded-full font-medium">⭐</span>
                            ) }
                        </div>
                    ) }

                    { /* ── Title ── */ }
                    <h3 className={ `font-bold text-gray-900 dark:text-white line-clamp-2 text-[14px] leading-tight tracking-tight ${ cardAlign === 'center' ? 'text-center' : '' }` }>
                        { item.title }
                    </h3>

                    { /* ── Author ── */ }
                    { showAuthor && item.author && (
                        <p className={ `text-[12px] text-gray-500 dark:text-gray-400 truncate flex items-center gap-1 ${ cardAlign === 'center' ? 'justify-center' : '' }` }>
                            <svg className="w-3 h-3 shrink-0 text-gray-400 dark:text-gray-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2">
                                <path strokeLinecap="round" strokeLinejoin="round" d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z" />
                            </svg>
                            <span className="truncate">{ item.author }</span>
                        </p>
                    ) }

                    { /* ── Publisher + Translator combo line ── */ }
                    { hasSubtitleLine && (
                        <p className={ `text-[11px] text-gray-400 dark:text-gray-500 truncate flex items-center gap-1.5 flex-wrap ${ cardAlign === 'center' ? 'justify-center' : '' }` }>
                            { showPublisher && item.publisher && (
                                <span className="truncate italic flex items-center gap-0.5">
                                    <svg className="w-2.5 h-2.5 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2">
                                        <path strokeLinecap="round" strokeLinejoin="round" d="M19 21V5a2 2 0 00-2-2H7a2 2 0 00-2 2v16m14 0h2m-2 0h-5m-9 0H3m2 0h5M9 7h1m-1 4h1m4-4h1m-1 4h1m-5 10v-5a1 1 0 011-1h2a1 1 0 011 1v5m-4 0h4" />
                                    </svg>
                                    { item.publisher }
                                </span>
                            ) }
                            { showPublisher && item.publisher && showTranslator && item.translator && (
                                <span className="text-gray-300 dark:text-gray-600 select-none">·</span>
                            ) }
                            { showTranslator && item.translator && (
                                <span className="truncate flex items-center gap-0.5">
                                    <svg className="w-2.5 h-2.5 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2">
                                        <path strokeLinecap="round" strokeLinejoin="round" d="M3 5h12M9 3v2m1.048 9.5A18.022 18.022 0 016.412 9m6.088 9h7M11 21l5-10 5 10M12.751 5C11.783 10.77 8.07 15.61 3 18.129" />
                                    </svg>
                                    { item.translator }
                                </span>
                            ) }
                        </p>
                    ) }

                    { /* ── Meta Badges Row (format, year, language, volumes) ── */ }
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

                    { /* ── Description ── */ }
                    { showDescription && item.description && (
                        <p className={ `text-[11px] text-gray-500 dark:text-gray-400 line-clamp-2 leading-relaxed mt-0.5 ${ cardAlign === 'center' ? 'text-center' : '' }` }>
                            { item.description }
                        </p>
                    ) }

                    { /* ── Spacer ── */ }
                    <div className="flex-1 min-h-0" />

                    { /* ── Action Buttons ── */ }
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
                                    { t( 'display.read' ) }
                                </button>
                            ) }
                            { showInfoButton && (
                                <button
                                    onClick={ () => setInfoOpen( true ) }
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
                                    { t( 'display.info' ) }
                                </button>
                            ) }
                        </div>
                    ) }
                </div>
            </motion.div>

            <InfoModal
                item={ item }
                onClose={ () => setInfoOpen( false ) }
                isOpen={ infoOpen }
                showReadButton={ showReadButton }
                showDownloadButton={ showDownloadButton }
            />
        </>
    );
};

export default ItemCard;