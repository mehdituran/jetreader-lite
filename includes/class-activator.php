<?php
/**
 * Fired during plugin activation.
 *
 * @package JetReader
 */

// If this file is called directly, abort.
if ( ! defined( 'WPINC' ) ) {
    die;
}

/**
 * Class JetReader_Activator
 *
 * Handles plugin activation tasks.
 */
class JetReader_Activator {

    /**
     * Activate the plugin.
     */
    public static function activate() {
        self::check_requirements();
        self::create_database_tables();
        self::set_default_options();
        self::register_cpts_and_flush();
        self::migrate_to_cpt();
        update_option( 'jetreader_edition', 'lite' );
    }

    /**
     * Check minimum requirements.
     */
    private static function check_requirements() {
        global $wp_version;

        // Check PHP version.
        if ( version_compare( PHP_VERSION, JETREADER_MINIMUM_PHP_VERSION, '<' ) ) {
            deactivate_plugins( JETREADER_PLUGIN_BASENAME );
            wp_die(
                sprintf(
                    /* translators: %s: PHP version */
                    esc_html__( 'JetReader requires PHP version %s or higher.', 'jetreader' ),
                    esc_html( JETREADER_MINIMUM_PHP_VERSION )
                ),
                'JetReader Activation Error',
                array( 'back_link' => true )
            );
        }

        // Check WordPress version.
        if ( version_compare( $wp_version, JETREADER_MINIMUM_WP_VERSION, '<' ) ) {
            deactivate_plugins( JETREADER_PLUGIN_BASENAME );
            wp_die(
                sprintf(
                    /* translators: %s: WordPress version */
                    esc_html__( 'JetReader requires WordPress version %s or higher.', 'jetreader' ),
                    esc_html( JETREADER_MINIMUM_WP_VERSION )
                ),
                'JetReader Activation Error',
                array( 'back_link' => true )
            );
        }
    }

    /**
     * Create custom database tables.
     */
    private static function create_database_tables() {
        require_once JETREADER_PLUGIN_DIR . 'includes/class-database.php';
        JetReader_Database::create_tables();
    }

    /**
     * Set default plugin options.
     */
    private static function set_default_options() {
        $defaults = array(
            'enabled_modules'    => array( 'books', 'articles', 'magazines', 'qa' ),
            'upload_max_size'    => 100, // MB
            'allowed_file_types' => array( 'epub', 'pdf', 'txt', 'docx' ),
            'reader_font_size'   => 'medium',
            'reader_theme'       => 'auto',
            'reader_layout'      => 'paginated',
            'grid_columns'       => 4,
            'items_per_page'     => 20,
            'search_engine'      => 'mysql',
            'cache_enabled'      => true,
            'annotation_enabled' => true,
            'copy_enabled'       => true,
            'plugin_language'    => 'en',
            // CPT URL slugs (customisable per language/site).
            'cpt_slug_book'      => 'books',
            'cpt_slug_article'   => 'articles',
            'cpt_slug_magazine'  => 'magazines',
            'cpt_slug_qa'        => 'qa',
            // Library card appearance.
            'library_card_radius' => 'medium',
            'library_card_border' => 'subtle',
            'library_card_shadow' => 'subtle',
            'library_card_hover'  => 'zoom',
            'library_card_align'  => 'left',
            'library_card_layout' => 'vertical',
            // Detail field visibility defaults.
            'show_detail_image'       => true,
            'show_detail_title'       => true,
            'show_detail_author'      => true,
            'show_detail_translator'  => true,
            'show_detail_publisher'   => true,
            'show_detail_year'        => true,
            'show_detail_type'        => true,
            'show_detail_language'    => true,
            'show_detail_page_count'  => true,
        );

        add_option( 'jetreader_settings', $defaults, '', 'no' );
    }

    /**
     * Register CPTs and flush rewrite rules so that the custom URL slugs
     * are available immediately after activation.
     */
    private static function register_cpts_and_flush(): void {
        if ( ! class_exists( 'JetReader_CPT' ) ) {
            require_once JETREADER_PLUGIN_DIR . 'includes/class-cpt.php';
        }

        JetReader_CPT::register();
        flush_rewrite_rules();

        // Mark as flushed so the runtime flush_once() skips it.
        update_option( 'jetreader_rewrite_flushed_v2', '1' );
    }

    /**
     * Create CPT posts for all existing items on first activation.
     * Skipped if migration already ran.
     */
    private static function migrate_to_cpt(): void {
        if ( get_option( 'jetreader_cpt_migrated' ) ) {
            return;
        }

        if ( ! class_exists( 'JetReader_CPT' ) ) {
            require_once JETREADER_PLUGIN_DIR . 'includes/class-cpt.php';
        }

        JetReader_CPT::migrate_all();
    }

}