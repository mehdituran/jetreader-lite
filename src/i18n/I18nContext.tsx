/**
 * JetReader i18n Context Provider.
 *
 * Reads translations from window.jetreaderSettings.translations
 * (injected by PHP via wp_localize_script) and exposes a simple
 * t('section.key') function via React Context.
 *
 * @package JetReader
 */

import React, { createContext, useContext, useMemo } from 'react';

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

interface Translations {
    [key: string]: string | Translations;
}

interface I18nContextValue {
    /** Translate a dot-separated key like 'common.save' */
    t: ( key: string, replacements?: Record<string, string | number> ) => string;
    /** Current locale code (e.g. 'en', 'tr') */
    locale: string;
    /** Available languages list [{ code, name }] */
    availableLanguages: Array<{ code: string; name: string }>;
    /** Language direction: 'ltr' or 'rtl' */
    direction: 'ltr' | 'rtl';
}

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

/**
 * Deep-resolve a dot-separated path on a nested object.
 * Returns the value or the key itself if not found.
 */
function resolvePath( obj: Record<string, unknown>, path: string ): string {
    const parts = path.split( '.' );
    let current: unknown = obj;

    for ( const part of parts ) {
        if ( current && typeof current === 'object' && part in current ) {
            current = ( current as Record<string, unknown> )[ part ];
        } else {
            return path; // fallback: return the key itself
        }
    }

    return typeof current === 'string' ? current : path;
}

/**
 * Replace placeholders like {N} or {X} in a translated string.
 */
function interpolate( template: string, replacements?: Record<string, string | number> ): string {
    if ( ! replacements ) return template;
    return template.replace( /\{(\w+)\}/g, ( _, key: string ) =>
        String( replacements[ key ] ?? `{${key}}` ),
    );
}

/* ------------------------------------------------------------------ */
/*  Context                                                            */
/* ------------------------------------------------------------------ */

const I18nContext = createContext<I18nContextValue>( {
    t: ( key: string ) => key,
    locale: 'en',
    availableLanguages: [],
    direction: 'ltr',
} );

/* ------------------------------------------------------------------ */
/*  Provider                                                           */
/* ------------------------------------------------------------------ */

interface I18nProviderProps {
    children: React.ReactNode;
}

export const I18nProvider: React.FC<I18nProviderProps> = ( { children } ) => {
    const settings = ( window as any ).jetreaderSettings || {};

    const locale = settings.locale || 'en';
    const availableLanguages: Array<{ code: string; name: string }> =
        settings.availableLanguages || [];
    const rawTranslations: Translations = settings.translations || {};

    const direction: 'ltr' | 'rtl' =
        rawTranslations._language && typeof rawTranslations._language === 'object'
            ? ( ( rawTranslations._language as any ).direction === 'rtl' ? 'rtl' : 'ltr' )
            : 'ltr';

    const t = useMemo( () => {
        return ( key: string, replacements?: Record<string, string | number> ): string => {
            const resolved = resolvePath( rawTranslations as Record<string, unknown>, key );
            return interpolate( resolved, replacements );
        };
    }, [ rawTranslations ] );

    const value = useMemo( () => ( {
        t,
        locale,
        availableLanguages,
        direction,
    } ), [ t, locale, availableLanguages, direction ] );

    return (
        <I18nContext.Provider value={ value }>
            { children }
        </I18nContext.Provider>
    );
};

/* ------------------------------------------------------------------ */
/*  Hook                                                               */
/* ------------------------------------------------------------------ */

export function useTranslation(): I18nContextValue {
    return useContext( I18nContext );
}

export default I18nContext;