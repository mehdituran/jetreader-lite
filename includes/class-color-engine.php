<?php
/**
 * Color Engine — injects palette CSS into wp_head for frontend scopes.
 *
 * Six preset palettes (green default, blue, amber, red, pink, purple) are
 * applied independently to three scopes: library, grid display, slider display.
 * CSS is injected as a non-layered <style> tag, which wins over all Tailwind
 * @layer rules regardless of specificity (CSS cascade layer spec).
 *
 * @package JetReader
 */

if ( ! defined( 'WPINC' ) ) {
    die;
}

class JetReader_Color_Engine {

    /**
     * All palette shade definitions.
     *
     * @return array<string, array<string, string>>
     */
    private static function palettes(): array {
        return array(
            'gray'   => array( '50' => '#f9fafb', '100' => '#f3f4f6', '200' => '#e5e7eb', '300' => '#d1d5db', '400' => '#9ca3af', '500' => '#6b7280', '600' => '#4b5563', '700' => '#374151', '800' => '#1f2937', '900' => '#111827' ),
            'amber'  => array( '50' => '#fffbeb', '100' => '#fef3c7', '200' => '#fde68a', '300' => '#fcd34d', '400' => '#fbbf24', '500' => '#f59e0b', '600' => '#d97706', '700' => '#b45309', '800' => '#92400e', '900' => '#78350f' ),
            'purple' => array( '50' => '#f5f3ff', '100' => '#ede9fe', '200' => '#ddd6fe', '300' => '#c4b5fd', '400' => '#a78bfa', '500' => '#8b5cf6', '600' => '#7c3aed', '700' => '#6d28d9', '800' => '#5b21b6', '900' => '#4c1d95' ),
        );
    }

