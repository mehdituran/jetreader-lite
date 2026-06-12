<?php
/**
 * The core plugin class.
 *
 * @package JetReader
 */

// If this file is called directly, abort.
if ( ! defined( 'WPINC' ) ) {
    die;
}

/**
 * Main JetReader Class.
 */
class JetReader {

    /**
     * The loader that's responsible for maintaining and registering all hooks.
     *
     * @var array
     */
    protected $actions = array();

    /**
     * The unique identifier of this plugin.
     *
     * @var string
     */
    protected $plugin_name = 'jetreader';

    /**
     * The current version of the plugin.
     *
     * @var string
     */
    protected $version;

    /**
     * Define the core functionality of the plugin.
     */
    public function __construct() {
        $this->version = JETREADER_VERSION;

        $this->load_dependencies();
        $this->define_admin_hooks();
        $this->define_public_hooks();
        $this->define_rest_api_hooks();
        $this->define_gutenberg_hooks();
    }

    /**
     * Load the required dependencies for this plugin.
     */
    private function load_dependencies() {
        require_once JETREADER_PLUGIN_DIR . 'includes/class-database.php';
        require_once JETREADER_PLUGIN_DIR . 'includes/class-rest-api.php';
        require_once JETREADER_PLUGIN_DIR . 'includes/class-upload-handler.php';
        require_once JETREADER_PLUGIN_DIR . 'includes/class-parser-engine.php';
        if ( file_exists( JETREADER_PLUGIN_DIR . 'includes/class-gutenberg-blocks.php' ) ) {
            require_once JETREADER_PLUGIN_DIR . 'includes/class-gutenberg-blocks.php';
        }
        require_once JETREADER_PLUGIN_DIR . 'includes/class-cpt.php';
        require_once JETREADER_PLUGIN_DIR . 'includes/class-color-engine.php';

        // Register Elementor category and widgets on their respective hooks.
        add_action( 'elementor/elements/categories_registered', function ( $elements_manager ) {
            if ( file_exists( JETREADER_PLUGIN_DIR . 'includes/class-elementor-widgets.php' ) ) {
                require_once JETREADER_PLUGIN_DIR . 'includes/class-elementor-widgets.php';
                JetReader_Elementor_Widgets::register_category( $elements_manager );
            }
        } );

        add_action( 'elementor/widgets/register', function ( $widgets_manager ) {
            if ( file_exists( JETREADER_PLUGIN_DIR . 'includes/class-elementor-widgets.php' ) ) {
                require_once JETREADER_PLUGIN_DIR . 'includes/class-elementor-widgets.php';
                JetReader_Elementor_Widgets::register_widgets( $widgets_manager );
            }
        } );
    }

    /**
     * Register all of the hooks related to the admin area functionality.
     */
    private function define_admin_hooks() {
        add_action( 'admin_menu', array( $this, 'add_admin_menu' ) );
        add_action( 'admin_enqueue_scripts', array( $this, 'enqueue_admin_assets' ) );
        add_filter( 'script_loader_tag', array( $this, 'add_module_type' ), 10, 3 );

        // Allow JetReader document formats (EPUB, DOCX, DOC) in WordPress's upload
        // system. WordPress blocks these by default because it doesn't know their
        // MIME types. Without these two filters:
        //   1. upload_mimes  — WP Media Library would reject the file outright.
        //   2. wp_check_filetype_and_ext — EPUB files are ZIP archives internally;
        //      PHP's finfo reports them as "application/zip", not
        //      "application/epub+zip". Without overriding this, WordPress treats
        //      the file as a disguised ZIP and blocks it even when the extension
        //      is correct (affects JetReader's own /upload endpoint on some hosts
        //      and all standard WP media uploads).
        add_filter( 'upload_mimes', array( $this, 'allow_jetreader_mimes' ) );
        add_filter( 'wp_check_filetype_and_ext', array( $this, 'fix_jetreader_filetype' ), 10, 4 );
    }

    /**
     * Add JetReader document MIME types to WordPress's allowed upload list.
     *
     * Covers: EPUB, DOCX, DOC — the formats that WordPress omits by default.
     * PDF and TXT are already in WordPress's default list, so they are not
     * repeated here.
     *
     * @param array $mimes Current map of extension => MIME type.
     * @return array Extended map including JetReader document types.
     */
    public function allow_jetreader_mimes( array $mimes ): array {
        $mimes['epub'] = 'application/epub+zip';
        $mimes['docx'] = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
        $mimes['doc']  = 'application/msword';
        return $mimes;
    }

