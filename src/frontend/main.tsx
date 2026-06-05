import React, { lazy, Suspense } from 'react';
import ReactDOM from 'react-dom/client';
import '../index.css';
import App, { StandaloneSearchApp } from './App';
import type { ReaderFormat } from '../reader/ReaderEngine';

interface VolumeEntry { vol: number; file_path: string; file_type: string; cover_image: string; }

const ReaderModal = lazy( () => import( '../reader/ReaderModal' ) );
import { I18nProvider } from '../i18n/I18nContext';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import DisplayGrid from './components/DisplayGrid';
import DisplaySlider from './components/DisplaySlider';
import type { GridAttrs, SliderAttrs } from './components/types';

const queryClient = new QueryClient( {
    defaultOptions: { queries: { staleTime: 1000 * 60 * 3, retry: 1 } },
} );



/* ── Library shortcode mode: #jetreader-frontend-app ── */
const libraryContainer = document.getElementById( 'jetreader-frontend-app' );
if ( libraryContainer ) {
    const libraryType  = libraryContainer.dataset.libraryType  ?? '';
    const libraryTypes = libraryContainer.dataset.libraryTypes ?? '';
    const root = ReactDOM.createRoot( libraryContainer );
    root.render(
        <React.StrictMode>
            <App libraryType={ libraryType } libraryTypes={ libraryTypes } />
        </React.StrictMode>
    );
}

/* ── Display shortcodes: [jetreader_grid] and [jetreader_slider] ── */
function parseBool( v: string | undefined, def: boolean ): boolean {
    if ( v === undefined || v === '' ) return def;
    return v === 'true' || v === '1';
}

/* ── Standalone search block: [jetreader_search] → #jetreader-search-app ── */
const searchContainer = document.getElementById( 'jetreader-search-app' );
if ( searchContainer ) {
    searchContainer.innerHTML = '';
    ReactDOM.createRoot( searchContainer ).render(
        <React.StrictMode>
            <StandaloneSearchApp />
        </React.StrictMode>
    );
}

document.querySelectorAll<HTMLElement>( '[data-jr-display]' ).forEach( el => {
    const d    = el.dataset;
    const mode = d.jrDisplay;

    if ( mode === 'grid' ) {
        const attrs: GridAttrs = {
            type:            d.type        ?? '',
            category:        d.category    ?? '',
            author:          d.author      ?? '',
            limit:           parseInt( d.limit ?? '12', 10 ),
            orderby:         d.orderby     ?? 'newest',
            items:           d.items       ?? '',
            showFilter:      parseBool( d.showFilter,      true ),
            showImage:       parseBool( d.showImage,       true ),
            showDescription: parseBool( d.showDescription, false ),
            showType:        parseBool( d.showType,        true ),
            showAuthor:      parseBool( d.showAuthor,      true ),
            showReadButton:  parseBool( d.showReadButton,  true ),
            showInfoButton:  parseBool( d.showInfoButton,  true ),
            showTranslator:  parseBool( d.showTranslator,  false ),
            showPublisher:   parseBool( d.showPublisher,   false ),
            showYear:        parseBool( d.showYear,        true ),
            showLanguage:    parseBool( d.showLanguage,    true ),
            width:           d.width  ?? '100%',
            height:          d.height ?? 'auto',
            title:           d.title  ?? '',
            columns:         parseInt( d.columns       ?? '4', 10 ),
            columnsTablet:   parseInt( d.columnsTablet ?? '2', 10 ),
            columnsMobile:   parseInt( d.columnsMobile ?? '1', 10 ),
            imageSize:       ( d.imageSize ?? 'medium' ) as 'small' | 'medium' | 'large' | 'xlarge' | 'xxlarge',
            imageFit:        ( d.imageFit  ?? 'cover'  ) as 'cover' | 'contain' | 'fill',
            cardMinWidth:    parseInt( d.cardMinWidth ?? '180', 10 ),
            cardRadius:      ( d.cardRadius ?? 'medium' ) as any,
            cardBorder:      ( d.cardBorder ?? 'subtle' ) as any,
            cardShadow:      ( d.cardShadow ?? 'subtle' ) as any,
            cardHover:       ( d.cardHover ?? 'zoom' ) as any,
            cardAlign:       ( d.cardAlign ?? 'left' ) as any,
            cardLayout:      ( d.cardLayout ?? 'vertical' ) as any,
        };
        ReactDOM.createRoot( el ).render(
            <React.StrictMode><DisplayGrid { ...attrs } /></React.StrictMode>
        );
    }

    if ( mode === 'slider' ) {
        const attrs: SliderAttrs = {
            type:            d.type        ?? '',
            category:        d.category    ?? '',
            author:          d.author      ?? '',
            limit:           parseInt( d.limit ?? '10', 10 ),
            orderby:         d.orderby     ?? 'newest',
            items:           d.items       ?? '',
            showFilter:      false,
            showImage:       parseBool( d.showImage,       true ),
            showDescription: parseBool( d.showDescription, false ),
            showType:        parseBool( d.showType,        true ),
            showAuthor:      parseBool( d.showAuthor,      true ),
            showReadButton:  parseBool( d.showReadButton,  true ),
            showInfoButton:  parseBool( d.showInfoButton,  true ),
            showTranslator:  parseBool( d.showTranslator,  false ),
            showPublisher:   parseBool( d.showPublisher,   false ),
            showYear:        parseBool( d.showYear,        true ),
            showLanguage:    parseBool( d.showLanguage,    true ),
            width:           d.width  ?? '100%',
            height:          d.height ?? 'auto',
            title:           d.title  ?? '',
            visible:         parseInt( d.visible       ?? '4', 10 ),
            visibleTablet:   parseInt( d.visibleTablet ?? '2', 10 ),
            visibleMobile:   parseInt( d.visibleMobile ?? '1', 10 ),
            rows:            parseInt( d.rows          ?? '1', 10 ),
            showArrows:      parseBool( d.showArrows,  true ),
            showDots:        parseBool( d.showDots,    true ),
            drag:            parseBool( d.drag,        true ),
            autoplay:        parseBool( d.autoplay,    false ),
            autoplaySpeed:   parseInt( d.autoplaySpeed ?? '3000', 10 ),
            cardWidth:       d.cardWidth ?? '',
            imageSize:       ( d.imageSize ?? 'medium' ) as 'small' | 'medium' | 'large' | 'xlarge' | 'xxlarge',
            imageFit:        ( d.imageFit  ?? 'cover'  ) as 'cover' | 'contain' | 'fill',
            cardMinWidth:    parseInt( d.cardMinWidth ?? '160', 10 ),
            cardRadius:      ( d.cardRadius ?? 'medium' ) as any,
            cardBorder:      ( d.cardBorder ?? 'subtle' ) as any,
            cardShadow:      ( d.cardShadow ?? 'subtle' ) as any,
            cardHover:       ( d.cardHover ?? 'zoom' ) as any,
            cardAlign:       ( d.cardAlign ?? 'left' ) as any,
            cardLayout:      ( d.cardLayout ?? 'vertical' ) as any,
        };
        ReactDOM.createRoot( el ).render(
            <React.StrictMode><DisplaySlider { ...attrs } /></React.StrictMode>
        );
    }
} );