    /**
     * Build CSS for a single scope selector + palette.
     *
     * @param string               $sel  CSS selector (e.g. '#jetreader-frontend-app').
     * @param array<string,string> $p    Palette shades keyed by '50'–'900'.
     * @return string
     */
    private static function scope_css( string $sel, array $p ): string {
        // Escape selector for use inside the string (already safe).
        $s   = $sel;
        $css = '';

        // ── 1. CSS custom properties on scope container ─────────────────────
        $css .= "{$s}{";
        foreach ( $p as $shade => $hex ) {
            $css .= "--jr-p{$shade}:{$hex};";
        }
        $css .= '}';

        // ── 2. background-color overrides ────────────────────────────────────
        $bg_shades = array( '50', '100', '500', '600', '700', '900' );
        foreach ( $bg_shades as $shade ) {
            $css .= "{$s} .bg-primary-{$shade}{background-color:var(--jr-p{$shade});}";
        }
        // Hover variants (Tailwind encodes as `.hover\:bg-primary-{n}:hover`).
        $css .= "{$s} .hover\\:bg-primary-50:hover{background-color:var(--jr-p50);}";
        $css .= "{$s} .hover\\:bg-primary-600:hover{background-color:var(--jr-p600);}";
        $css .= "{$s} .hover\\:bg-primary-700:hover{background-color:var(--jr-p700);}";

        // Dark-mode variants (`.dark .dark\:bg-primary-{n}`).
        $css .= ".dark {$s} .dark\\:bg-primary-900{background-color:var(--jr-p900);}";

        // Opacity variant bg-primary-900/30 — Tailwind compiles to rgb(…/.3).
        // We use color-mix() which is supported in Chrome 111+, FF 113+, Safari 16.2+.
        $p900_hex = $p['900'];
        $css .= "{$s} .bg-primary-900\\/30{background-color:color-mix(in srgb,{$p900_hex} 30%,transparent);}";
        $css .= ".dark {$s} .dark\\:bg-primary-900\\/30{background-color:color-mix(in srgb,{$p900_hex} 30%,transparent);}";

        // ── 3. text-color overrides ──────────────────────────────────────────
        $text_shades = array( '100', '300', '400', '500', '600', '700', '900' );
        foreach ( $text_shades as $shade ) {
            $css .= "{$s} .text-primary-{$shade}{color:var(--jr-p{$shade});}";
        }
        // Hover text.
        $css .= "{$s} .hover\\:text-primary-600:hover{color:var(--jr-p600);}";
        $css .= "{$s} .hover\\:text-primary-900:hover{color:var(--jr-p900);}";
        // Dark hover text.
        $css .= ".dark {$s} .dark\\:hover\\:text-primary-100:hover{color:var(--jr-p100);}";
        $css .= ".dark {$s} .dark\\:hover\\:text-primary-400:hover{color:var(--jr-p400);}";
        // Dark text.
        $css .= ".dark {$s} .dark\\:text-primary-300{color:var(--jr-p300);}";
        $css .= ".dark {$s} .dark\\:text-primary-400{color:var(--jr-p400);}";
        $css .= ".dark {$s} .dark\\:text-primary-100{color:var(--jr-p100);}";

        // ── 4. border-color overrides ────────────────────────────────────────
        $border_shades = array( '200', '300', '500', '600', '700' );
        foreach ( $border_shades as $shade ) {
            $css .= "{$s} .border-primary-{$shade}{border-color:var(--jr-p{$shade});}";
        }
        $css .= "{$s} .hover\\:border-primary-300:hover{border-color:var(--jr-p300);}";
        $css .= "{$s} .hover\\:border-primary-600:hover{border-color:var(--jr-p600);}";
        $css .= ".dark {$s} .dark\\:border-primary-700{border-color:var(--jr-p700);}";

        // ── 5. gradient overrides (Tailwind gradient CSS vars) ───────────────
        // Tailwind sets --tw-gradient-from and --tw-gradient-to on the element.
        // We override at same specificity level (scoped class selector).
        $grad_from = array( '400', '500', '600' );
        foreach ( $grad_from as $shade ) {
            $hex = $p[ $shade ];
            // Tailwind v3 also sets --tw-gradient-from-position and a stop-color fallback.
            $css .= "{$s} .from-primary-{$shade}{--tw-gradient-from:{$hex} var(--tw-gradient-from-position);--tw-gradient-to:rgb(255 255 255/0) var(--tw-gradient-to-position);--tw-gradient-stops:var(--tw-gradient-from),var(--tw-gradient-to);}";
        }
        $grad_to = array( '500', '600', '700' );
        foreach ( $grad_to as $shade ) {
            $hex = $p[ $shade ];
            $css .= "{$s} .to-primary-{$shade}{--tw-gradient-to:{$hex} var(--tw-gradient-to-position);}";
        }

        // ── 6. ring / accent / focus overrides ──────────────────────────────
        $css .= "{$s} .ring-primary-500{--tw-ring-color:var(--jr-p500);}";
        $css .= "{$s} .focus\\:ring-primary-500{--tw-ring-color:var(--jr-p500);}";
        $css .= "{$s} .focus-visible\\:ring-primary-500{--tw-ring-color:var(--jr-p500);}";
        $css .= "{$s} .accent-primary-600{accent-color:var(--jr-p600);}";
        $css .= "{$s} .focus\\:border-primary-500:focus{border-color:var(--jr-p500);}";

        // ── 7. component class overrides ─────────────────────────────────────
        $css .= "{$s} .jr-btn-primary{background-color:var(--jr-p600);color:#fff;}";
        $css .= "{$s} .jr-btn-primary:hover{background-color:var(--jr-p700);}";
        $css .= "{$s} .jr-btn-primary:active{background-color:var(--jr-p800);}";
        $css .= "{$s} .jr-btn-primary:focus{--tw-ring-color:var(--jr-p500);}";
        $css .= "{$s} .jr-input:focus{border-color:var(--jr-p500);--tw-ring-color:color-mix(in srgb,var(--jr-p500) 40%,transparent);}";

        return $css;
    }

    /**
     * wp_enqueue_scripts callback — registers palette CSS as an inline style.
     * Priority 20: runs after frontend assets are enqueued.
     */
    public static function inject_colors(): void {
        if ( is_admin() ) {
            return;
        }

        $settings = get_option( 'jetreader_settings', array() );
        $palette_slug = $settings['primary_palette'] ?? 'gray';

        $palettes  = self::palettes();
        $selected_palette = $palettes[ $palette_slug ] ?? $palettes['gray'];
        $scope_map = array(
            '#jetreader-frontend-app' => $selected_palette,
        );

        $css = '';
        foreach ( $scope_map as $selector => $palette ) {
            $css .= self::scope_css( $selector, $palette );
        }

        if ( ! $css ) {
            return;
        }

        // Register a virtual (no-file) handle so wp_add_inline_style works.
        if ( ! wp_style_is( 'jetreader-palette', 'registered' ) ) {
            wp_register_style( 'jetreader-palette', false, array(), JETREADER_VERSION );
        }
        wp_enqueue_style( 'jetreader-palette' );
        wp_add_inline_style( 'jetreader-palette', wp_strip_all_tags( $css ) );
    }
}
