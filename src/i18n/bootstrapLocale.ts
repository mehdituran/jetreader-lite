import { setLocaleData } from '@wordpress/i18n';

/**
 * Feeds the JS translations PHP injected via window.jetreaderL10n
 * (see JetReader::inject_script_translations()) into this bundle's own
 * @wordpress/i18n instance. Mirrors what WP_Scripts::print_translations()
 * does for the window.wp.i18n global — our bundle carries its own copy of
 * the package instead, so it needs to be told about the data itself.
 *
 * Call once, before rendering, in every entry's main.tsx.
 */
export function bootstrapLocale(): void {
    const l10n = ( window as any ).jetreaderL10n;
    if ( ! l10n || ! l10n.locale_data ) return;

    const domain = l10n.domain || 'jetreader';
    const localeData = l10n.locale_data[ domain ] || l10n.locale_data.messages;
    if ( ! localeData ) return;

    if ( localeData[ '' ] ) localeData[ '' ].domain = domain;
    setLocaleData( localeData, domain );
}