    /**
     * Fix filetype detection for EPUB files.
     *
     * EPUB is a renamed ZIP file. PHP's finfo extension reports the real MIME
     * as "application/zip", which causes WordPress's filetype validator to
     * consider the upload suspicious (the extension says "epub" but the bytes
     * say "zip"). This filter corrects the detected ext/type for any file whose
     * extension is "epub" so that WordPress's internal check passes cleanly.
     *
     * @param array       $data     { ext, type, proper_filename } from WordPress.
     * @param string      $file     Path to the temp file on disk.
     * @param string      $filename Original uploaded filename.
     * @param array|null  $mimes    Allowed MIME map passed to the checker.
     * @return array Corrected filetype data.
     */
    public function fix_jetreader_filetype( array $data, string $file, string $filename, $mimes ): array {
        // Only intervene when WordPress couldn't determine the type itself.
        if ( ! empty( $data['ext'] ) && ! empty( $data['type'] ) ) {
            return $data;
        }

        $ext = strtolower( pathinfo( $filename, PATHINFO_EXTENSION ) );

        if ( 'epub' === $ext ) {
            $data['ext']  = 'epub';
            $data['type'] = 'application/epub+zip';
        }

        return $data;
    }

    /**
     * Register all of the hooks related to the public-facing functionality.
     */
    private function define_public_hooks() {
        // Assets are only enqueued when a JetReader shortcode is actually rendered.
        add_action( 'init', array( $this, 'register_shortcodes' ) );

        // CPT registration (must run on 'init').
        add_action( 'init', array( 'JetReader_CPT', 'register' ), 10 );

        // Flush rewrite rules once after plugin update.
        add_action( 'init', array( 'JetReader_CPT', 'flush_once' ), 99 );

        // Run DB schema migrations only in admin context and only when the plugin version changes.
        // Keeping migrations out of frontend requests prevents schema ALTERs from being triggered
        // by anonymous visitors, which could cause table locks on high-traffic sites.
        add_action( 'admin_init', array( $this, 'maybe_run_migrations' ) );

        add_filter( 'script_loader_tag', array( $this, 'add_module_type' ), 10, 3 );

        // Inject palette CSS via wp_enqueue_scripts (uses wp_add_inline_style).
        add_action( 'wp_enqueue_scripts', array( 'JetReader_Color_Engine', 'inject_colors' ), 20 );

    }

    /**
     * Run DB schema migrations. Hooked to admin_init so they never fire during
     * frontend page loads. Version-gated to avoid running on every admin request.
     */
    public function maybe_run_migrations(): void {
        if ( get_option( 'jetreader_db_version' ) === JETREADER_VERSION ) {
            return;
        }
        JetReader_Database::maybe_add_volumes_column();
        JetReader_Database::maybe_add_translator_column();
        JetReader_Database::maybe_add_categories_type_column();
        JetReader_Database::maybe_fix_categories_unique_key();
        JetReader_Database::maybe_add_categories_name_index();
        JetReader_Database::maybe_add_authors_table();
        JetReader_Database::maybe_add_publishers_table();
        update_option( 'jetreader_db_version', JETREADER_VERSION );
    }

    /**
     * Register REST API endpoints.
     */
    private function define_rest_api_hooks() {
        $rest_api = new JetReader_REST_API();
        add_action( 'rest_api_init', array( $rest_api, 'register_routes' ) );
    }

    private function define_gutenberg_hooks() {
        if ( class_exists( 'JetReader_Gutenberg_Blocks' ) ) {
            add_action( 'init', array( 'JetReader_Gutenberg_Blocks', 'register' ), 20 );
            add_action( 'enqueue_block_editor_assets', array( 'JetReader_Gutenberg_Blocks', 'enqueue_block_editor_assets' ) );
        }
    }

    /**
     * Add type="module" to JetReader entry point script tags.
     *
     * Vite produces ESM bundles. Entry files must be loaded as modules so
     * the browser executes them correctly. Chunk files are NOT enqueued
     * separately — they are fetched automatically by the browser's module
     * loader when the entry file imports them.
     *
     * @param string $tag    The <script> tag HTML.
     * @param string $handle The registered script handle.
     * @param string $src    The script source URL.
     * @return string Modified <script> tag.
     */
    public function add_module_type( $tag, $handle, $src ) {
        $module_handles = array(
            'jetreader-admin',
            'jetreader-frontend',
            'jetreader-blocks',
            'jetreader-reader',
        );

        if ( ! in_array( $handle, $module_handles, true ) ) {
            return $tag;
        }

        return str_replace( '<script ', '<script type="module" ', $tag );
    }

