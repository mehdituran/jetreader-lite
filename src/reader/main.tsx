import React from 'react';
import ReactDOM from 'react-dom/client';
import '../index.css';
import ReaderModal from './ReaderModal';
import type { ReaderFormat } from './ReaderEngine';
import { I18nProvider } from '../i18n/I18nContext';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

interface VolumeEntry { vol: number; file_path: string; file_type: string; cover_image: string; }

const queryClient = new QueryClient( {
    defaultOptions: { queries: { staleTime: 1000 * 60 * 3, retry: 1 } },
} );

/* ── CPT single-page mode: #jetreader-page-app ── */
const pageContainer = document.getElementById( 'jetreader-page-app' );
if ( pageContainer ) {
    const itemId   = parseInt( pageContainer.dataset.itemId   ?? '0', 10 );
    const format   = ( pageContainer.dataset.format   ?? 'pdf' ) as ReaderFormat;
    const fileUrl  = pageContainer.dataset.fileUrl   ?? '';
    const title    = pageContainer.dataset.title     ?? '';
    const itemType = pageContainer.dataset.itemType  ?? '';

    let volumes: VolumeEntry[] | undefined;
    try {
        const raw = pageContainer.dataset.volumes;
        if ( raw ) {
            const parsed = JSON.parse( raw ) as VolumeEntry[];
            if ( Array.isArray( parsed ) && parsed.length >= 2 ) volumes = parsed;
        }
    } catch { /* ignore malformed JSON */ }

    // Resolve initial page: sessionStorage handoff takes priority over URL hash.
    let initialPage:   number | undefined = undefined;
    let initialVolume: number | undefined = undefined;
    let initialSearch: string | undefined = undefined;

    const storedLink = sessionStorage.getItem( 'jetreader_deeplink' );
    if ( storedLink ) {
        try {
            const data = JSON.parse( storedLink ) as { page?: number; volume?: number; search?: string };
            if ( data.page   !== undefined ) initialPage   = parseInt( String( data.page ),   10 ) || 0;
            if ( data.volume !== undefined ) initialVolume = parseInt( String( data.volume ),  10 ) || 0;
            if ( data.search ) initialSearch = data.search;
        } catch { /* ignore malformed entry */ }
        sessionStorage.removeItem( 'jetreader_deeplink' );
    }

    // Fall back to URL hash (#page=N&volume=V&search=term)
    if ( initialPage === undefined ) {
        const hash       = window.location.hash.slice( 1 );
        const hashParams = new URLSearchParams( hash );
        const p = hashParams.get( 'page' );
        const v = hashParams.get( 'volume' );
        if ( p ) initialPage   = parseInt( p, 10 ) || 0;
        if ( v ) initialVolume = parseInt( v, 10 ) || 0;
        if ( initialSearch === undefined ) initialSearch = hashParams.get( 'search' ) ?? undefined;
    }

    // Clear PHP-rendered placeholder before React takes over.
    pageContainer.innerHTML = '';

    const root = ReactDOM.createRoot( pageContainer );
    root.render(
        <React.StrictMode>
            <QueryClientProvider client={ queryClient }>
                <I18nProvider>
                    <ReaderModal
                        itemId={ itemId }
                        fileUrl={ fileUrl }
                        format={ format }
                        title={ title }
                        itemType={ itemType }
                        volumes={ volumes }
                        pageMode="page"
                        initialPage={ initialPage }
                        initialVolume={ initialVolume }
                        initialSearch={ initialSearch }
                        onClose={ () => window.history.back() }
                    />
                </I18nProvider>
            </QueryClientProvider>
        </React.StrictMode>
    );
}
