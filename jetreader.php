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
 * Plugin URI:        https://rikny.com
 * Description:       Digital library plugin with modern reader experience. Supports EPUB, PDF, TXT, DOCX.
 * Version:           1.1.1
 * Requires at least: 6.4
 * Requires PHP:      8.2
 * Author:            Mehdi Turan
 * Author URI:        https://github.com/mehdituran
 * License:           GPL v2 or later
 * License URI:       https://www.gnu.org/licenses/gpl-2.0.html
 * Text Domain:       jetreader
 * Domain Path:       /languages
 *
 * Human-readable source code is in the src/ directory.
 * GitHub: https://github.com/mehdituran/jetreader-lite
 */

// If this file is called directly, abort.
if ( ! defined( 'WPINC' ) ) {
    die;
}

/**
 * Guard against running alongside another JetReader edition (Lite or Pro).
 *
 * Both editions share identical class/function names by design. If both
 * happen to be active at once, PHP would fatal-error on "Cannot redeclare
 * class/function". If Pro is the one already loaded, Lite must never demote
 * it — Lite deactivates only ITSELF here and explains why, leaving Pro
 * untouched and fully in control.
 *
 * Re-uses the same transient JetReader Pro's own admin_notices hook already
 * checks (see jetreader-pro.php), so the explanation shows up on the very
 * next admin page load even though Lite itself won't be loaded anymore by
 * then to display it itself.
 */
if ( defined( 'JETREADER_VERSION' ) ) {
    $jetreader_lite_self = plugin_basename( __FILE__ );

    if ( ! function_exists( 'is_plugin_active' ) ) {
        require_once ABSPATH . 'wp-admin/includes/plugin.php';
    }

    if ( function_exists( 'is_plugin_active' ) && is_plugin_active( $jetreader_lite_self ) ) {
        deactivate_plugins( $jetreader_lite_self );
        set_transient( 'jetreader_pro_lite_auto_deactivated', true, MINUTE_IN_SECONDS );
    }
    return;
}

/**
 * Current plugin version.
 * Start at version 1.0.0 and use SemVer - https://semver.org
 */
define( 'JETREADER_VERSION', '1.1.1' );
define( 'JETREADER_PLUGIN_DIR', plugin_dir_path( __FILE__ ) );
define( 'JETREADER_PLUGIN_URL', plugin_dir_url( __FILE__ ) );
define( 'JETREADER_PLUGIN_BASENAME', plugin_basename( __FILE__ ) );
define( 'JETREADER_MINIMUM_WP_VERSION', '6.4' );
define( 'JETREADER_MINIMUM_PHP_VERSION', '8.2' );

/**
 * The functions below (jetreader_activate, jetreader_deactivate, jetreader_run)
 * live in includes/jetreader-functions.php instead of being declared directly
 * in this file. PHP binds unconditional top-level function declarations at
 * compile time, even past a runtime `return` — so if they stayed here, the
 * conflict guard above (which `return`s when another JetReader edition is
 * already loaded) would NOT stop them from being declared, and we'd hit the
 * exact "Cannot redeclare jetreader_activate()" fatal the guard exists to
 * prevent. Loading them via require_once (a runtime statement) makes them
 * properly conditional on the guard never having returned.
 */
require_once JETREADER_PLUGIN_DIR . 'includes/jetreader-functions.php';

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

jetreader_run();