    /**
     * Add admin menu pages.
     */
    public function add_admin_menu() {
        $settings        = get_option( 'jetreader_settings', array() );
        $plugin_language = isset( $settings['plugin_language'] ) ? $settings['plugin_language'] : 'en';
        $trans           = jetreader_get_translations( $plugin_language );

        $tb = function ( $key ) use ( $trans ) {
            return isset( $trans['php_backend'][ $key ] ) ? $trans['php_backend'][ $key ] : $key;
        };

        add_menu_page(
            $tb( 'menuMain' ),
            $tb( 'menuMain' ),
            'manage_options',
            'jetreader',
            array( $this, 'render_admin_app' ),
            'dashicons-book-alt',
            30
        );

        add_submenu_page(
            'jetreader',
            $tb( 'menuDashboard' ),
            $tb( 'menuDashboard' ),
            'manage_options',
            'jetreader',
            array( $this, 'render_admin_app' )
        );

        add_submenu_page(
            'jetreader',
            $tb( 'menuLibraryItems' ),
            $tb( 'menuLibraryItems' ),
            'manage_options',
            'jetreader-items',
            array( $this, 'render_admin_app' )
        );

        add_submenu_page(
            'jetreader',
            $tb( 'menuConstants' ),
            $tb( 'menuConstants' ),
            'manage_options',
            'jetreader-constants',
            array( $this, 'render_admin_app' )
        );

        add_submenu_page(
            'jetreader',
            $tb( 'menuSettings' ),
            $tb( 'menuSettings' ),
            'manage_options',
            'jetreader-settings',
            array( $this, 'render_admin_app' )
        );


        add_submenu_page(
            'jetreader',
            $tb( 'menuAbout' ),
            $tb( 'menuAbout' ),
            'manage_options',
            'jetreader-about',
            array( $this, 'render_admin_app' )
        );


    }

    /**
     * Render the React admin application container.
     */
    public function render_admin_app() {
        echo '<div id="jetreader-admin-app"></div>';
    }

    /**
     * Enqueue admin area scripts and styles.
     */
    public function enqueue_admin_assets( $hook ) {
        if ( strpos( $hook, 'jetreader' ) === false ) {
            return;
        }

        wp_enqueue_media();
        $this->enqueue_built_assets( 'admin' );
    }

    /**
     * Enqueue public-facing scripts and styles.
     */
    public function enqueue_public_assets() {
        $this->enqueue_built_assets( 'frontend' );
    }

