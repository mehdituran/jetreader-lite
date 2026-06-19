<?php
/**
 * Template for JetReader CPT singular pages.
 *
 * This template renders a full-screen reader and intentionally bypasses the
 * theme's layout. It outputs a clean HTML document (no get_header/get_footer)
 * so the theme cannot inject navigation, sidebar, or JavaScript that would
 * interfere with React's DOM management.
 *
 * Theme override: copy this file to your-theme/single-jetreader_book.php
 * (or single-jetreader.php) to customise the surrounding layout.
 *
 * @package JetReader
 */

// phpcs:disable WordPress.NamingConventions.PrefixAllGlobals

// Bail if called directly.
if ( ! defined( 'WPINC' ) ) {
    die;
}

$post_id   = get_the_ID();
$item_id   = (int) get_post_meta( $post_id, '_jetreader_item_id', true );
$format    = esc_attr( get_post_meta( $post_id, '_jetreader_format',    true ) );
$file_url  = esc_url(  get_post_meta( $post_id, '_jetreader_file_url',  true ) );
$item_type = esc_attr( get_post_meta( $post_id, '_jetreader_item_type', true ) );
$cover_url = esc_url(  get_post_meta( $post_id, '_jetreader_cover_url', true ) );
$author    = esc_html( get_post_meta( $post_id, '_jetreader_author',    true ) );
$encoding  = esc_attr( get_post_meta( $post_id, '_jetreader_encoding',  true ) );
$title     = esc_attr( get_the_title() );
$desc      = esc_html( get_the_excerpt() );
$permalink = esc_url( get_permalink() );

// Volumes for the volume switcher UI.
// _jetreader_volumes is synced here by JetReader_CPT::sync_from_item() whenever the
// item is created or updated; it holds the raw JSON string from the DB row.
$volumes_json = '';
$raw_volumes  = get_post_meta( $post_id, '_jetreader_volumes', true );
if ( $raw_volumes && is_string( $raw_volumes ) ) {
    $decoded = json_decode( $raw_volumes, true );
    if ( is_array( $decoded ) && count( $decoded ) >= 2 ) {
        $volumes_json = wp_json_encode( $decoded );
    }
}

$settings        = get_option( 'jetreader_settings', array() );
$plugin_language = $settings['plugin_language'] ?? 'en';

// ── Strip WordPress scripts that conflict with React on this page ─────────────
// The emoji detection script installs a MutationObserver on document.body that
// replaces emoji text nodes with <img> elements.  When React adds content the
// observer fires and swaps out nodes React still holds references to; the next
// reconciliation then calls removeChild on a node that is no longer a child of
// its expected parent, producing the "NotFoundError: removeChild" console error.
// We aggressively strip every script/style that is not our own bundle.
remove_action( 'wp_head',           'print_emoji_detection_script', 7 );
remove_action( 'wp_print_styles',   'print_emoji_styles' );
remove_action( 'admin_print_scripts','print_emoji_detection_script' );

// Disable emoji SVG / PNG loading entirely on this page.
add_filter( 'emoji_svg_url', '__return_false' );

// Third-party scripts and styles are intentionally NOT dequeued here.
// Removing them would break plugins that must run on all pages (analytics,
// cookie consent, WooCommerce fragments, membership access guards, etc.).

// ── Enqueue assets BEFORE wp_head() so CSS is output inside <head> ──────────
if ( ! wp_script_is( 'jetreader-frontend', 'enqueued' ) ) {
    $dist_dir = JETREADER_PLUGIN_DIR . 'dist/';
    $dist_url = JETREADER_PLUGIN_URL . 'dist/';

    $css_dir = $dist_dir . 'css/';
    if ( is_dir( $css_dir ) ) {
        foreach ( glob( $css_dir . '*.css' ) as $css_file ) {
            $name = basename( $css_file, '.css' );
            wp_enqueue_style(
                'jetreader-' . $name,
                $dist_url . 'css/' . $name . '.css',
                array(),
                JETREADER_VERSION
            );
        }
    }

    $entry = $dist_dir . 'js/reader.js';
    if ( file_exists( $entry ) ) {
        wp_enqueue_script(
            'jetreader-reader',
            $dist_url . 'js/reader.js',
            array(),
            JETREADER_VERSION,
            true // in footer — output by wp_footer() below
        );

        wp_localize_script(
            'jetreader-reader',
            'jetreaderSettings',
            array(
                'apiUrl'             => rest_url( 'jetreader/v1/' ),
                'nonce'              => wp_create_nonce( 'wp_rest' ),
                'pluginUrl'          => JETREADER_PLUGIN_URL,
                'locale'             => $plugin_language,
                'translations'       => jetreader_get_translations( $plugin_language ),
                'availableLanguages' => jetreader_get_available_languages(),
                'isLoggedIn'         => is_user_logged_in(),
                'siteUrl'            => get_site_url(),
                'pageMode'           => 'page',
            )
        );
    }
}

