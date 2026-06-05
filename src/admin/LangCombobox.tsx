import React, { useState, useRef, useEffect, useMemo } from 'react';
import { WORLD_LANGUAGES, LangEntry } from '../data/world-languages';

interface LangComboboxProps {
    value: string;
    onChange: ( code: string ) => void;
    disabled?: boolean;
    uiLocale?: string;
    placeholder?: string;
    searchPlaceholder?: string;
    className?: string;
}

function getLangDisplayName( entry: LangEntry, uiLocale: string ): string {
    try {
        const dn = new Intl.DisplayNames( [ uiLocale, 'en' ], { type: 'language' } );
        const result = dn.of( entry.code );
        if ( result && result !== entry.code ) return result;
    } catch {}
    return entry.name;
}

export const LangCombobox: React.FC<LangComboboxProps> = ( {
    value,
    onChange,
    disabled = false,
    uiLocale = 'en',
    placeholder,
    searchPlaceholder = '🔍',
    className = '',
} ) => {
    const [ open, setOpen ] = useState( false );
    const [ query, setQuery ] = useState( '' );
    const inputRef = useRef<HTMLInputElement>( null );
    const rootRef = useRef<HTMLDivElement>( null );

    const selected = useMemo(
        () => WORLD_LANGUAGES.find( ( l ) => l.code === value ),
        [ value ],
    );

    const filtered = useMemo( () => {
        if ( ! query.trim() ) return WORLD_LANGUAGES;
        const q = query.toLowerCase();
        return WORLD_LANGUAGES.filter( ( l ) => {
            const display = getLangDisplayName( l, uiLocale ).toLowerCase();
            return (
                l.code.toLowerCase().includes( q ) ||
                display.includes( q ) ||
                l.name.toLowerCase().includes( q ) ||
                l.native.toLowerCase().includes( q )
            );
        } );
    }, [ query, uiLocale ] );

    useEffect( () => {
        if ( open ) inputRef.current?.focus();
    }, [ open ] );

    useEffect( () => {
        const handler = ( e: MouseEvent ) => {
            if ( rootRef.current && ! rootRef.current.contains( e.target as Node ) ) {
                setOpen( false );
                setQuery( '' );
            }
        };
        document.addEventListener( 'mousedown', handler );
        return () => document.removeEventListener( 'mousedown', handler );
    }, [] );

    const triggerLabel = selected
        ? getLangDisplayName( selected, uiLocale )
        : ( placeholder ?? '—' );

    const triggerSecondary = selected && selected.native !== getLangDisplayName( selected, uiLocale )
        ? selected.native
        : null;

    return (
        <div ref={ rootRef } className={ `relative ${ className }` }>
            { /* Trigger */ }
            <button
                type="button"
                disabled={ disabled }
                onClick={ () => ! disabled && setOpen( ( o ) => ! o ) }
                className="jr-input w-full text-sm text-left flex items-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed"
            >
                <span className="flex-1 truncate">{ triggerLabel }</span>
                { triggerSecondary && (
                    <span className="text-xs text-gray-400 dark:text-gray-500 shrink-0 hidden sm:block truncate max-w-[35%]">
                        { triggerSecondary }
                    </span>
                ) }
                <span className={ `text-gray-400 shrink-0 text-xs transition-transform duration-150 ${ open ? 'rotate-180' : '' }` }>▾</span>
            </button>

            { /* Dropdown */ }
            { open && (
                <div className="absolute z-[9999] mt-1 left-0 right-0 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-xl shadow-xl overflow-hidden">
                    { /* Search */ }
                    <div className="p-2 border-b border-gray-100 dark:border-gray-700">
                        <input
                            ref={ inputRef }
                            type="text"
                            value={ query }
                            onChange={ ( e ) => setQuery( e.target.value ) }
                            onKeyDown={ ( e ) => {
                                if ( e.key === 'Escape' ) { setOpen( false ); setQuery( '' ); }
                            } }
                            placeholder={ searchPlaceholder }
                            className="jr-input w-full text-sm py-1.5"
                        />
                    </div>

                    { /* "No change" option for bulk edit */ }
                    { placeholder !== undefined && (
                        <button
                            type="button"
                            onClick={ () => { onChange( '' ); setOpen( false ); setQuery( '' ); } }
                            className={ `w-full text-left px-3 py-2 text-sm text-gray-400 dark:text-gray-500 hover:bg-gray-50 dark:hover:bg-gray-700 transition-colors ${ ! value ? 'bg-primary-50 dark:bg-primary-900/30 font-medium text-primary-700 dark:text-primary-300' : '' }` }
                        >
                            { placeholder }
                        </button>
                    ) }

                    { /* List */ }
                    <div className="max-h-56 overflow-y-auto">
                        { filtered.length === 0 ? (
                            <div className="px-3 py-3 text-sm text-center text-gray-400 dark:text-gray-500">—</div>
                        ) : (
                            filtered.map( ( l ) => {
                                const display = getLangDisplayName( l, uiLocale );
                                const isSelected = l.code === value;
                                const showNative = l.native !== display;
                                return (
                                    <button
                                        key={ l.code }
                                        type="button"
                                        onClick={ () => { onChange( l.code ); setOpen( false ); setQuery( '' ); } }
                                        className={ `w-full text-left px-3 py-1.5 text-sm flex items-center justify-between gap-2 transition-colors ${ isSelected ? 'bg-primary-50 dark:bg-primary-900/30 text-primary-700 dark:text-primary-300 font-medium' : 'hover:bg-gray-50 dark:hover:bg-gray-700' }` }
                                    >
                                        <span className="truncate">{ display }</span>
                                        <span className="text-xs text-gray-400 dark:text-gray-500 shrink-0 truncate max-w-[40%]">
                                            { showNative ? l.native : l.code }
                                        </span>
                                    </button>
                                );
                            } )
                        ) }
                    </div>
                </div>
            ) }
        </div>
    );
};