    /**
     * Enqueue production-built assets from /dist/ folder.
     *
     * Only the CSS and the entry-point JS are enqueued here. Chunk files
     * (e.g. proxy.chunk.js) are resolved and fetched automatically by the
     * browser's ESM module loader when the entry file imports them. Enqueuing
     * them separately as plain <script> tags would cause a SyntaxError because
     * they contain ESM import/export statements.
     *
     * @param string $entry 'admin' or 'frontend'.
     */
    private function enqueue_built_assets( $entry ) {
        $dist_dir = JETREADER_PLUGIN_DIR . 'dist/';
        $dist_url = JETREADER_PLUGIN_URL . 'dist/';

        // CSS — safe to enqueue normally (no ESM concerns).
        // Enqueue ALL CSS files found in the dist/css/ directory.
        $css_dir = $dist_dir . 'css/';
        if ( is_dir( $css_dir ) ) {
            // Cache the sorted file list — glob+sort is unnecessary on every page load.
            $css_cache_key = 'jetreader_css_list_' . JETREADER_VERSION;
            $css_files     = get_transient( $css_cache_key );
            if ( is_array( $css_files ) ) {
                foreach ( $css_files as $css_file ) {
                    if ( ! file_exists( $css_file ) ) {
                        $css_files = false;
                        break;
                    }
                }
            }
            if ( false === $css_files ) {
                // Priority: main.css should likely come last to override anything else.
                $css_files = glob( $css_dir . '*.css' );
                if ( is_array( $css_files ) ) {
                    usort( $css_files, function( $a, $b ) {
                        if ( str_contains( $a, 'main.css' ) ) return 1;
                        if ( str_contains( $b, 'main.css' ) ) return -1;
                        return strcmp( $a, $b );
                    } );
                }
                set_transient( $css_cache_key, $css_files, DAY_IN_SECONDS );
            }

            $is_debug = ( defined( 'WP_DEBUG' ) && WP_DEBUG ) || ( defined( 'SCRIPT_DEBUG' ) && SCRIPT_DEBUG );
            if ( is_array( $css_files ) ) {
                foreach ( $css_files as $css_file ) {
                    $css_name = basename( $css_file, '.css' );
                    wp_enqueue_style(
                        'jetreader-' . $css_name,
                        $dist_url . 'css/' . $css_name . '.css',
                        array(),
                        $is_debug ? filemtime( $css_file ) : JETREADER_VERSION
                    );
                }
            }
        }
 
        // Entry JS — loaded as type="module" via add_module_type filter.
        // Chunks imported by this file are fetched by the browser automatically.
        $entry_file = $dist_dir . 'js/' . $entry . '.js';
        if ( file_exists( $entry_file ) ) {
            $is_debug = ( defined( 'WP_DEBUG' ) && WP_DEBUG ) || ( defined( 'SCRIPT_DEBUG' ) && SCRIPT_DEBUG );
            wp_enqueue_script(
                'jetreader-' . $entry,
                $dist_url . 'js/' . $entry . '.js',
                array(),
                $is_debug ? filemtime( $entry_file ) : JETREADER_VERSION,
                true
            );

            $settings        = get_option( 'jetreader_settings', array() );
            $plugin_language = isset( $settings['plugin_language'] ) ? $settings['plugin_language'] : 'en';

            wp_localize_script(
                'jetreader-' . $entry,
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
                    'systemInfo'         => array(
                        'pluginVersion' => JETREADER_VERSION,
                        'wpVersion'     => get_bloginfo( 'version' ),
                        'phpVersion'    => PHP_VERSION,
                        'elementor'     => defined( 'ELEMENTOR_VERSION' ) ? ELEMENTOR_VERSION : false,
                    ),
                )
            );
        }
    }

    /**
     * Register shortcodes.
     */
    public function register_shortcodes() {
        add_shortcode( 'jetreader_library', array( $this, 'shortcode_library' ) );
    }

    /**
     * Enqueue frontend assets once (idempotent).
     *
     * Never loads in admin context (Elementor editor, WP admin) — only on
     * public-facing pages where the shortcode is actually displayed.
     */
    private function maybe_enqueue_frontend_assets() {
        if ( is_admin() ) {
            return;
        }
        if ( ! wp_script_is( 'jetreader-frontend', 'enqueued' ) ) {
            $this->enqueue_built_assets( 'frontend' );
        }
    }

    /**
     * Shortcode: [jetreader_library type="book" types="book,magazine"]
     *
     * type=""           → show all 4 type tabs (default)
     * type="book"       → force single type, hide tabs, show filtered list
     * types="book,magazine" → show only the specified type tabs (2+ values)
     */
    public function shortcode_library( $atts ) {
        $atts = shortcode_atts(
            array(
                'type'   => '',      // single forced type — hides tab bar
                'types'  => '',      // comma-separated list — shows only those tabs
            ),
            $atts,
            'jetreader_library'
        );

        // Sanitize types list — only allow valid type slugs.
        $valid_types = array( 'book', 'article', 'magazine', 'qa' );
        $types_clean = '';
        if ( ! empty( $atts['types'] ) ) {
            $types_arr = array_values( array_filter(
                array_map( 'trim', explode( ',', sanitize_text_field( $atts['types'] ) ) ),
                function ( $t ) use ( $valid_types ) {
                    return in_array( $t, $valid_types, true );
                }
            ) );
            $types_clean = implode( ',', $types_arr );
        }

        $this->maybe_enqueue_frontend_assets();

        $html = sprintf(
            '<div id="jetreader-frontend-app" class="jetreader-wrap alignwide" data-library-type="%s" data-library-types="%s"></div>',
            esc_attr( $atts['type'] ),
            esc_attr( $types_clean )
        );

        $allowed_html = array(
            'div' => array(
                'id'                 => true,
                'class'              => true,
                'data-library-type'  => true,
                'data-library-types' => true,
            ),
        );

        return wp_kses( $html, $allowed_html );
    }


    /**
     * Run the plugin.
     */
    public function run() {
        // Plugin is now initialized.
        do_action( 'jetreader_loaded' );
    }

    /**
     * The name of the plugin used to uniquely identify it within the context of
     * WordPress and to define internationalization functionality.
     *
     * @return string The name of the plugin.
     */
    public function get_plugin_name() {
        return $this->plugin_name;
    }

    /**
     * Retrieve the version number of the plugin.
     *
     * @return string The version number of the plugin.
     */
    public function get_version() {
        return $this->version;
    }
}