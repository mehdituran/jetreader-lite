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

/* ── Library shortcode mode: .jetreader-frontend-app-container ── */
const libraryContainers = document.querySelectorAll( '.jetreader-frontend-app-container' );
libraryContainers.forEach( ( container ) => {
    const htmlElement = container as HTMLElement;
    const libraryType  = htmlElement.dataset.libraryType  ?? '';
    const libraryTypes = htmlElement.dataset.libraryTypes ?? '';
    const root = ReactDOM.createRoot( htmlElement );
    root.render(
        <React.StrictMode>
            <App libraryType={ libraryType } libraryTypes={ libraryTypes } />
        </React.StrictMode>
    );
} );