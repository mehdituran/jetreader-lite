/**
 * Reads the current site locale / text direction from the values PHP
 * injects via wp_localize_script (sourced from WordPress's own
 * get_locale() / is_rtl(), so it follows the site locale and any
 * active Polylang/WPML language automatically).
 *
 * @package JetReader
 */

interface LocaleInfo {
    locale: string;
    isRtl: boolean;
}

export function useLocale(): LocaleInfo {
    const settings = ( window as any ).jetreaderSettings || {};
    return {
        locale: settings.locale || 'en',
        isRtl: !! settings.isRtl,
    };
}
