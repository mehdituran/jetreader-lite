import React, { lazy, Suspense } from 'react';
import ReactDOM from 'react-dom/client';
import '../index.css';
import App from './App';
import type { ReaderFormat } from '../reader/ReaderEngine';

const ReaderModal = lazy( () => import( '../reader/ReaderModal' ) );
import { I18nProvider } from '../i18n/I18nContext';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

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