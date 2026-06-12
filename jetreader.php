<?php
/**
 * JetReader - Book Library, EPUB & PDF Reader Plugin for WordPress
 *
 * @package           JetReader
 * @author            Mehdi Turan
 * @copyright         2026 JetReader
 * @license           GPL-2.0-or-later
 *
 * @wordpress-plugin
 * Plugin Name:       JetReader – Book Library, EPUB & PDF Reader (Lite)
 * Plugin URI:        https://wplector.com
 * Description:       Digital library plugin with modern reader experience. Supports EPUB, PDF, TXT, DOCX.
 * Version:           1.0.0
 * Requires at least: 6.4
 * Requires PHP:      8.2
 * Author:            Mehdi Turan
 * Author URI:        https://github.com/mehdituran
 * License:           GPL v2 or later
 * License URI:       https://www.gnu.org/licenses/gpl-2.0.html
 * Text Domain:       jetreader
 * Domain Path:       /lang
 *
 * Human-readable source code is in the src/ directory.
 * GitHub: https://github.com/mehdituran/jetreader-lite
 */

// If this file is called directly, abort.
if ( ! defined( 'WPINC' ) ) {
    die;
}

/**
 * Current plugin version.
 * Start at version 1.0.0 and use SemVer - https://semver.org
 */
define( 'JETREADER_VERSION', '1.0.0' );
define( 'JETREADER_PLUGIN_DIR', plugin_dir_path( __FILE__ ) );
define( 'JETREADER_PLUGIN_URL', plugin_dir_url( __FILE__ ) );
define( 'JETREADER_PLUGIN_BASENAME', plugin_basename( __FILE__ ) );
define( 'JETREADER_MINIMUM_WP_VERSION', '6.4' );
define( 'JETREADER_MINIMUM_PHP_VERSION', '8.2' );

/**
 * The code that runs during plugin activation.
 */
function jetreader_activate() {
    require_once JETREADER_PLUGIN_DIR . 'includes/class-activator.php';
    JetReader_Activator::activate();
}

/**
 * The code that runs during plugin deactivation.
 */
function jetreader_deactivate() {
    require_once JETREADER_PLUGIN_DIR . 'includes/class-deactivator.php';
    JetReader_Deactivator::deactivate();
}

register_activation_hook( __FILE__, 'jetreader_activate' );
register_deactivation_hook( __FILE__, 'jetreader_deactivate' );


/**
 * Declare compatibility with WooCommerce HPOS (High-Performance Order Storage).
 * Required to avoid admin compatibility warnings on WooCommerce stores.
 */
add_action( 'before_woocommerce_init', static function () {
    if ( class_exists( \Automattic\WooCommerce\Utilities\FeaturesUtil::class ) ) {
        \Automattic\WooCommerce\Utilities\FeaturesUtil::declare_compatibility( 'custom_order_tables', __FILE__, true );
    }
} );

/**
 * Begins execution of the plugin.
 */
require_once JETREADER_PLUGIN_DIR . 'includes/class-jetreader.php';

function jetreader_run() {
    $plugin = new JetReader();
    $plugin->run();
}

jetreader_run();

/**
 * Get translations for a given locale from lang/ JSON files.
 *
 * @param string $locale Language code (e.g. 'en', 'tr', 'ar').
 * @return array Translation array or empty array on failure.
 */
function jetreader_get_translations( $locale ) {
    // Sanitize locale to prevent directory traversal
    $locale = preg_replace( '/[^a-zA-Z0-9_-]/', '', $locale );
    if ( empty( $locale ) ) {
        $locale = 'en';
    }

    $file = JETREADER_PLUGIN_DIR . 'lang/' . $locale . '.json';

    if ( ! file_exists( $file ) ) {
        return array();
    }

    $file_mtime = filemtime( $file );
    $cache_key = 'jetreader_trans_' . $locale . '_' . JETREADER_VERSION . '_' . $file_mtime;
    if ( defined( 'WP_DEBUG' ) && WP_DEBUG ) {
        delete_transient( $cache_key );
        $cached = false;
    } else {
        $cached = get_transient( $cache_key );
    }
    if ( false !== $cached ) {
        return $cached;
    }

    $content = file_get_contents( $file );
    if ( false === $content ) {
        return array();
    }

    $decoded = json_decode( $content, true );
    $result  = is_array( $decoded ) ? $decoded : array();
    set_transient( $cache_key, $result, DAY_IN_SECONDS );
    return $result;
}

/**
 * Get list of available languages from lang/ directory.
 *
 * Scans the lang/ folder for *.json files and builds an array
 * of { code, name } objects.
 *
 * @return array Array of { code, name } language objects.
 */
function jetreader_get_available_languages() {
    $langs = array();
    $dir   = JETREADER_PLUGIN_DIR . 'lang/';

    if ( is_dir( $dir ) ) {
        $files = glob( $dir . '*.json' );
        if ( is_array( $files ) ) {
            $names = array(
                'en' => 'English',
                'tr' => 'Türkçe',
                'ar' => 'العربية',
                'de' => 'Deutsch',
                'es' => 'Español',
                'fr' => 'Français',
                'it' => 'Italiano',
                'pt' => 'Português',
                'ru' => 'Русский',
                'zh' => '中文',
            );
            foreach ( $files as $file ) {
                $code = basename( $file, '.json' );
                $name = $names[ $code ] ?? strtoupper( $code );
                $langs[] = array(
                    'code' => $code,
                    'name' => $name,
                );
            }
        }
    }

    if ( empty( $langs ) ) {
        $langs[] = array(
            'code' => 'en',
            'name' => 'English',
        );
    }

    return $langs;
}