// ── Critical page CSS, registered through the style API ────────────────────
// A virtual (no-file) handle so wp_add_inline_style can attach the rules;
// WordPress then prints them via wp_head() instead of a hand-written <style> tag.
if ( ! wp_style_is( 'jetreader-reader-critical', 'registered' ) ) {
    wp_register_style( 'jetreader-reader-critical', false, array(), JETREADER_VERSION );
}
wp_enqueue_style( 'jetreader-reader-critical' );
wp_add_inline_style(
    'jetreader-reader-critical',
    '
    html, body {
        margin: 0;
        padding: 0;
        height: 100%;
        overflow: hidden;
    }
    #wpadminbar { position: fixed !important; }
    #jetreader-page-app {
        position: fixed;
        top: 0;
        left: 0;
        right: 0;
        bottom: 0;
        z-index: 2147483647;
        background: var(--jr-bg, #fff);
        display: flex;
        flex-direction: column;
    }
    .jr-page-loading {
        display: flex;
        align-items: center;
        justify-content: center;
        height: 100%;
        font-family: system-ui, -apple-system, sans-serif;
        font-size: 1rem;
        color: #555;
    }
    .jr-page-loading::after {
        content: "";
        display: inline-block;
        width: 1.5rem;
        height: 1.5rem;
        margin-left: .75rem;
        border: 2px solid currentColor;
        border-top-color: transparent;
        border-radius: 50%;
        animation: jr-spin .7s linear infinite;
    }
    @keyframes jr-spin { to { transform: rotate(360deg); } }
    '
);
?>
<!DOCTYPE html>
<html <?php language_attributes(); ?>>
<head>
    <meta charset="<?php bloginfo( 'charset' ); ?>">
    <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=5.0">

    <?php if ( ! defined( 'WPSEO_VERSION' ) && ! defined( 'RANK_MATH_VERSION' ) && ! defined( 'AIOSEO_VERSION' ) ) : ?>
    <!-- Meta description (JetReader fallback — overridden by SEO plugin) -->
    <meta name="description" content="<?php echo esc_attr( $desc ); ?>">
    <?php endif; ?>

    <title><?php echo esc_html( $title ); ?> &mdash; <?php bloginfo( 'name' ); ?></title>

    <!-- Preload JetReader scripts for instant initialization -->
    <link rel="modulepreload" href="<?php echo esc_url( JETREADER_PLUGIN_URL . 'dist/js/reader.js' ); ?>">
    <link rel="modulepreload" href="<?php echo esc_url( JETREADER_PLUGIN_URL . 'dist/js/ReaderModal.chunk.js' ); ?>">
    <link rel="modulepreload" href="<?php echo esc_url( JETREADER_PLUGIN_URL . 'dist/js/I18nContext.chunk.js' ); ?>">
    <link rel="modulepreload" href="<?php echo esc_url( JETREADER_PLUGIN_URL . 'dist/js/jsx-runtime.chunk.js' ); ?>">

    <?php wp_head(); ?>
</head>
<body <?php body_class( 'jetreader-page' ); ?>>

<?php wp_body_open(); ?>

<div
    id="jetreader-page-app"
    data-item-id="<?php echo esc_attr( $item_id ); ?>"
    data-format="<?php echo esc_attr( $format ); ?>"
    data-file-url="<?php echo esc_url( $file_url ); ?>"
    data-title="<?php echo esc_attr( $title ); ?>"
    data-item-type="<?php echo esc_attr( $item_type ); ?>"
    data-cover-url="<?php echo esc_url( $cover_url ); ?>"
    data-author="<?php echo esc_attr( $author ); ?>"
    data-permalink="<?php echo esc_url( $permalink ); ?>"
    data-language="<?php echo esc_attr( $plugin_language ); ?>"
    data-encoding="<?php echo esc_attr( $encoding ); ?>"
    <?php if ( $volumes_json ) : ?>data-volumes="<?php echo esc_attr( $volumes_json ); ?>"<?php endif; ?>
    role="main"
    aria-label="<?php echo esc_attr( $title ); ?>"
>
    <div class="jr-page-loading" aria-live="polite">
        <?php esc_html_e( 'Loading reader…', 'jetreader' ); ?>
    </div>
</div>

<?php wp_footer(); ?>
</body>
</html>
<?php
// Stop execution here. No theme header/footer was called so there is nothing
// left for WordPress or the theme to append.
exit;
