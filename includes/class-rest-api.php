<?php
/**
 * REST API handler class.
 *
 * @package JetReader
 */

// If this file is called directly, abort.
if ( ! defined( 'WPINC' ) ) {
    die;
}

/**
 * Class JetReader_REST_API
 *
 * Handles all REST API endpoint registrations and callbacks.
 */
// phpcs:disable WordPress.DB.DirectDatabaseQuery,WordPress.DB.PreparedSQL.InterpolatedNotPrepared,WordPress.DB.PreparedSQLPlaceholders.UnfinishedPrepare
class JetReader_REST_API {

    /**
     * API namespace.
     *
     * @var string
     */
    private $namespace = 'jetreader/v1';

    /**
     * Runtime cache: item_id (int) → CPT permalink (string).
     * Populated on first call to get_full_permalink_map() within a request.
     *
     * @var array<int,string>|null
     */
    private static $permalink_map_cache = null;

    /**
     * Register all REST API routes.
     */
    public function register_routes() {
        // Items.
        // Public endpoint: unauthenticated users can only read published items.
        // Draft/private visibility is enforced server-side in get_items() via
        // current_user_can('manage_options') — see the visibility WHERE clause below.
        register_rest_route(
            $this->namespace,
            '/items',
            array(
                'methods'             => WP_REST_Server::READABLE,
                'callback'            => array( $this, 'get_items' ),
                'permission_callback' => function( $request ) {
                    $visibility = $request->get_param( 'visibility' );
                    if ( ! empty( $visibility ) && 'publish' !== $visibility ) {
                        return current_user_can( 'manage_options' );
                    }
                    if ( $request->get_param( 'file_type' ) || $request->get_param( 'view_min' ) || $request->get_param( 'view_max' ) || $request->get_param( 'has_volumes' ) ) {
                        return current_user_can( 'manage_options' );
                    }
                    return true;
                },
                'args'                => $this->get_items_args(),
            )
        );

        register_rest_route(
            $this->namespace,
            '/items',
            array(
                'methods'             => WP_REST_Server::CREATABLE,
                'callback'            => array( $this, 'create_item' ),
                'permission_callback' => array( $this, 'check_admin_permission' ),
            )
        );

        register_rest_route(
            $this->namespace,
            '/search',
            array(
                'methods'             => WP_REST_Server::READABLE,
                'callback'            => array( $this, 'search_items' ),
                'permission_callback' => array( $this, 'check_admin_permission' ),
                'args'                => array(
                    'q' => array(
                        'required'          => true,
                        'sanitize_callback' => 'sanitize_text_field',
                    ),
                ),
            )
        );

        register_rest_route(
            $this->namespace,
            '/items/(?P<id>\d+)',
            array(
                'methods'             => WP_REST_Server::READABLE,
                'callback'            => array( $this, 'get_item' ),
                'permission_callback' => function( $request ) {
                    $item_id = intval( $request['id'] );
                    global $wpdb;
                    $visibility = $wpdb->get_var( $wpdb->prepare( "SELECT visibility FROM {$wpdb->prefix}jetreader_items WHERE id = %d", $item_id ) );
                    if ( 'publish' === $visibility ) {
                        return true;
                    }
                    return current_user_can( 'manage_options' );
                },
                'args'                => array(
                    'id' => array(
                        'required'          => true,
                        'validate_callback' => function( $param ) {
                            return is_numeric( $param );
                        },
                    ),
                ),
            )
        );

        register_rest_route(
            $this->namespace,
            '/items/bulk',
            array(
                'methods'             => WP_REST_Server::EDITABLE,
                'callback'            => array( $this, 'bulk_update_items' ),
                'permission_callback' => array( $this, 'check_admin_permission' ),
            )
        );

        register_rest_route(
            $this->namespace,
            '/items/(?P<id>\d+)',
            array(
                'methods'             => WP_REST_Server::EDITABLE,
                'callback'            => array( $this, 'update_item' ),
                'permission_callback' => array( $this, 'check_admin_permission' ),
            )
        );

        register_rest_route(
            $this->namespace,
            '/items/bulk-delete',
            array(
                'methods'             => WP_REST_Server::CREATABLE,
                'callback'            => array( $this, 'bulk_delete_items' ),
                'permission_callback' => array( $this, 'check_admin_permission' ),
            )
        );

        register_rest_route(
            $this->namespace,
            '/items/(?P<id>\d+)',
            array(
                'methods'             => WP_REST_Server::DELETABLE,
                'callback'            => array( $this, 'delete_item' ),
                'permission_callback' => array( $this, 'check_admin_permission' ),
            )
        );

        // Stat tracking — fire-and-forget from frontend (view / read counters).
        register_rest_route(
            $this->namespace,
            '/items/(?P<id>\d+)/view',
            array(
                'methods'             => WP_REST_Server::CREATABLE,
                'callback'            => array( $this, 'track_view' ),
                'permission_callback' => '__return_true',
                'args'                => array(
                    'id' => array(
                        'required'          => true,
                        'validate_callback' => function( $param ) {
                            return is_numeric( $param );
                        },
                    ),
                ),
            )
        );

        register_rest_route(
            $this->namespace,
            '/items/(?P<id>\d+)/read',
            array(
                'methods'             => WP_REST_Server::CREATABLE,
                'callback'            => array( $this, 'track_read' ),
                'permission_callback' => '__return_true',
                'args'                => array(
                    'id' => array(
                        'required'          => true,
                        'validate_callback' => function( $param ) {
                            return is_numeric( $param );
                        },
                    ),
                ),
            )
        );

        // Chapters.
        register_rest_route(
            $this->namespace,
            '/items/(?P<item_id>\d+)/chapters',
            array(
                'methods'             => WP_REST_Server::READABLE,
                'callback'            => array( $this, 'get_chapters' ),
                'permission_callback' => function( $request ) {
                    $item_id = intval( $request['item_id'] );
                    global $wpdb;
                    $visibility = $wpdb->get_var( $wpdb->prepare( "SELECT visibility FROM {$wpdb->prefix}jetreader_items WHERE id = %d", $item_id ) );
                    if ( 'publish' === $visibility ) {
                        return true;
                    }
                    return current_user_can( 'manage_options' );
                },
            )
        );

        // Upload.
        register_rest_route(
            $this->namespace,
            '/upload',
            array(
                'methods'             => WP_REST_Server::CREATABLE,
                'callback'            => array( $this, 'upload_file' ),
                'permission_callback' => array( $this, 'check_admin_permission' ),
            )
        );

        // Categories.
        register_rest_route(
            $this->namespace,
            '/categories',
            array(
                'methods'             => WP_REST_Server::READABLE,
                'callback'            => array( $this, 'get_categories' ),
                'permission_callback' => '__return_true',
                'args'                => array(
                    'type' => array(
                        'sanitize_callback' => 'sanitize_text_field',
                    ),
                ),
            )
        );

        register_rest_route(
            $this->namespace,
            '/categories',
            array(
                'methods'             => WP_REST_Server::CREATABLE,
                'callback'            => array( $this, 'create_category' ),
                'permission_callback' => array( $this, 'check_admin_permission' ),
            )
        );

        register_rest_route(
            $this->namespace,
            '/categories/(?P<id>\d+)',
            array(
                'methods'             => WP_REST_Server::EDITABLE,
                'callback'            => array( $this, 'update_category' ),
                'permission_callback' => array( $this, 'check_admin_permission' ),
            )
        );

        register_rest_route(
            $this->namespace,
            '/categories/(?P<id>\d+)',
            array(
                'methods'             => WP_REST_Server::DELETABLE,
                'callback'            => array( $this, 'delete_category' ),
                'permission_callback' => array( $this, 'check_admin_permission' ),
            )
        );

        // Tags.
        register_rest_route(
            $this->namespace,
            '/tags',
            array(
                'methods'             => WP_REST_Server::READABLE,
                'callback'            => array( $this, 'get_tags' ),
                'permission_callback' => '__return_true',
            )
        );

        // Settings.
        register_rest_route(
            $this->namespace,
            '/settings',
            array(
                'methods'             => WP_REST_Server::READABLE,
                'callback'            => array( $this, 'get_settings' ),
                'permission_callback' => array( $this, 'check_admin_permission' ),
            )
        );

        register_rest_route(
            $this->namespace,
            '/settings',
            array(
                'methods'             => WP_REST_Server::EDITABLE,
                'callback'            => array( $this, 'update_settings' ),
                'permission_callback' => array( $this, 'check_admin_permission' ),
            )
        );


        register_rest_route(
            $this->namespace,
            '/files',
            array(
                array(
                    'methods'             => WP_REST_Server::READABLE,
                    'callback'            => array( $this, 'get_files' ),
                    'permission_callback' => array( $this, 'check_admin_permission' ),
                ),
                array(
                    'methods'             => WP_REST_Server::DELETABLE,
                    'callback'            => array( $this, 'delete_files' ),
                    'permission_callback' => array( $this, 'check_admin_permission' ),
                )
            )
        );

        register_rest_route(
            $this->namespace,
            '/files/rename',
            array(
                'methods'             => WP_REST_Server::EDITABLE,
                'callback'            => array( $this, 'rename_file' ),
                'permission_callback' => array( $this, 'check_admin_permission' ),
            )
        );

        register_rest_route(
            $this->namespace,
            '/files/clean-unused',
            array(
                'methods'             => WP_REST_Server::CREATABLE,
                'callback'            => array( $this, 'clean_unused_files' ),
                'permission_callback' => array( $this, 'check_admin_permission' ),
            )
        );

        // Dashboard stats.
        register_rest_route(
            $this->namespace,
            '/dashboard',
            array(
                'methods'             => WP_REST_Server::READABLE,
                'callback'            => array( $this, 'get_dashboard_stats' ),
                'permission_callback' => array( $this, 'check_admin_permission' ),
                'args'                => array(
                    'force' => array(
                        'required'          => false,
                        'sanitize_callback' => 'sanitize_text_field',
                    ),
                ),
            )
        );


        // Authors — managed list (CRUD).
        register_rest_route(
            $this->namespace,
            '/authors',
            array(
                'methods'             => WP_REST_Server::READABLE,
                'callback'            => array( $this, 'get_authors' ),
                'permission_callback' => '__return_true',
            )
        );

        register_rest_route(
            $this->namespace,
            '/authors',
            array(
                'methods'             => WP_REST_Server::CREATABLE,
                'callback'            => array( $this, 'create_author' ),
                'permission_callback' => array( $this, 'check_admin_permission' ),
            )
        );

        register_rest_route(
            $this->namespace,
            '/authors/(?P<id>\d+)',
            array(
                'methods'             => WP_REST_Server::EDITABLE,
                'callback'            => array( $this, 'update_author' ),
                'permission_callback' => array( $this, 'check_admin_permission' ),
            )
        );

        register_rest_route(
            $this->namespace,
            '/authors/(?P<id>\d+)',
            array(
                'methods'             => WP_REST_Server::DELETABLE,
                'callback'            => array( $this, 'delete_author' ),
                'permission_callback' => array( $this, 'check_admin_permission' ),
            )
        );

        // Publishers — managed list (CRUD).
        register_rest_route(
            $this->namespace,
            '/publishers',
            array(
                'methods'             => WP_REST_Server::READABLE,
                'callback'            => array( $this, 'get_publishers' ),
                'permission_callback' => '__return_true',
            )
        );

        register_rest_route(
            $this->namespace,
            '/publishers',
            array(
                'methods'             => WP_REST_Server::CREATABLE,
                'callback'            => array( $this, 'create_publisher' ),
                'permission_callback' => array( $this, 'check_admin_permission' ),
            )
        );

        register_rest_route(
            $this->namespace,
            '/publishers/(?P<id>\d+)',
            array(
                'methods'             => WP_REST_Server::EDITABLE,
                'callback'            => array( $this, 'update_publisher' ),
                'permission_callback' => array( $this, 'check_admin_permission' ),
            )
        );

        register_rest_route(
            $this->namespace,
            '/publishers/(?P<id>\d+)',
            array(
                'methods'             => WP_REST_Server::DELETABLE,
                'callback'            => array( $this, 'delete_publisher' ),
                'permission_callback' => array( $this, 'check_admin_permission' ),
            )
        );

        // Admin: force-sync all items → CPT posts.
        register_rest_route(
            $this->namespace,
            '/cpt-sync',
            array(
                'methods'             => WP_REST_Server::CREATABLE,
                'callback'            => array( $this, 'cpt_sync_all' ),
                'permission_callback' => array( $this, 'check_admin_permission' ),
            )
        );

        // Public settings (for frontend reader to read annotation/copy toggles).
        register_rest_route(
            $this->namespace,
            '/public/settings',
            array(
                'methods'             => WP_REST_Server::READABLE,
                'callback'            => array( $this, 'get_public_settings' ),
                'permission_callback' => '__return_true',
            )
        );

        // Bookmarks.
        register_rest_route(
            $this->namespace,
            '/bookmarks',
            array(
                'methods'             => WP_REST_Server::READABLE,
                'callback'            => array( $this, 'get_bookmarks' ),
                'permission_callback' => array( $this, 'check_logged_in' ),
                'args'                => array(
                    'item_id' => array(
                        'sanitize_callback' => 'absint',
                    ),
                ),
            )
        );

        register_rest_route(
            $this->namespace,
            '/bookmarks',
            array(
                'methods'             => WP_REST_Server::CREATABLE,
                'callback'            => array( $this, 'create_bookmark' ),
                'permission_callback' => array( $this, 'check_logged_in' ),
            )
        );

        register_rest_route(
            $this->namespace,
            '/bookmarks/(?P<id>\d+)',
            array(
                'methods'             => WP_REST_Server::DELETABLE,
                'callback'            => array( $this, 'delete_bookmark' ),
                'permission_callback' => array( $this, 'check_logged_in' ),
            )
        );

        // Notes / Highlights.
        register_rest_route(
            $this->namespace,
            '/notes',
            array(
                'methods'             => WP_REST_Server::READABLE,
                'callback'            => array( $this, 'get_notes' ),
                'permission_callback' => array( $this, 'check_logged_in' ),
                'args'                => array(
                    'item_id' => array(
                        'sanitize_callback' => 'absint',
                    ),
                ),
            )
        );

        register_rest_route(
            $this->namespace,
            '/notes',
            array(
                'methods'             => WP_REST_Server::CREATABLE,
                'callback'            => array( $this, 'create_note' ),
                'permission_callback' => array( $this, 'check_logged_in' ),
            )
        );

        register_rest_route(
            $this->namespace,
            '/notes/(?P<id>\d+)',
            array(
                'methods'             => WP_REST_Server::DELETABLE,
                'callback'            => array( $this, 'delete_note' ),
                'permission_callback' => array( $this, 'check_logged_in' ),
            )
        );

        register_rest_route(
            $this->namespace,
            '/notes/(?P<id>\d+)',
            array(
                'methods'             => WP_REST_Server::EDITABLE,
                'callback'            => array( $this, 'update_note' ),
                'permission_callback' => array( $this, 'check_logged_in' ),
            )
        );

        register_rest_route(
            $this->namespace,
            '/proxy',
            array(
                'methods'             => WP_REST_Server::READABLE,
                'callback'            => array( $this, 'proxy_file' ),
                'permission_callback' => array( $this, 'proxy_permissions_check' ),
                'args'                => array(
                    'url' => array(
                        'required'          => true,
                        'sanitize_callback' => 'esc_url_raw',
                    ),
                ),
            )
        );

        // Bulk create items (admin — BulkAddModal).
        register_rest_route(
            $this->namespace,
            '/items/bulk-create',
            array(
                'methods'             => WP_REST_Server::CREATABLE,
                'callback'            => array( $this, 'bulk_create_items' ),
                'permission_callback' => array( $this, 'check_admin_permission' ),
            )
        );

        add_filter( 'rest_pre_serve_request', array( $this, 'serve_binary_proxy_response' ), 10, 4 );

    }

    /**
     * Get items collection.
     */
    public function get_items( $request ) {
        global $wpdb;

        $params = $request->get_params();

        $page     = isset( $params['page'] ) ? max( 1, intval( $params['page'] ) ) : 1;
        $per_page = isset( $params['per_page'] ) ? min( 100, max( 1, intval( $params['per_page'] ) ) ) : 20;
        $type     = isset( $params['type'] ) ? sanitize_text_field( $params['type'] ) : '';

        $offset   = ( $page - 1 ) * $per_page;

        $join  = '';
        $where = array( '1=1' );

        if ( ! empty( $type ) ) {
            $where[] = $wpdb->prepare( 'i.type = %s', $type );
        }

        if ( ! empty( $params['author'] ) ) {
            $where[] = $wpdb->prepare( 'i.author LIKE %s', '%' . $wpdb->esc_like( sanitize_text_field( $params['author'] ) ) . '%' );
        }

        // Multi-author IN filter — comma-separated exact names from frontend multi-select.
        if ( ! empty( $params['author_names'] ) ) {
            $raw_names  = explode( ',', sanitize_text_field( $params['author_names'] ) );
            $safe_names = array_values( array_filter( array_map( 'trim', $raw_names ) ) );
            if ( ! empty( $safe_names ) ) {
                $placeholders = implode( ', ', array_fill( 0, count( $safe_names ), '%s' ) );
                // phpcs:ignore WordPress.DB.PreparedSQL.NotPrepared,WordPress.DB.PreparedSQL.InterpolatedNotPrepared,WordPress.DB.PreparedSQLPlaceholders.UnfinishedPrepare
                $where[] = $wpdb->prepare( "i.author IN ({$placeholders})", $safe_names );
            }
        }

        if ( ! empty( $params['publisher'] ) ) {
            $where[] = $wpdb->prepare( 'i.publisher LIKE %s', '%' . $wpdb->esc_like( sanitize_text_field( $params['publisher'] ) ) . '%' );
        }

        // Multi-publisher IN filter — comma-separated exact names from frontend multi-select.
        if ( ! empty( $params['publisher_names'] ) ) {
            $raw_names  = explode( ',', sanitize_text_field( $params['publisher_names'] ) );
            $safe_names = array_values( array_filter( array_map( 'trim', $raw_names ) ) );
            if ( ! empty( $safe_names ) ) {
                $placeholders = implode( ', ', array_fill( 0, count( $safe_names ), '%s' ) );
                // phpcs:ignore WordPress.DB.PreparedSQL.NotPrepared,WordPress.DB.PreparedSQL.InterpolatedNotPrepared,WordPress.DB.PreparedSQLPlaceholders.UnfinishedPrepare
                $where[] = $wpdb->prepare( "i.publisher IN ({$placeholders})", $safe_names );
            }
        }

        if ( ! empty( $params['translator'] ) ) {
            $where[] = $wpdb->prepare( 'i.translator LIKE %s', '%' . $wpdb->esc_like( sanitize_text_field( $params['translator'] ) ) . '%' );
        }

        if ( ! empty( $params['language'] ) ) {
            $where[] = $wpdb->prepare( 'i.language = %s', sanitize_text_field( $params['language'] ) );
        }

        if ( isset( $params['featured'] ) && '' !== (string) $params['featured'] ) {
            $where[] = $wpdb->prepare( 'i.featured = %d', absint( $params['featured'] ) );
        }

        if ( ! empty( $params['year_from'] ) ) {
            $where[] = $wpdb->prepare( 'i.publication_year >= %d', intval( $params['year_from'] ) );
        }

        if ( ! empty( $params['year_to'] ) ) {
            $where[] = $wpdb->prepare( 'i.publication_year <= %d', intval( $params['year_to'] ) );
        }

        if ( ! empty( $params['category_id'] ) ) {
            $cat_id = intval( $params['category_id'] );
            $join   = " INNER JOIN {$wpdb->prefix}jetreader_item_categories ic ON i.id = ic.item_id AND ic.category_id = {$cat_id}";
        }

        // Multi-category OR filter — comma-separated list from frontend multi-select.
        if ( ! empty( $params['category_ids'] ) && empty( $params['category_id'] ) ) {
            $raw_cat_ids  = explode( ',', sanitize_text_field( $params['category_ids'] ) );
            $safe_cat_ids = array_values( array_filter( array_map( 'intval', $raw_cat_ids ) ) );
            if ( ! empty( $safe_cat_ids ) ) {
                $cat_placeholders = implode( ',', $safe_cat_ids ); // intval-safe; no user data
                // phpcs:ignore WordPress.DB.PreparedSQL.NotPrepared,WordPress.DB.PreparedSQL.InterpolatedNotPrepared
                $where[] = "i.id IN (SELECT DISTINCT item_id FROM {$wpdb->prefix}jetreader_item_categories WHERE category_id IN ({$cat_placeholders}))";
            }
        }

        // File type filter (admin).
        if ( ! empty( $params['file_type'] ) ) {
            $where[] = $wpdb->prepare( 'i.file_type = %s', sanitize_text_field( $params['file_type'] ) );
        }

        // View count range (admin).
        if ( ! empty( $params['view_min'] ) ) {
            $where[] = $wpdb->prepare( 'i.view_count >= %d', intval( $params['view_min'] ) );
        }
        if ( ! empty( $params['view_max'] ) ) {
            $where[] = $wpdb->prepare( 'i.view_count <= %d', intval( $params['view_max'] ) );
        }

        // Multi-volume filter (admin).
        if ( ! empty( $params['has_volumes'] ) ) {
            $where[] = "i.volumes IS NOT NULL AND i.volumes != '' AND JSON_LENGTH(i.volumes) > 1";
        }

        // Search filter (searches items by title for visitor library).
        if ( ! empty( $params['search'] ) ) {
            $where[] = $wpdb->prepare( 'i.title LIKE %s', '%' . $wpdb->esc_like( sanitize_text_field( $params['search'] ) ) . '%' );
        }

        // Visibility: admins see all by default; public only sees published.
        $is_admin = current_user_can( 'manage_options' );
        $allowed_vis = array( 'publish', 'draft', 'private' );
        if ( $is_admin ) {
            if ( ! empty( $params['visibility'] ) && in_array( $params['visibility'], $allowed_vis, true ) ) {
                $where[] = $wpdb->prepare( 'i.visibility = %s', sanitize_text_field( $params['visibility'] ) );
            }
            // No filter → admin sees all visibilities.
        } else {
            $where[] = $wpdb->prepare( 'i.visibility = %s', 'publish' );
        }

        // Handpicked: restrict to specific IDs.
        $include_ids = array();
        if ( ! empty( $params['include_ids'] ) ) {
            $raw_ids = explode( ',', sanitize_text_field( $params['include_ids'] ) );
            foreach ( $raw_ids as $raw_id ) {
                $int_id = intval( trim( $raw_id ) );
                if ( $int_id > 0 ) {
                    $include_ids[] = $int_id;
                }
            }
            if ( ! empty( $include_ids ) ) {
                $placeholders = implode( ',', array_fill( 0, count( $include_ids ), '%d' ) );
                // phpcs:ignore WordPress.DB.PreparedSQLPlaceholders.UnfinishedPrepare,WordPress.DB.PreparedSQL.InterpolatedNotPrepared
                $where[] = $wpdb->prepare( "i.id IN ($placeholders)", ...$include_ids );
            }
        }

        // ORDER BY.
        $allowed_order = array(
            'newest'   => 'i.created_at DESC',
            'oldest'   => 'i.created_at ASC',
            'views'    => 'i.view_count DESC',
            'featured' => 'i.featured DESC, i.created_at DESC',
            'title'    => 'i.title ASC',
        );
        $orderby_raw = isset( $params['orderby'] ) ? sanitize_text_field( $params['orderby'] ) : 'newest';
        $order_sql   = isset( $allowed_order[ $orderby_raw ] ) ? $allowed_order[ $orderby_raw ] : 'i.created_at DESC';

        // If handpicked, preserve order of requested IDs via FIELD().
        if ( ! empty( $include_ids ) ) {
            $field_ids = implode( ',', $include_ids );
            // phpcs:ignore WordPress.DB.PreparedSQL.InterpolatedNotPrepared
            $order_sql = "FIELD(i.id, $field_ids)";
        }

        $where_clause = implode( ' AND ', $where );

        // phpcs:disable PluginCheck.Security.DirectDB.UnescapedDBParameter -- where_clause and order_sql are validated above.
        $total = $wpdb->get_var(
            "SELECT COUNT(*) FROM {$wpdb->prefix}jetreader_items i{$join} WHERE {$where_clause}"
        );

        $items = $wpdb->get_results(
            $wpdb->prepare(
                "SELECT i.* FROM {$wpdb->prefix}jetreader_items i{$join}
                WHERE {$where_clause}
                ORDER BY {$order_sql}
                LIMIT %d OFFSET %d",
                $per_page,
                $offset
            )
        );
        // phpcs:enable PluginCheck.Security.DirectDB.UnescapedDBParameter

        // Field filtering: strip unrequested fields for performance.
        $fields_param   = isset( $params['fields'] ) ? sanitize_text_field( $params['fields'] ) : '';
        $allowed_fields = array( 'id', 'type', 'title', 'slug', 'description', 'cover_image', 'file_path', 'file_type', 'language', 'author', 'translator', 'publisher', 'isbn', 'publication_year', 'reading_time', 'page_count', 'visibility', 'featured', 'view_count', 'read_count', 'volumes', 'category_ids', 'cpt_url', 'created_at', 'updated_at' );
        $requested_fields = array();
        if ( ! empty( $fields_param ) ) {
            foreach ( explode( ',', $fields_param ) as $f ) {
                $f = trim( $f );
                if ( in_array( $f, $allowed_fields, true ) ) {
                    $requested_fields[] = $f;
                }
            }
        }

        // Batch-fetch category IDs and CPT permalinks for all items in two queries
        // instead of 2×N individual queries (N+1 elimination).
        $cat_map       = array();
        $permalink_map = array();

        if ( ! empty( $items ) ) {
            // Safe integer list — all values come from intval() on DB primary keys. Escaped with esc_sql to satisfy PluginCheck.
            $id_list     = esc_sql( implode( ',', array_map( 'intval', wp_list_pluck( $items, 'id' ) ) ) );

            // One query for all category associations. Query kept on a single line immediately following phpcs:ignore to ensure suppression is parsed correctly.
            // phpcs:ignore WordPress.DB.DirectDatabaseQuery.NoCaching,WordPress.DB.PreparedSQL.InterpolatedNotPrepared,PluginCheck.Security.DirectDB.UnescapedDBParameter
            $cat_rows = $wpdb->get_results( "SELECT item_id, category_id FROM {$wpdb->prefix}jetreader_item_categories WHERE item_id IN ({$id_list})" );
            foreach ( $cat_rows as $row ) {
                $cat_map[ intval( $row->item_id ) ][] = intval( $row->category_id );
            }

            // Use transient-cached permalink map — eliminates a repeated JOIN on
            // wp_postmeta on every /items request. The cache is built once and
            // invalidated automatically on item create / update / delete.
            if ( class_exists( 'JetReader_CPT' ) ) {
                $full_map = $this->get_full_permalink_map();
                foreach ( $items as $item ) {
                    $id = intval( $item->id );
                    if ( isset( $full_map[ $id ] ) ) {
                        $permalink_map[ $id ] = $full_map[ $id ];
                    }
                }
            }
        }

        $formatted = array_map(
            function( $item ) use ( $cat_map, $permalink_map ) {
                return $this->format_item( $item, $cat_map, $permalink_map );
            },
            $items
        );
        if ( ! empty( $requested_fields ) ) {
            $must_have = array( 'id' );
            $keep      = array_unique( array_merge( $must_have, $requested_fields ) );
            $formatted = array_map(
                function( $item ) use ( $keep ) {
                    return array_intersect_key( $item, array_flip( $keep ) );
                },
                $formatted
            );
        }

        $all_ids = array();
        if ( isset( $params['include_all_ids'] ) && '1' === (string) $params['include_all_ids'] ) {
            // phpcs:disable PluginCheck.Security.DirectDB.UnescapedDBParameter
            $all_ids = array_map( 'intval', $wpdb->get_col(
                "SELECT i.id FROM {$wpdb->prefix}jetreader_items i{$join} WHERE {$where_clause} ORDER BY {$order_sql} LIMIT 50000"
            ) );
            // phpcs:enable PluginCheck.Security.DirectDB.UnescapedDBParameter
        }

        return rest_ensure_response(
            array(
                'items'    => $formatted,
                'total'    => intval( $total ),
                'page'     => $page,
                'per_page' => $per_page,
                'pages'    => ceil( $total / $per_page ),
                'all_ids'  => $all_ids,
            )
        );
    }

    /**
     * Search library items (admin).
     */
    public function search_items( $request ) {
        global $wpdb;

        $q = sanitize_text_field( $request->get_param( 'q' ) ?? '' );
        if ( '' === trim( $q ) ) {
            return rest_ensure_response( array( 'items' => array(), 'total' => 0 ) );
        }

        $like = '%' . $wpdb->esc_like( $q ) . '%';
        
        $where_clause = $wpdb->prepare(
            "(i.title LIKE %s)",
            $like
        );

        // phpcs:ignore WordPress.DB.DirectDatabaseQuery.NoCaching,WordPress.DB.PreparedSQL.InterpolatedNotPrepared
        $total = $wpdb->get_var( "SELECT COUNT(*) FROM {$wpdb->prefix}jetreader_items i WHERE {$where_clause}" );

        // phpcs:ignore WordPress.DB.DirectDatabaseQuery.NoCaching,WordPress.DB.PreparedSQL.InterpolatedNotPrepared
        $items = $wpdb->get_results( $wpdb->prepare( "SELECT i.* FROM {$wpdb->prefix}jetreader_items i WHERE {$where_clause} ORDER BY i.created_at DESC LIMIT %d OFFSET %d", 50, 0 ) );

        $cat_map       = array();
        $permalink_map = array();

        if ( ! empty( $items ) ) {
            // Escaped with esc_sql to satisfy PluginCheck.
            $id_list     = esc_sql( implode( ',', array_map( 'intval', wp_list_pluck( $items, 'id' ) ) ) );

            // phpcs:ignore WordPress.DB.DirectDatabaseQuery.NoCaching,WordPress.DB.PreparedSQL.InterpolatedNotPrepared,PluginCheck.Security.DirectDB.UnescapedDBParameter
            $cat_rows = $wpdb->get_results( "SELECT item_id, category_id FROM {$wpdb->prefix}jetreader_item_categories WHERE item_id IN ({$id_list})" );
            foreach ( $cat_rows as $row ) {
                $cat_map[ intval( $row->item_id ) ][] = intval( $row->category_id );
            }

            if ( class_exists( 'JetReader_CPT' ) ) {
                $full_map = $this->get_full_permalink_map();
                foreach ( $items as $item ) {
                    $id = intval( $item->id );
                    if ( isset( $full_map[ $id ] ) ) {
                        $permalink_map[ $id ] = $full_map[ $id ];
                    }
                }
            }
        }

        $formatted = array_map(
            function( $item ) use ( $cat_map, $permalink_map ) {
                return $this->format_item( $item, $cat_map, $permalink_map );
            },
            $items
        );

        return rest_ensure_response(
            array(
                'items' => $formatted,
                'total' => intval( $total ),
            )
        );
    }

    /**
     * Get single item.
     */
    public function get_item( $request ) {
        global $wpdb;

        $item_id = intval( $request['id'] );

        if ( ! $this->can_read_item( $item_id ) ) {
            return new WP_Error(
                'jetreader_not_found',
                __( 'Item not found.', 'jetreader' ),
                array( 'status' => 404 )
            );
        }

        $item = $wpdb->get_row(
            $wpdb->prepare(
                "SELECT * FROM {$wpdb->prefix}jetreader_items WHERE id = %d",
                $item_id
            )
        );

        if ( ! $item ) {
            return new WP_Error(
                'jetreader_not_found',
                __( 'Item not found.', 'jetreader' ),
                array( 'status' => 404 )
            );
        }

        // Increment view count only for published items.
        if ( 'publish' === $item->visibility ) {
            $wpdb->query(
                $wpdb->prepare(
                    "UPDATE {$wpdb->prefix}jetreader_items SET view_count = view_count + 1 WHERE id = %d",
                    $item_id
                )
            );
        }

        $p_map = class_exists( 'JetReader_CPT' ) ? $this->get_full_permalink_map() : array();
        return rest_ensure_response( $this->format_item( $item, array(), $p_map ) );
    }

    /**
     * Increment view_count for a published item.
     *
     * Called fire-and-forget (POST) from the frontend whenever the Info modal
     * opens. Uses a single atomic UPDATE so hundreds of concurrent requests
     * never deadlock — InnoDB row-level locking handles contention silently.
     */
    public function track_view( $request ) {
        global $wpdb;

        $item_id = intval( $request['id'] );

        // Transient-based rate limit: IP + Item ID + View
        $ip = isset( $_SERVER['REMOTE_ADDR'] ) ? sanitize_text_field( wp_unslash( $_SERVER['REMOTE_ADDR'] ) ) : '';
        if ( ! empty( $ip ) ) {
            $transient_key = 'jr_rate_limit_' . md5( $ip . '_' . $item_id . '_view' );
            if ( get_transient( $transient_key ) ) {
                return rest_ensure_response( array( 'ok' => true, 'rate_limited' => true ) );
            }
            set_transient( $transient_key, 1, 15 * MINUTE_IN_SECONDS );
        }

        // Atomic single-row UPDATE — no prior SELECT, no transaction needed.
        $wpdb->query(
            $wpdb->prepare(
                "UPDATE {$wpdb->prefix}jetreader_items
                 SET view_count = view_count + 1
                 WHERE id = %d AND visibility = 'publish'",
                $item_id
            )
        );

        return rest_ensure_response( array( 'ok' => true ) );
    }

    /**
     * Increment read_count for a published item.
     *
     * Called fire-and-forget (POST) from the frontend whenever the Reader
     * modal first mounts. Same atomic pattern as track_view.
     */
    public function track_read( $request ) {
        global $wpdb;

        $item_id = intval( $request['id'] );

        // Transient-based rate limit: IP + Item ID + Read
        $ip = isset( $_SERVER['REMOTE_ADDR'] ) ? sanitize_text_field( wp_unslash( $_SERVER['REMOTE_ADDR'] ) ) : '';
        if ( ! empty( $ip ) ) {
            $transient_key = 'jr_rate_limit_' . md5( $ip . '_' . $item_id . '_read' );
            if ( get_transient( $transient_key ) ) {
                return rest_ensure_response( array( 'ok' => true, 'rate_limited' => true ) );
            }
            set_transient( $transient_key, 1, 15 * MINUTE_IN_SECONDS );
        }

        $wpdb->query(
            $wpdb->prepare(
                "UPDATE {$wpdb->prefix}jetreader_items
                 SET read_count = read_count + 1
                 WHERE id = %d AND visibility = 'publish'",
                $item_id
            )
        );

        return rest_ensure_response( array( 'ok' => true ) );
    }

    /**
     * Create new item.
     */
    public function create_item( $request ) {
        global $wpdb;

        $params = $request->get_params();

        if ( empty( $params['title'] ) || '' === trim( $params['title'] ) ) {
            return new WP_Error(
                'jetreader_missing_title',
                __( 'Title is required.', 'jetreader' ),
                array( 'status' => 400 )
            );
        }

        $allowed_types = array( 'book', 'article', 'magazine', 'qa' );
        $type = sanitize_text_field( $params['type'] ?? 'book' );
        if ( ! in_array( $type, $allowed_types, true ) ) {
            $type = 'book';
        }

        $allowed_visibility = array( 'publish', 'draft', 'private' );
        $visibility = sanitize_text_field( $params['visibility'] ?? 'publish' );
        if ( ! in_array( $visibility, $allowed_visibility, true ) ) {
            $visibility = 'publish';
        }

        $slug = sanitize_title( $params['title'] );
        $existing = $wpdb->get_var( $wpdb->prepare(
            "SELECT id FROM {$wpdb->prefix}jetreader_items WHERE slug = %s",
            $slug
        ) );

        if ( $existing ) {
            $slug .= '-' . time();
        }

        // Ensure author / publisher records exist if provided as text strings.
        $author    = sanitize_text_field( $params['author'] ?? '' );
        $publisher = sanitize_text_field( $params['publisher'] ?? '' );
        if ( ! empty( $author ) ) {
            $author_names = array_filter( array_map( 'trim', explode( ',', $author ) ) );
            foreach ( $author_names as $auth_name ) {
                if ( '' !== $auth_name ) {
                    $this->import_ensure_author( $auth_name );
                }
            }
        }
        if ( ! empty( $publisher ) ) {
            $publisher_names = array_filter( array_map( 'trim', explode( ',', $publisher ) ) );
            foreach ( $publisher_names as $pub_name ) {
                if ( '' !== $pub_name ) {
                    $this->import_ensure_publisher( $pub_name );
                }
            }
        }

        $data = array(
            'type'             => $type,
            'title'            => sanitize_text_field( $params['title'] ),
            'slug'             => $slug,
            'description'      => wp_kses_post( $params['description'] ?? '' ),
            'cover_image'      => esc_url_raw( $params['cover_image'] ?? '' ),
            'file_path'        => sanitize_text_field( $params['file_path'] ?? '' ),
            'file_type'        => sanitize_text_field( $params['file_type'] ?? '' ),
            'language'         => sanitize_text_field( $params['language'] ?? 'en' ),
            'author'           => $author,
            'translator'       => sanitize_text_field( $params['translator'] ?? '' ),
            'publisher'        => $publisher,
            'isbn'             => sanitize_text_field( $params['isbn'] ?? '' ),
            'publication_year' => ! empty( $params['publication_year'] ) ? intval( $params['publication_year'] ) : null,
            'visibility'       => $visibility,
            'featured'         => ! empty( $params['featured'] ) ? 1 : 0,
            'page_count'       => ! empty( $params['page_count'] ) ? intval( $params['page_count'] ) : 0,
            'volumes'          => null,
        );

        if ( ! $this->validate_file_reference( $data['file_path'] ) ) {
            return new WP_Error( 'jetreader_invalid_file_path', __( 'Invalid file path/URL or domain not allowed.', 'jetreader' ), array( 'status' => 400 ) );
        }

        // Handle multi-volume/issue data (books and magazines).
        if ( ! empty( $params['volumes'] ) && is_array( $params['volumes'] ) ) {
            $clean_vols = array();
            foreach ( array_values( $params['volumes'] ) as $idx => $vol ) {
                if ( ! is_array( $vol ) ) continue;
                $vol_path = sanitize_text_field( $vol['file_path'] ?? '' );
                if ( ! $this->validate_file_reference( $vol_path ) ) {
                    return new WP_Error( 'jetreader_invalid_file_path', __( 'Invalid volume file path/URL or domain not allowed.', 'jetreader' ), array( 'status' => 400 ) );
                }

                // Auto detect encoding for volume if text file.
                $vol_type = sanitize_text_field( $vol['file_type'] ?? '' );
                $vol_encoding = isset( $vol['encoding'] ) ? sanitize_text_field( $vol['encoding'] ) : 'utf-8';
                if ( 'txt' === $vol_type && empty( $vol['encoding'] ) && ! empty( $vol_path ) ) {
                    $local_path = JetReader_Upload_Handler::url_to_local_path( $vol_path );
                    if ( file_exists( $local_path ) ) {
                        $content_sample = file_get_contents( $local_path, false, null, 0, 10000 );
                        if ( function_exists( 'mb_detect_encoding' ) && $content_sample ) {
                            $enc = mb_detect_encoding( $content_sample, array( 'UTF-8', 'ISO-8859-9', 'Windows-1254', 'Windows-1251', 'ISO-8859-1', 'ASCII', 'UTF-16', 'UTF-16LE', 'UTF-16BE', 'BIG5', 'GBK', 'EUC-JP', 'SJIS' ), true );
                            if ( $enc ) {
                                $vol_encoding = strtolower( $enc );
                            }
                        }
                    }
                }

                $clean_vols[] = array(
                    'vol'         => $idx + 1,
                    'file_path'   => $vol_path,
                    'file_type'   => $vol_type,
                    'cover_image' => esc_url_raw( $vol['cover_image'] ?? '' ),
                    'page_count'  => isset( $vol['page_count'] ) ? intval( $vol['page_count'] ) : 0,
                    'encoding'    => $vol_encoding,
                );
            }
            if ( ! empty( $clean_vols ) ) {
                $data['volumes']     = wp_json_encode( $clean_vols );
                $data['file_path']   = $clean_vols[0]['file_path'];
                $data['file_type']   = $clean_vols[0]['file_type'];
                $data['cover_image'] = $clean_vols[0]['cover_image'];
            }
        }

        // Detect encoding for single file TXT.
        $item_metadata = array();
        if ( ! empty( $data['file_path'] ) && 'txt' === $data['file_type'] ) {
            $local_path = JetReader_Upload_Handler::url_to_local_path( $data['file_path'] );
            if ( file_exists( $local_path ) ) {
                $content_sample = file_get_contents( $local_path, false, null, 0, 10000 );
                if ( function_exists( 'mb_detect_encoding' ) && $content_sample ) {
                    $enc = mb_detect_encoding( $content_sample, array( 'UTF-8', 'ISO-8859-9', 'Windows-1254', 'Windows-1251', 'ISO-8859-1', 'ASCII', 'UTF-16', 'UTF-16LE', 'UTF-16BE', 'BIG5', 'GBK', 'EUC-JP', 'SJIS' ), true );
                    if ( $enc ) {
                        $item_metadata['encoding'] = strtolower( $enc );
                    }
                }
            }
        }
        $data['metadata'] = ! empty( $item_metadata ) ? wp_json_encode( $item_metadata ) : null;

        // Build format array dynamically so NULL values are handled correctly
        // regardless of WordPress version behavior.
        $formats = array();
        foreach ( $data as $value ) {
            if ( is_null( $value ) ) {
                $formats[] = '%s';
            } elseif ( is_int( $value ) || is_bool( $value ) ) {
                $formats[] = '%d';
            } else {
                $formats[] = '%s';
            }
        }

        $result = $wpdb->insert( "{$wpdb->prefix}jetreader_items", $data, $formats );

        if ( false === $result ) {
            $db_error = $wpdb->last_error;
            // phpcs:ignore WordPress.PHP.DevelopmentFunctions.error_log_error_log
            error_log( 'JetReader insert failed: ' . $db_error );
            $message = defined( 'WP_DEBUG' ) && WP_DEBUG
                /* translators: %s: database error message */
                ? sprintf( __( 'Could not create item: %s', 'jetreader' ), $db_error )
                : __( 'Could not create item.', 'jetreader' );
            return new WP_Error(
                'jetreader_db_error',
                $message,
                array( 'status' => 500 )
            );
        }

        $item_id = $wpdb->insert_id;

        // Sync item-category associations (assigns "Diğer" if none selected).
        // Sync item-category associations (assigns "Diğer" if none selected, handles category_names parameter).
        $category_names = isset( $params['category_names'] ) ? sanitize_text_field( $params['category_names'] ) : '';
        if ( ! empty( $category_names ) ) {
            $category_ids = $this->import_resolve_categories( $category_names, $type );
        } else {
            $category_ids = isset( $params['category_ids'] ) && is_array( $params['category_ids'] )
                ? $params['category_ids']
                : array();
        }
        try {
            $this->sync_item_categories( $item_id, $category_ids, $type );
        } catch ( \Throwable $e ) {
            // phpcs:ignore WordPress.PHP.DevelopmentFunctions.error_log_error_log
            error_log( 'JetReader sync_item_categories failed on create: ' . $e->getMessage() );
        }

        $this->invalidate_dashboard_cache();
        $this->invalidate_authors_cache();
        $this->invalidate_publishers_cache();
        $this->invalidate_categories_cache();
        $this->invalidate_permalink_cache();
        $this->invalidate_files_cache();

        // CPT sync.
        try {
            if ( class_exists( 'JetReader_CPT' ) ) {
                JetReader_CPT::sync_from_item( $item_id );
            }
        } catch ( \Throwable $e ) {
            // phpcs:ignore WordPress.PHP.DevelopmentFunctions.error_log_error_log
            error_log( 'JetReader CPT sync failed on create: ' . $e->getMessage() );
        }

        return new WP_REST_Response(
            array(
                'id'      => $item_id,
                'message' => __( 'Item created successfully.', 'jetreader' ),
            ),
            201
        );
    }

    /**
     * Update existing item.
     */
    public function bulk_update_items( $request ) {
        global $wpdb;

        $params = $request->get_params();
        $ids    = isset( $params['ids'] ) && is_array( $params['ids'] ) ? $params['ids'] : array();
        $ids    = array_filter( array_map( 'intval', $ids ) );

        if ( empty( $ids ) ) {
            return new WP_Error( 'jetreader_no_ids', __( 'No item IDs provided.', 'jetreader' ), array( 'status' => 400 ) );
        }

        $allowed_types      = array( 'book', 'article', 'magazine', 'qa' );
        $allowed_visibility = array( 'publish', 'draft', 'private' );
        $data               = array();

        $updatable = array( 'type', 'language', 'author', 'translator', 'publisher', 'publication_year', 'visibility', 'featured' );
        foreach ( $updatable as $field ) {
            if ( ! isset( $params[ $field ] ) ) {
                continue;
            }
            switch ( $field ) {
                case 'type':
                    $val = sanitize_text_field( $params[ $field ] );
                    $data[ $field ] = in_array( $val, $allowed_types, true ) ? $val : 'book';
                    break;
                case 'featured':
                    $data[ $field ] = ! empty( $params[ $field ] ) ? 1 : 0;
                    break;
                case 'publication_year':
                    $data[ $field ] = ! empty( $params[ $field ] ) ? intval( $params[ $field ] ) : null;
                    break;
                case 'visibility':
                    $val = sanitize_text_field( $params[ $field ] );
                    $data[ $field ] = in_array( $val, $allowed_visibility, true ) ? $val : 'publish';
                    break;
                default:
                    $data[ $field ] = sanitize_text_field( $params[ $field ] );
            }
        }

        if ( ! empty( $data['author'] ) && '__none__' !== $data['author'] ) {
            $author_names = array_filter( array_map( 'trim', explode( ',', $data['author'] ) ) );
            foreach ( $author_names as $auth_name ) {
                if ( '' !== $auth_name && '__none__' !== $auth_name ) {
                    $this->import_ensure_author( $auth_name );
                }
            }
        }
        if ( ! empty( $data['publisher'] ) && '__none__' !== $data['publisher'] ) {
            $publisher_names = array_filter( array_map( 'trim', explode( ',', $data['publisher'] ) ) );
            foreach ( $publisher_names as $pub_name ) {
                if ( '' !== $pub_name && '__none__' !== $pub_name ) {
                    $this->import_ensure_publisher( $pub_name );
                }
            }
        }

        $has_categories = isset( $params['category_ids'] ) && is_array( $params['category_ids'] );
        $has_category_names = isset( $params['category_names'] );

        if ( empty( $data ) && ! $has_categories && ! $has_category_names ) {
            return new WP_Error( 'jetreader_no_data', __( 'No data to update.', 'jetreader' ), array( 'status' => 400 ) );
        }

        if ( ! empty( $data ) ) {
            // Use native wpdb->update in a loop to perform bulk updates safely and cleanly without dynamic SQL warnings.
            foreach ( $ids as $id ) {
                $wpdb->update(
                    "{$wpdb->prefix}jetreader_items",
                    $data,
                    array( 'id' => $id )
                );
            }
        }

        if ( $has_category_names || $has_categories ) {
            $current_type = isset( $data['type'] ) ? $data['type'] : null;
            foreach ( $ids as $id ) {
                $type = $current_type ?? $wpdb->get_var( $wpdb->prepare(
                    "SELECT type FROM {$wpdb->prefix}jetreader_items WHERE id = %d",
                    $id
                ) );
                if ( $has_category_names ) {
                    $category_ids = $this->import_resolve_categories( sanitize_text_field( $params['category_names'] ), $type ?? 'book' );
                } else {
                    $category_ids = $params['category_ids'];
                }
                try {
                    $this->sync_item_categories( $id, $category_ids, $type ?? 'book' );
                } catch ( \Throwable $e ) {
                    // phpcs:ignore WordPress.PHP.DevelopmentFunctions.error_log_error_log
                    error_log( 'JetReader bulk sync_item_categories failed for id ' . $id . ': ' . $e->getMessage() );
                }
            }
        }

        $this->invalidate_dashboard_cache();
        $this->invalidate_authors_cache();
        $this->invalidate_publishers_cache();
        $this->invalidate_categories_cache();
        $this->invalidate_permalink_cache();
        $this->invalidate_files_cache();

        try {
            if ( class_exists( 'JetReader_CPT' ) ) {
                foreach ( $ids as $id ) {
                    JetReader_CPT::sync_from_item( $id );
                }
            }
        } catch ( \Throwable $e ) {
            // phpcs:ignore WordPress.PHP.DevelopmentFunctions.error_log_error_log
            error_log( 'JetReader CPT bulk sync failed: ' . $e->getMessage() );
        }

        return rest_ensure_response( array(
            'updated' => count( $ids ),
            'message' => __( 'Items updated successfully.', 'jetreader' ),
        ) );
    }

    public function update_item( $request ) {
        global $wpdb;

        $item_id = $request['id'];
        $params  = $request->get_params();

        $item = $wpdb->get_row( $wpdb->prepare(
            "SELECT * FROM {$wpdb->prefix}jetreader_items WHERE id = %d",
            $item_id
        ) );

        if ( ! $item ) {
            return new WP_Error(
                'jetreader_not_found',
                __( 'Item not found.', 'jetreader' ),
                array( 'status' => 404 )
            );
        }

        $data = array();

        $allowed_types = array( 'book', 'article', 'magazine', 'qa' );
        $allowed_visibility = array( 'publish', 'draft', 'private' );

        $updatable = array( 'type', 'title', 'description', 'cover_image', 'file_path', 'file_type', 'language', 'author', 'translator', 'publisher', 'isbn', 'publication_year', 'visibility', 'featured', 'page_count' );
        foreach ( $updatable as $field ) {
            if ( ! isset( $params[ $field ] ) ) {
                continue;
            }
            switch ( $field ) {
                case 'type':
                    $val = sanitize_text_field( $params[ $field ] );
                    $data[ $field ] = in_array( $val, $allowed_types, true ) ? $val : 'book';
                    break;
                case 'page_count':
                    $data[ $field ] = ! empty( $params[ $field ] ) ? intval( $params[ $field ] ) : 0;
                    break;
                case 'featured':
                    $data[ $field ] = ! empty( $params[ $field ] ) ? 1 : 0;
                    break;
                case 'description':
                    $data[ $field ] = wp_kses_post( $params[ $field ] );
                    break;
                case 'cover_image':
                    $data[ $field ] = esc_url_raw( $params[ $field ] );
                    break;
                case 'file_path':
                    $val = sanitize_text_field( $params[ $field ] );
                    if ( ! $this->validate_file_reference( $val ) ) {
                        return new WP_Error( 'jetreader_invalid_file_path', __( 'Invalid file path/URL or domain not allowed.', 'jetreader' ), array( 'status' => 400 ) );
                    }
                    $data[ $field ] = $val;
                    break;
                case 'publication_year':
                    $data[ $field ] = ! empty( $params[ $field ] ) ? intval( $params[ $field ] ) : null;
                    break;
                case 'visibility':
                    $val = sanitize_text_field( $params[ $field ] );
                    $data[ $field ] = in_array( $val, $allowed_visibility, true ) ? $val : 'publish';
                    break;
                default:
                    $data[ $field ] = sanitize_text_field( $params[ $field ] );
            }
        }

        // Handle multi-volume/issue data.
        if ( isset( $params['volumes'] ) ) {
            if ( is_array( $params['volumes'] ) && ! empty( $params['volumes'] ) ) {
                $clean_vols = array();
                foreach ( array_values( $params['volumes'] ) as $idx => $vol ) {
                    if ( ! is_array( $vol ) ) continue;
                    $vol_path = sanitize_text_field( $vol['file_path'] ?? '' );
                    if ( ! $this->validate_file_reference( $vol_path ) ) {
                        return new WP_Error( 'jetreader_invalid_file_path', __( 'Invalid volume file path/URL or domain not allowed.', 'jetreader' ), array( 'status' => 400 ) );
                    }

                    // Auto detect encoding for volume if text file.
                    $vol_type = sanitize_text_field( $vol['file_type'] ?? '' );
                    $vol_encoding = isset( $vol['encoding'] ) ? sanitize_text_field( $vol['encoding'] ) : 'utf-8';
                    if ( 'txt' === $vol_type && empty( $vol['encoding'] ) && ! empty( $vol_path ) ) {
                        $local_path = JetReader_Upload_Handler::url_to_local_path( $vol_path );
                        if ( file_exists( $local_path ) ) {
                            $content_sample = file_get_contents( $local_path, false, null, 0, 10000 );
                            if ( function_exists( 'mb_detect_encoding' ) && $content_sample ) {
                                $enc = mb_detect_encoding( $content_sample, array( 'UTF-8', 'ISO-8859-9', 'Windows-1254', 'Windows-1251', 'ISO-8859-1', 'ASCII', 'UTF-16', 'UTF-16LE', 'UTF-16BE', 'BIG5', 'GBK', 'EUC-JP', 'SJIS' ), true );
                                if ( $enc ) {
                                    $vol_encoding = strtolower( $enc );
                                }
                            }
                        }
                    }

                    $clean_vols[] = array(
                        'vol'         => $idx + 1,
                        'file_path'   => $vol_path,
                        'file_type'   => $vol_type,
                        'cover_image' => esc_url_raw( $vol['cover_image'] ?? '' ),
                        'page_count'  => isset( $vol['page_count'] ) ? intval( $vol['page_count'] ) : 0,
                        'encoding'    => $vol_encoding,
                    );
                }
                if ( ! empty( $clean_vols ) ) {
                    $data['volumes']     = wp_json_encode( $clean_vols );
                    $data['file_path']   = $clean_vols[0]['file_path'];
                    $data['file_type']   = $clean_vols[0]['file_type'];
                    $data['cover_image'] = $clean_vols[0]['cover_image'];
                }
            } else {
                $data['volumes'] = null;
            }
        }

        // If file_path or file_type changes and results in a single text file, detect encoding.
        $final_path = $data['file_path'] ?? $item->file_path;
        $final_type = $data['file_type'] ?? $item->file_type;
        if ( ! empty( $final_path ) && 'txt' === $final_type ) {
            $local_path = JetReader_Upload_Handler::url_to_local_path( $final_path );
            if ( file_exists( $local_path ) ) {
                $content_sample = file_get_contents( $local_path, false, null, 0, 10000 );
                if ( function_exists( 'mb_detect_encoding' ) && $content_sample ) {
                    $enc = mb_detect_encoding( $content_sample, array( 'UTF-8', 'ISO-8859-9', 'Windows-1254', 'Windows-1251', 'ISO-8859-1', 'ASCII', 'UTF-16', 'UTF-16LE', 'UTF-16BE', 'BIG5', 'GBK', 'EUC-JP', 'SJIS' ), true );
                    if ( $enc ) {
                        $existing_metadata = $item->metadata ? json_decode( $item->metadata, true ) : array();
                        if ( ! is_array( $existing_metadata ) ) {
                            $existing_metadata = array();
                        }
                        $existing_metadata['encoding'] = strtolower( $enc );
                        $data['metadata'] = wp_json_encode( $existing_metadata );
                    }
                }
            }
        }

        if ( ! empty( $data['author'] ) ) {
            $author_names = array_filter( array_map( 'trim', explode( ',', $data['author'] ) ) );
            foreach ( $author_names as $auth_name ) {
                if ( '' !== $auth_name ) {
                    $this->import_ensure_author( $auth_name );
                }
            }
        }
        if ( ! empty( $data['publisher'] ) ) {
            $publisher_names = array_filter( array_map( 'trim', explode( ',', $data['publisher'] ) ) );
            foreach ( $publisher_names as $pub_name ) {
                if ( '' !== $pub_name ) {
                    $this->import_ensure_publisher( $pub_name );
                }
            }
        }

        $has_categories = isset( $params['category_ids'] ) && is_array( $params['category_ids'] );
        $has_category_names = isset( $params['category_names'] );

        if ( empty( $data ) && ! $has_categories && ! $has_category_names ) {
            return new WP_Error(
                'jetreader_no_data',
                __( 'No data to update.', 'jetreader' ),
                array( 'status' => 400 )
            );
        }

        if ( ! empty( $data ) ) {
            $result = $wpdb->update(
                "{$wpdb->prefix}jetreader_items",
                $data,
                array( 'id' => $item_id )
            );
            if ( false === $result ) {
                $db_error = $wpdb->last_error;
                // phpcs:ignore WordPress.PHP.DevelopmentFunctions.error_log_error_log
                error_log( 'JetReader update failed: ' . $db_error );
                $message = defined( 'WP_DEBUG' ) && WP_DEBUG
                    /* translators: %s: database error message */
                    ? sprintf( __( 'Could not update item: %s', 'jetreader' ), $db_error )
                    : __( 'Could not update item.', 'jetreader' );
                return new WP_Error(
                    'jetreader_db_error',
                    $message,
                    array( 'status' => 500 )
                );
            }
        }

        // Sync item-category associations (assigns "Diğer" if none selected).
        if ( $has_category_names || $has_categories ) {
            try {
                $current_type = isset( $data['type'] ) ? $data['type'] : $item->type;
                if ( $has_category_names ) {
                    $category_ids = $this->import_resolve_categories( sanitize_text_field( $params['category_names'] ), $current_type );
                } else {
                    $category_ids = $params['category_ids'];
                }
                $this->sync_item_categories( $item_id, $category_ids, $current_type );
            } catch ( \Throwable $e ) {
                // phpcs:ignore WordPress.PHP.DevelopmentFunctions.error_log_error_log
                error_log( 'JetReader sync_item_categories failed on update: ' . $e->getMessage() );
            }
        }

        $this->invalidate_dashboard_cache();
        $this->invalidate_authors_cache();
        $this->invalidate_publishers_cache();
        $this->invalidate_categories_cache();
        $this->invalidate_permalink_cache();
        $this->invalidate_files_cache();

        // CPT sync.
        try {
            if ( class_exists( 'JetReader_CPT' ) ) {
                JetReader_CPT::sync_from_item( $item_id );
            }
        } catch ( \Throwable $e ) {
            // phpcs:ignore WordPress.PHP.DevelopmentFunctions.error_log_error_log
            error_log( 'JetReader CPT sync failed on update: ' . $e->getMessage() );
        }

        return rest_ensure_response(
            array(
                'id'      => $item_id,
                'message' => __( 'Item updated successfully.', 'jetreader' ),
            )
        );
    }

    public function bulk_delete_items( $request ) {
        global $wpdb;

        $params = $request->get_json_params();
        $ids    = isset( $params['ids'] ) && is_array( $params['ids'] ) ? $params['ids'] : array();
        $ids    = array_values( array_filter( array_map( 'intval', $ids ) ) );
        $should_delete_files = isset( $params['delete_files'] ) ? rest_sanitize_boolean( $params['delete_files'] ) : true;

        if ( empty( $ids ) ) {
            return new WP_Error( 'jetreader_no_ids', __( 'No item IDs provided.', 'jetreader' ), array( 'status' => 400 ) );
        }

        if ( class_exists( 'JetReader_CPT' ) ) {
            foreach ( $ids as $id ) {
                try {
                    JetReader_CPT::delete_by_item( $id );
                } catch ( \Throwable $e ) {
                    // phpcs:ignore WordPress.PHP.DevelopmentFunctions.error_log_error_log
                    error_log( 'JetReader CPT bulk delete failed for id ' . $id . ': ' . $e->getMessage() );
                }
            }
        }

        $placeholders = implode( ',', array_fill( 0, count( $ids ), '%d' ) );

        // Fetch items to delete their files first if they live under uploads/jetreader
        $items_to_clean = $should_delete_files ? $wpdb->get_results( $wpdb->prepare( "SELECT file_path, cover_image, volumes FROM {$wpdb->prefix}jetreader_items WHERE id IN ({$placeholders})", $ids ) ) : array();
        if ( ! empty( $items_to_clean ) ) {
            if ( ! class_exists( 'JetReader_Upload_Handler' ) ) {
                require_once JETREADER_PLUGIN_DIR . 'includes/class-upload-handler.php';
            }
            $upload_dir    = wp_upload_dir();
            $jetreader_dir = realpath( $upload_dir['basedir'] . '/jetreader' );

            foreach ( $items_to_clean as $item ) {
                $files_to_delete = array();
                if ( ! empty( $item->file_path ) ) {
                    $files_to_delete[] = $item->file_path;
                }
                if ( ! empty( $item->cover_image ) ) {
                    $files_to_delete[] = $item->cover_image;
                }
                if ( ! empty( $item->volumes ) ) {
                    $vols = json_decode( $item->volumes, true );
                    if ( is_array( $vols ) ) {
                        foreach ( $vols as $vol ) {
                            if ( ! empty( $vol['file_path'] ) ) {
                                $files_to_delete[] = $vol['file_path'];
                            }
                        }
                    }
                }
                foreach ( $files_to_delete as $file_url ) {
                    $local_path = JetReader_Upload_Handler::url_to_local_path( $file_url );
                    $real_file_path = realpath( $local_path );
                    if ( false !== $real_file_path && file_exists( $real_file_path ) && is_file( $real_file_path ) ) {
                        if ( $jetreader_dir && strpos( $real_file_path, $jetreader_dir ) === 0 ) {
                            // phpcs:ignore WordPress.WP.AlternativeFunctions.unlink_unlink
                            @unlink( $real_file_path );
                        }
                    }
                }
            }
        }

        $wpdb->query( $wpdb->prepare( "DELETE FROM {$wpdb->prefix}jetreader_item_categories WHERE item_id IN ({$placeholders})", $ids ) );
        $wpdb->query( $wpdb->prepare( "DELETE FROM {$wpdb->prefix}jetreader_item_tags WHERE item_id IN ({$placeholders})", $ids ) );
        $wpdb->query( $wpdb->prepare( "DELETE FROM {$wpdb->prefix}jetreader_bookmarks WHERE item_id IN ({$placeholders})", $ids ) );
        $wpdb->query( $wpdb->prepare( "DELETE FROM {$wpdb->prefix}jetreader_notes WHERE item_id IN ({$placeholders})", $ids ) );
        $wpdb->query( $wpdb->prepare( "DELETE FROM {$wpdb->prefix}jetreader_items WHERE id IN ({$placeholders})", $ids ) );

        $this->invalidate_dashboard_cache();
        $this->invalidate_authors_cache();
        $this->invalidate_categories_cache();
        $this->invalidate_permalink_cache();
        $this->invalidate_files_cache();

        return rest_ensure_response( array(
            'deleted' => count( $ids ),
            'message' => __( 'Items deleted successfully.', 'jetreader' ),
        ) );
    }

    /**
     * Delete item.
     */
    public function delete_item( $request ) {
        global $wpdb;

        $item_id = $request['id'];

        $item = $wpdb->get_row( $wpdb->prepare(
            "SELECT * FROM {$wpdb->prefix}jetreader_items WHERE id = %d",
            $item_id
        ) );

        if ( ! $item ) {
            return new WP_Error(
                'jetreader_not_found',
                __( 'Item not found.', 'jetreader' ),
                array( 'status' => 404 )
            );
        }

        // Delete CPT post first.
        if ( class_exists( 'JetReader_CPT' ) ) {
            JetReader_CPT::delete_by_item( $item_id );
        }

        // Conditionally delete physical files from uploads/jetreader/.
        $delete_files = $request->get_param( 'delete_files' );
        $should_delete_files = ( $delete_files === null ) ? true : rest_sanitize_boolean( $delete_files );

        if ( $should_delete_files ) {
            if ( ! class_exists( 'JetReader_Upload_Handler' ) ) {
                require_once JETREADER_PLUGIN_DIR . 'includes/class-upload-handler.php';
            }
            $upload_dir    = wp_upload_dir();
            $jetreader_dir = realpath( $upload_dir['basedir'] . '/jetreader' );

            $files_to_delete = array();
            if ( ! empty( $item->file_path ) ) {
                $files_to_delete[] = $item->file_path;
            }
            if ( ! empty( $item->cover_image ) ) {
                $files_to_delete[] = $item->cover_image;
            }
            if ( ! empty( $item->volumes ) ) {
                $vols = json_decode( $item->volumes, true );
                if ( is_array( $vols ) ) {
                    foreach ( $vols as $vol ) {
                        if ( ! empty( $vol['file_path'] ) ) {
                            $files_to_delete[] = $vol['file_path'];
                        }
                    }
                }
            }
            foreach ( $files_to_delete as $file_url ) {
                $local_path = JetReader_Upload_Handler::url_to_local_path( $file_url );
                $real_file_path = realpath( $local_path );
                if ( false !== $real_file_path && file_exists( $real_file_path ) && is_file( $real_file_path ) ) {
                    if ( $jetreader_dir && strpos( $real_file_path, $jetreader_dir ) === 0 ) {
                        // phpcs:ignore WordPress.WP.AlternativeFunctions.unlink_unlink
                        @unlink( $real_file_path );
                    }
                }
            }
        }

        // Delete all related records in cascade (bookmarks, notes, annotations included).
        $wpdb->delete( "{$wpdb->prefix}jetreader_item_categories", array( 'item_id' => $item_id ) );
        $wpdb->delete( "{$wpdb->prefix}jetreader_item_tags", array( 'item_id' => $item_id ) );
        $wpdb->delete( "{$wpdb->prefix}jetreader_bookmarks", array( 'item_id' => $item_id ) );
        $wpdb->delete( "{$wpdb->prefix}jetreader_notes", array( 'item_id' => $item_id ) );
        $wpdb->delete( "{$wpdb->prefix}jetreader_items", array( 'id' => $item_id ) );

        $this->invalidate_dashboard_cache();
        $this->invalidate_authors_cache();
        $this->invalidate_categories_cache();
        $this->invalidate_permalink_cache();
        $this->invalidate_files_cache();

        return rest_ensure_response(
            array(
                'id'      => $item_id,
                'message' => __( 'Item deleted successfully.', 'jetreader' ),
            )
        );
    }

    /**
    public function get_chapters( $request ) {
        return rest_ensure_response( array() );
    }

    /**
     * Upload and process a file.
     */
    public function upload_file( $request ) {
        require_once JETREADER_PLUGIN_DIR . 'includes/class-upload-handler.php';

        $upload_handler = new JetReader_Upload_Handler();
        $response       = $upload_handler->handle_upload( $request );

        if ( ! is_wp_error( $response ) ) {
            $status = is_a( $response, 'WP_REST_Response' ) ? $response->get_status() : 200;
            if ( $status >= 200 && $status < 300 ) {
                $this->invalidate_files_cache();
            }
        }

        return $response;
    }

    /**
     * Get categories, optionally filtered by type.
     * Cached with a transient; invalidated on any category or item-category CRUD.
     */
    public function get_categories( $request ) {
        global $wpdb;

        $type     = sanitize_text_field( $request->get_param( 'type' ) ?? '' );
        $is_admin = current_user_can( 'manage_options' );
        $cache_key = 'jetreader_cats_' . md5( $type . '_' . ($is_admin ? 'admin' : 'public') );

        $cached = get_transient( $cache_key );
        if ( false !== $cached ) {
            return rest_ensure_response( $cached );
        }

        if ( ! $is_admin ) {
            // Public frontend: return only categories with at least one published library item
            if ( ! empty( $type ) ) {
                $categories = $wpdb->get_results(
                    $wpdb->prepare(
                        "SELECT DISTINCT c.* FROM {$wpdb->prefix}jetreader_categories c
                         JOIN {$wpdb->prefix}jetreader_item_categories ic ON c.id = ic.category_id
                         JOIN {$wpdb->prefix}jetreader_items i ON ic.item_id = i.id
                         WHERE c.type = %s AND i.visibility = 'publish'
                         ORDER BY c.name ASC",
                        $type
                    )
                );
            } else {
                $categories = $wpdb->get_results(
                    "SELECT DISTINCT c.* FROM {$wpdb->prefix}jetreader_categories c
                     JOIN {$wpdb->prefix}jetreader_item_categories ic ON c.id = ic.category_id
                     JOIN {$wpdb->prefix}jetreader_items i ON ic.item_id = i.id
                     WHERE i.visibility = 'publish'
                     ORDER BY c.name ASC"
                );
            }
        } else {
            // Admin panel: return all categories for content management
            if ( ! empty( $type ) ) {
                $categories = $wpdb->get_results(
                    $wpdb->prepare(
                        "SELECT * FROM {$wpdb->prefix}jetreader_categories WHERE type = %s ORDER BY name ASC",
                        $type
                    )
                );
            } else {
                $categories = $wpdb->get_results(
                    "SELECT * FROM {$wpdb->prefix}jetreader_categories ORDER BY name ASC"
                );
            }
        }

        $result = array_map(
            function( $cat ) {
                $cat->id         = intval( $cat->id );
                $cat->parent_id  = intval( $cat->parent_id );
                $cat->item_count = intval( $cat->item_count );
                return $cat;
            },
            $categories
        );

        set_transient( $cache_key, $result, DAY_IN_SECONDS );

        return rest_ensure_response( $result );
    }

    /**
     * Create category.
     */
    public function create_category( $request ) {
        global $wpdb;

        $params = $request->get_params();
        $name   = sanitize_text_field( $params['name'] ?? '' );

        if ( '' === trim( $name ) ) {
            return new WP_Error(
                'jetreader_missing_name',
                __( 'Category name is required.', 'jetreader' ),
                array( 'status' => 400 )
            );
        }

        $slug   = sanitize_title( $name );

        $allowed_types = array( 'book', 'article', 'magazine', 'qa' );
        $type = sanitize_text_field( $params['type'] ?? 'book' );
        if ( ! in_array( $type, $allowed_types, true ) ) {
            $type = 'book';
        }

        // Check for duplicate slug within the same type.
        $existing = $wpdb->get_var( $wpdb->prepare(
            "SELECT id FROM {$wpdb->prefix}jetreader_categories WHERE slug = %s AND type = %s",
            $slug,
            $type
        ) );

        if ( $existing ) {
            $slug .= '-' . time();
        }

        $inserted = $wpdb->insert(
            "{$wpdb->prefix}jetreader_categories",
            array(
                'name'        => $name,
                'slug'        => $slug,
                'description' => sanitize_textarea_field( $params['description'] ?? '' ),
                'type'        => $type,
            ),
            array( '%s', '%s', '%s', '%s' )
        );

        if ( false === $inserted ) {
            return new WP_Error(
                'jetreader_db_error',
                __( 'Could not create category.', 'jetreader' ),
                array( 'status' => 500 )
            );
        }

        $insert_id = $wpdb->insert_id;
        $this->invalidate_categories_cache();

        // Fetch the newly inserted row to return the complete category object.
        $new_cat = $wpdb->get_row(
            $wpdb->prepare(
                "SELECT * FROM {$wpdb->prefix}jetreader_categories WHERE id = %d",
                $insert_id
            )
        );

        return rest_ensure_response(
            array(
                'category' => $new_cat,
                'id'       => $insert_id,
                'message'  => __( 'Category created successfully.', 'jetreader' ),
            )
        );
    }

    /**
     * Update category.
     */
    public function update_category( $request ) {
        global $wpdb;

        $cat_id = intval( $request['id'] );
        $params = $request->get_params();

        $existing = $wpdb->get_row( $wpdb->prepare(
            "SELECT * FROM {$wpdb->prefix}jetreader_categories WHERE id = %d",
            $cat_id
        ) );

        if ( ! $existing ) {
            return new WP_Error(
                'jetreader_not_found',
                __( 'Category not found.', 'jetreader' ),
                array( 'status' => 404 )
            );
        }

        $data = array();

        if ( isset( $params['name'] ) && '' !== trim( $params['name'] ) ) {
            $data['name'] = sanitize_text_field( $params['name'] );
            $data['slug'] = sanitize_title( $params['name'] );
        }
        if ( isset( $params['description'] ) ) {
            $data['description'] = sanitize_textarea_field( $params['description'] );
        }
        if ( isset( $params['type'] ) ) {
            $allowed_types = array( 'book', 'article', 'magazine', 'qa' );
            $type = sanitize_text_field( $params['type'] );
            if ( in_array( $type, $allowed_types, true ) ) {
                $data['type'] = $type;
            }
        }

        if ( empty( $data ) ) {
            return new WP_Error(
                'jetreader_no_data',
                __( 'No data to update.', 'jetreader' ),
                array( 'status' => 400 )
            );
        }

        $wpdb->update(
            "{$wpdb->prefix}jetreader_categories",
            $data,
            array( 'id' => $cat_id )
        );

        $this->invalidate_categories_cache();

        return rest_ensure_response(
            array(
                'id'      => $cat_id,
                'message' => __( 'Category updated successfully.', 'jetreader' ),
            )
        );
    }

    /**
     * Delete category and its item associations.
     */
    public function delete_category( $request ) {
        global $wpdb;

        $cat_id = intval( $request['id'] );

        $existing = $wpdb->get_row( $wpdb->prepare(
            "SELECT * FROM {$wpdb->prefix}jetreader_categories WHERE id = %d",
            $cat_id
        ) );

        if ( ! $existing ) {
            return new WP_Error(
                'jetreader_not_found',
                __( 'Category not found.', 'jetreader' ),
                array( 'status' => 404 )
            );
        }

        $wpdb->delete( "{$wpdb->prefix}jetreader_item_categories", array( 'category_id' => $cat_id ), array( '%d' ) );
        $wpdb->delete( "{$wpdb->prefix}jetreader_categories", array( 'id' => $cat_id ), array( '%d' ) );

        $this->invalidate_categories_cache();

        return rest_ensure_response(
            array(
                'id'      => $cat_id,
                'message' => __( 'Category deleted successfully.', 'jetreader' ),
            )
        );
    }

    /**
     * Ensure a "Diğer" (default) category exists for the given type.
     * Returns the category ID (creates one if it doesn't exist).
     *
     * @param string $type Item type.
     * @return int Category ID.
     */
    private function ensure_default_category( $type ) {
        global $wpdb;

        $allowed_types = array( 'book', 'article', 'magazine', 'qa' );
        if ( ! in_array( $type, $allowed_types, true ) ) {
            $type = 'book';
        }

        $slug = 'other-' . $type;

        $existing_id = $wpdb->get_var( $wpdb->prepare(
            "SELECT id FROM {$wpdb->prefix}jetreader_categories WHERE slug = %s AND type = %s",
            $slug,
            $type
        ) );

        if ( $existing_id ) {
            return intval( $existing_id );
        }

        $wpdb->insert(
            "{$wpdb->prefix}jetreader_categories",
            array(
                'name'        => __( 'Other', 'jetreader' ),
                'slug'        => $slug,
                'description' => __( 'Default category', 'jetreader' ),
                'type'        => $type,
            ),
            array( '%s', '%s', '%s', '%s' )
        );

        return intval( $wpdb->insert_id );
    }

    /**
     * Sync item-category associations for a given item.
     *
     * If no categories are provided, the item is automatically assigned
     * to the "Diğer" (default) category for its type.
     *
     * @param int    $item_id      Item ID.
     * @param array  $category_ids Array of category IDs.
     * @param string $item_type    Item type (used to assign default "Diğer" if no categories).
     */
    private function sync_item_categories( $item_id, $category_ids, $item_type = 'book' ) {
        global $wpdb;

        // Remove existing associations.
        $wpdb->delete( "{$wpdb->prefix}jetreader_item_categories", array( 'item_id' => $item_id ), array( '%d' ) );

        // If no categories provided, assign to "Diğer".
        if ( empty( $category_ids ) || ! is_array( $category_ids ) ) {
            $default_id = $this->ensure_default_category( $item_type );
            $wpdb->insert(
                "{$wpdb->prefix}jetreader_item_categories",
                array(
                    'item_id'     => $item_id,
                    'category_id' => $default_id,
                ),
                array( '%d', '%d' )
            );
            return;
        }

        foreach ( $category_ids as $cat_id ) {
            $cat_id = intval( $cat_id );
            if ( $cat_id <= 0 ) {
                continue;
            }
            $wpdb->insert(
                "{$wpdb->prefix}jetreader_item_categories",
                array(
                    'item_id'     => $item_id,
                    'category_id' => $cat_id,
                ),
                array( '%d', '%d' )
            );
        }
    }

    /**
     * Get category IDs associated with an item.
     *
     * @param int $item_id Item ID.
     * @return array Array of category IDs.
     */
    private function get_item_category_ids( $item_id ) {
        global $wpdb;
        $rows = $wpdb->get_col( $wpdb->prepare(
            "SELECT category_id FROM {$wpdb->prefix}jetreader_item_categories WHERE item_id = %d",
            $item_id
        ) );
        return array_map( 'intval', $rows );
    }

    /**
     * Get tags.
     */
    public function get_tags( $request ) {
        global $wpdb;

        $is_admin = current_user_can( 'manage_options' );

        if ( ! $is_admin ) {
            $tags = $wpdb->get_results(
                "SELECT DISTINCT t.* FROM {$wpdb->prefix}jetreader_tags t
                 JOIN {$wpdb->prefix}jetreader_item_tags it ON t.id = it.tag_id
                 JOIN {$wpdb->prefix}jetreader_items i ON it.item_id = i.id
                 WHERE i.visibility = 'publish'
                 ORDER BY t.name ASC"
            );
        } else {
            $tags = $wpdb->get_results(
                "SELECT * FROM {$wpdb->prefix}jetreader_tags ORDER BY name ASC"
            );
        }

        return rest_ensure_response( $tags );
    }

    public function get_settings( $request ) {
        $settings = get_option( 'jetreader_settings', array() );

        if ( empty( $settings['reader_logo_url'] ) ) {
            $settings['reader_logo_url'] = JETREADER_PLUGIN_URL . 'assets/logo/jetreader.png';
        } elseif ( strpos( $settings['reader_logo_url'], 'assets/logo/' ) !== false && strpos( $settings['reader_logo_url'], 'jetreader' ) === false ) {
            $settings['reader_logo_url'] = JETREADER_PLUGIN_URL . 'assets/logo/jetreader.png';
        }

        return rest_ensure_response( $settings );
    }

    /**
     * Update plugin settings.
     */
    public function update_settings( $request ) {
        $params   = $request->get_params();
        $settings = get_option( 'jetreader_settings', array() );

        // 1. Define strict schemas for each allowed setting key.
        $allowed_bools = array(
            'annotation_enabled',
            'copy_enabled',
            'show_sidebar',
            'show_filter_category',
            'show_filter_language',
            'show_filter_year',
            'show_card_image',
            'show_card_title',
            'show_detail_image',
            'show_detail_title',
            'show_detail_author',
            'show_detail_description',
        );

        $allowed_ints = array(
            'items_per_page'  => array( 'min' => 1, 'max' => 500, 'default' => 24 ),
            'grid_columns'    => array( 'min' => 1, 'max' => 10, 'default' => 4 ),
            'upload_max_size' => array( 'min' => 1, 'max' => 1000, 'default' => 100 ),
        );

        $allowed_enums = array(
            'reader_font_size' => array( 'small', 'medium', 'large', 'xlarge' ),
            'reader_theme'     => array( 'auto', 'light', 'dark', 'sepia' ),
            'primary_palette'  => array( 'gray', 'purple' ),
        );

        $allowed_slugs = array(
            'cpt_slug_book',
            'cpt_slug_article',
            'cpt_slug_magazine',
            'cpt_slug_qa',
        );

        // 2. Validate and process only whitelisted params.
        foreach ( $params as $key => $value ) {
            // Check if key is a boolean
            if ( in_array( $key, $allowed_bools, true ) ) {
                $settings[ $key ] = rest_sanitize_boolean( $value );
                continue;
            }

            // Check if key is an integer
            if ( array_key_exists( $key, $allowed_ints ) ) {
                $rules = $allowed_ints[ $key ];
                $val   = intval( $value );
                if ( $val < $rules['min'] ) {
                    $val = $rules['min'];
                }
                if ( $val > $rules['max'] ) {
                    $val = $rules['max'];
                }
                $settings[ $key ] = $val;
                continue;
            }

            // Check if key is an enum
            if ( array_key_exists( $key, $allowed_enums ) ) {
                $allowed_vals = $allowed_enums[ $key ];
                $val          = sanitize_text_field( $value );
                if ( in_array( $val, $allowed_vals, true ) ) {
                    $settings[ $key ] = $val;
                }
                continue;
            }

            // Check if key is plugin_language
            if ( 'plugin_language' === $key ) {
                $val = preg_replace( '/[^a-zA-Z0-9_-]/', '', $value );
                if ( ! empty( $val ) && strlen( $val ) <= 10 ) {
                    $settings[ $key ] = $val;
                }
                continue;
            }

            // Check if key is a CPT slug
            if ( in_array( $key, $allowed_slugs, true ) ) {
                $val = sanitize_title( $value );
                if ( ! empty( $val ) ) {
                    $settings[ $key ] = $val;
                }
                continue;
            }

            // Check if key is reader_logo_url
            if ( 'reader_logo_url' === $key ) {
                $val = sanitize_text_field( $value );
                if ( empty( $val ) ) {
                    $settings[ $key ] = '';
                } else {
                    $escaped = esc_url_raw( $val );
                    if ( ! empty( $escaped ) ) {
                        $settings[ $key ] = $escaped;
                    }
                }
                continue;
            }
        }

        // 3. Post-process default logo fallback logic
        $default_logo = JETREADER_PLUGIN_URL . 'assets/logo/jetreader.png';
        if ( isset( $settings['reader_logo_url'] ) && ( empty( $settings['reader_logo_url'] ) || $settings['reader_logo_url'] === $default_logo ) ) {
            $settings['reader_logo_url'] = '';
        }

        update_option( 'jetreader_settings', $settings );

        if ( empty( $settings['reader_logo_url'] ) ) {
            $settings['reader_logo_url'] = JETREADER_PLUGIN_URL . 'assets/logo/jetreader.png';
        }

        // CPT slug changed -> invalidate permalink cache
        foreach ( $allowed_slugs as $k ) {
            if ( array_key_exists( $k, $params ) ) {
                $this->invalidate_permalink_cache();
                break;
            }
        }

        return rest_ensure_response(
            array(
                'settings' => $settings,
                'message'  => __( 'Settings updated successfully.', 'jetreader' ),
            )
        );
    }





    /**
     * Get public settings (for frontend: reader toggles + display config).
     */
    public function get_public_settings( $request ) {
        $settings = get_option( 'jetreader_settings', array() );

        $bool = function( $key, $default ) use ( $settings ) {
            if ( ! isset( $settings[ $key ] ) ) {
                return $default;
            }
            $val = $settings[ $key ];
            if ( is_bool( $val ) ) {
                return $val;
            }
            if ( $val === 'false' || $val === '0' || $val === 0 || $val === '' ) {
                return false;
            }
            return boolval( $val );
        };
        $int = function( $key, $default ) use ( $settings ) {
            return isset( $settings[ $key ] ) ? intval( $settings[ $key ] ) : $default;
        };
        $str = function( $key, $default ) use ( $settings ) {
            return isset( $settings[ $key ] ) ? strval( $settings[ $key ] ) : $default;
        };

        return rest_ensure_response( array(
            'annotation_enabled'      => $bool( 'annotation_enabled', true ),
            'copy_enabled'            => $bool( 'copy_enabled', true ),
            'items_per_page'          => $int( 'items_per_page', 24 ),
            'grid_columns'            => $int( 'grid_columns', 4 ),
            'show_sidebar'            => $bool( 'show_sidebar', true ),
            'show_filter_category'    => $bool( 'show_filter_category', true ),
            'show_filter_language'    => $bool( 'show_filter_language', true ),
            'show_filter_year'        => $bool( 'show_filter_year', true ),
            'show_card_image'         => $bool( 'show_card_image', true ),
            'show_card_title'         => $bool( 'show_card_title', true ),
            'show_detail_image'       => $bool( 'show_detail_image', true ),
            'show_detail_title'       => $bool( 'show_detail_title', true ),
            'show_detail_author'      => $bool( 'show_detail_author', true ),
            'show_detail_description' => $bool( 'show_detail_description', true ),
            'reader_font_size'     => $str( 'reader_font_size', 'medium' ),
            'reader_theme'         => $str( 'reader_theme', 'auto' ),
            'plugin_language'      => $str( 'plugin_language', 'en' ),
            'primary_palette'      => $str( 'primary_palette', 'gray' ),
            'available_languages'  => jetreader_get_available_languages(),
            'reader_logo_url'      => JETREADER_PLUGIN_URL . 'assets/logo/jetreader.png',
        ) );
    }

    /**
     * Get dashboard statistics (cached for 5 minutes).
     */
    public function get_dashboard_stats( $request ) {
        global $wpdb;

        $force = false;
        if ( isset( $request ) && $request instanceof WP_REST_Request ) {
            $param_force = $request->get_param( 'force' );
            if ( '1' === $param_force || 1 === $param_force || 'true' === $param_force || true === $param_force ) {
                $force = true;
            }
        }

        $cache_key = 'jetreader_dashboard_stats';

        if ( ! $force ) {
            $stats = get_transient( $cache_key );
            if ( false !== $stats && is_array( $stats ) ) {
                return rest_ensure_response( $stats );
            }
        }

        $rows = $wpdb->get_results(
            "SELECT `type`, COUNT(*) AS cnt FROM {$wpdb->prefix}jetreader_items GROUP BY `type`"
        );

        $counts = array( 'book' => 0, 'article' => 0, 'magazine' => 0, 'qa' => 0 );
        if ( is_array( $rows ) ) {
            foreach ( $rows as $row ) {
                if ( isset( $counts[ $row->type ] ) ) {
                    $counts[ $row->type ] = intval( $row->cnt );
                }
            }
        }

        $total_direct = intval( $wpdb->get_var( "SELECT COUNT(*) FROM {$wpdb->prefix}jetreader_items" ) );

        $totals = $wpdb->get_row(
            "SELECT SUM(view_count) AS views, SUM(read_count) AS reads FROM {$wpdb->prefix}jetreader_items"
        );

        $total_views = ( $totals && isset( $totals->views ) ) ? intval( $totals->views ) : 0;
        $total_reads = ( $totals && isset( $totals->reads ) ) ? intval( $totals->reads ) : 0;

        $stats = array(
            'total_books'     => $counts['book'],
            'total_articles'  => $counts['article'],
            'total_magazines' => $counts['magazine'],
            'total_qa'        => $counts['qa'],
            'total_items'     => $total_direct,
            'total_views'     => $total_views,
            'total_reads'     => $total_reads,
        );

        set_transient( $cache_key, $stats, 5 * MINUTE_IN_SECONDS );

        return rest_ensure_response( $stats );
    }

    /**
     * Invalidate dashboard stats cache (call after item create/update/delete).
     */
    private function invalidate_dashboard_cache() {
        delete_transient( 'jetreader_dashboard_stats' );
    }

    /**
     * Invalidate cached authors list.
     */
    private function invalidate_authors_cache(): void {
        delete_transient( 'jetreader_authors_list_admin' );
        delete_transient( 'jetreader_authors_list_public' );
    }

    /**
     * Invalidate cached publishers list.
     */
    private function invalidate_publishers_cache(): void {
        delete_transient( 'jetreader_publishers_list_admin' );
        delete_transient( 'jetreader_publishers_list_public' );
    }

    /**
     * Invalidate cached categories list.
     * Call after any category or item-category create / update / delete.
     */
    private function invalidate_categories_cache(): void {
        foreach ( array( '', 'book', 'article', 'magazine', 'qa' ) as $type ) {
            delete_transient( 'jetreader_cats_' . md5( $type . '_admin' ) );
            delete_transient( 'jetreader_cats_' . md5( $type . '_public' ) );
        }
    }

    /**
     * Invalidate the cached files list.
     * Call after any operation that adds, removes, renames, or re-links files.
     */
    private function invalidate_files_cache(): void {
        delete_transient( 'jetreader_files_list' );
    }

    /**
     * Return the full item_id → CPT permalink map.
     *
     * The result is:
     *  • Cached in a static property for the lifetime of the current PHP request.
     *  • Persisted in a transient for 1 hour to survive across requests.
     *  • Automatically invalidated on any item create / update / delete.
     *
     * This replaces a per-request JOIN on wp_postmeta executed every time
     * /items or /search was called, which caused full table scans because
     * wp_postmeta.meta_value carries no index.
     *
     * @return array<int,string>
     */
    private function get_full_permalink_map(): array {
        // In-memory hit — avoids even a transient get within the same request.
        if ( null !== self::$permalink_map_cache ) {
            return self::$permalink_map_cache;
        }

        $cache_key = 'jetreader_cpt_permalink_map';
        $map       = get_transient( $cache_key );

        if ( false !== $map && is_array( $map ) ) {
            self::$permalink_map_cache = $map;
            return $map;
        }

        // Build the map from the database.
        global $wpdb;

        $rewrite_slugs = array(
            'jetreader_book'     => 'jetreader-books',
            'jetreader_article'  => 'jetreader-articles',
            'jetreader_magazine' => 'jetreader-magazines',
            'jetreader_qa'       => 'jetreader-qa',
        );

        $rows = $wpdb->get_results( $wpdb->prepare(
            "SELECT p.ID, p.post_name, p.post_type, pm.meta_value AS item_id
             FROM {$wpdb->posts} p
             INNER JOIN {$wpdb->postmeta} pm
                 ON p.ID = pm.post_id AND pm.meta_key = %s
             WHERE p.post_status = 'publish'
               AND p.post_type IN ('jetreader_book','jetreader_article','jetreader_magazine','jetreader_qa')",
            '_jetreader_item_id'
        ) );

        $permalink_structure = get_option( 'permalink_structure' );
        $is_plain            = empty( $permalink_structure );

        $map = array();
        foreach ( $rows as $row ) {
            if ( $is_plain ) {
                $map[ intval( $row->item_id ) ] = add_query_arg(
                    array(
                        'post_type' => $row->post_type,
                        'p'         => intval( $row->ID ),
                    ),
                    home_url( '/' )
                );
            } else {
                $rewrite = $rewrite_slugs[ $row->post_type ] ?? '';
                if ( $rewrite && $row->post_name ) {
                    $map[ intval( $row->item_id ) ] = home_url( '/' . $rewrite . '/' . $row->post_name . '/' );
                }
            }
        }

        set_transient( $cache_key, $map, HOUR_IN_SECONDS );
        self::$permalink_map_cache = $map;
        return $map;
    }

    /**
     * Invalidate the CPT permalink transient and in-memory cache.
     * Must be called after any item or CPT post mutation so that
     * subsequent /items responses reflect the updated permalink.
     */
    private function invalidate_permalink_cache(): void {
        delete_transient( 'jetreader_cpt_permalink_map' );
        self::$permalink_map_cache = null;
    }

    /**
     * Check admin permission.
     */
    public function check_admin_permission() {
        return current_user_can( 'manage_options' );
    }

    /**
     * Check if user is logged in.
     */
    public function check_logged_in() {
        return is_user_logged_in();
    }

    /**
     * Check whether the current user may read an item.
     * Admins can read anything; others only published items.
     *
     * @param int $item_id Item ID.
     * @return bool
     */
    private function can_read_item( int $item_id ): bool {
        if ( current_user_can( 'manage_options' ) ) {
            return true;
        }
        global $wpdb;
        // phpcs:ignore WordPress.DB.DirectDatabaseQuery.DirectQuery,WordPress.DB.DirectDatabaseQuery.NoCaching
        $visibility = $wpdb->get_var(
            $wpdb->prepare(
                "SELECT visibility FROM {$wpdb->prefix}jetreader_items WHERE id = %d",
                $item_id
            )
        );
        return 'publish' === $visibility;
    }

    /**
     * Get bookmarks for current user, optionally filtered by item_id.
     */
    public function get_bookmarks( $request ) {
        global $wpdb;

        $user_id = get_current_user_id();
        $item_id = $request->get_param( 'item_id' );

        $where = $wpdb->prepare( 'user_id = %d', $user_id );
        if ( $item_id ) {
            $where .= $wpdb->prepare( ' AND item_id = %d', $item_id );
        }

        // phpcs:ignore WordPress.DB.DirectDatabaseQuery.DirectQuery,WordPress.DB.DirectDatabaseQuery.NoCaching,WordPress.DB.PreparedSQL.InterpolatedNotPrepared
        $bookmarks = $wpdb->get_results( "SELECT * FROM {$wpdb->prefix}jetreader_bookmarks WHERE {$where} ORDER BY created_at DESC" );

        return rest_ensure_response( array_map( function( $bm ) {
            if ( is_string( $bm->position ) ) {
                $bm->position = json_decode( $bm->position, true );
            }
            return $bm;
        }, $bookmarks ) );
    }

    /**
     * Create a bookmark.
     */
    public function create_bookmark( $request ) {
        global $wpdb;

        $user_id = get_current_user_id();
        $params  = $request->get_params();
        $item_id = intval( $params['item_id'] );

        if ( ! $this->can_read_item( $item_id ) ) {
            return new WP_Error( 'jetreader_not_found', __( 'Item not found.', 'jetreader' ), array( 'status' => 404 ) );
        }

        $data = array(
            'user_id'    => $user_id,
            'item_id'    => $item_id,
            'chapter_id' => ! empty( $params['chapter_id'] ) ? intval( $params['chapter_id'] ) : null,
            'position'   => wp_json_encode( $this->sanitize_position( $params['position'] ?? array() ) ),
            'label'      => sanitize_text_field( $params['label'] ?? '' ),
            'color'      => sanitize_hex_color( $params['color'] ?? '#FFD700' ),
        );

        // phpcs:ignore WordPress.DB.DirectDatabaseQuery.DirectQuery,WordPress.DB.DirectDatabaseQuery.NoCaching
        $wpdb->insert(
            "{$wpdb->prefix}jetreader_bookmarks",
            $data,
            array( '%d', '%d', '%d', '%s', '%s', '%s' )
        );

        return rest_ensure_response(
            array(
                'id'      => $wpdb->insert_id,
                'message' => __( 'Bookmark created.', 'jetreader' ),
            )
        );
    }

    /**
     * Delete a bookmark.
     */
    public function delete_bookmark( $request ) {
        global $wpdb;

        $user_id    = get_current_user_id();
        $bookmark_id = intval( $request['id'] );

        // phpcs:ignore WordPress.DB.DirectDatabaseQuery.DirectQuery,WordPress.DB.DirectDatabaseQuery.NoCaching
        $deleted = $wpdb->delete(
            "{$wpdb->prefix}jetreader_bookmarks",
            array(
                'id'      => $bookmark_id,
                'user_id' => $user_id,
            ),
            array( '%d', '%d' )
        );

        if ( ! $deleted ) {
            return new WP_Error(
                'jetreader_not_found',
                __( 'Bookmark not found.', 'jetreader' ),
                array( 'status' => 404 )
            );
        }

        return rest_ensure_response(
            array( 'message' => __( 'Bookmark deleted.', 'jetreader' ) )
        );
    }

    /**
     * Get notes for current user, optionally filtered by item_id.
     */
    public function get_notes( $request ) {
        global $wpdb;

        $user_id = get_current_user_id();
        $item_id = $request->get_param( 'item_id' );

        $where = $wpdb->prepare( 'user_id = %d', $user_id );
        if ( $item_id ) {
            $where .= $wpdb->prepare( ' AND item_id = %d', $item_id );
        }

        // phpcs:ignore WordPress.DB.DirectDatabaseQuery.DirectQuery,WordPress.DB.DirectDatabaseQuery.NoCaching,WordPress.DB.PreparedSQL.InterpolatedNotPrepared
        $notes = $wpdb->get_results( "SELECT * FROM {$wpdb->prefix}jetreader_notes WHERE {$where} ORDER BY created_at DESC" );

        return rest_ensure_response( array_map( function( $note ) {
            if ( is_string( $note->position ) ) {
                $note->position = json_decode( $note->position, true );
            }
            return $note;
        }, $notes ) );
    }

    /**
     * Create a note / highlight.
     */
    public function create_note( $request ) {
        global $wpdb;

        $user_id = get_current_user_id();
        $params  = $request->get_params();
        $item_id = intval( $params['item_id'] );

        if ( ! $this->can_read_item( $item_id ) ) {
            return new WP_Error( 'jetreader_not_found', __( 'Item not found.', 'jetreader' ), array( 'status' => 404 ) );
        }

        $data = array(
            'user_id'    => $user_id,
            'item_id'    => $item_id,
            'chapter_id' => ! empty( $params['chapter_id'] ) ? intval( $params['chapter_id'] ) : null,
            'type'       => sanitize_text_field( $params['type'] ?? 'note' ),
            'content'    => wp_kses_post( $params['content'] ?? '' ),
            'quote'      => sanitize_textarea_field( $params['quote'] ?? '' ),
            'position'   => wp_json_encode( $this->sanitize_position( $params['position'] ?? array() ) ),
            'color'      => sanitize_hex_color( $params['color'] ?? '#FFFF00' ),
            'is_public'  => ! empty( $params['is_public'] ) ? 1 : 0,
        );

        // phpcs:ignore WordPress.DB.DirectDatabaseQuery.DirectQuery,WordPress.DB.DirectDatabaseQuery.NoCaching
        $wpdb->insert(
            "{$wpdb->prefix}jetreader_notes",
            $data,
            array( '%d', '%d', '%d', '%s', '%s', '%s', '%s', '%s', '%d' )
        );

        return rest_ensure_response(
            array(
                'id'      => $wpdb->insert_id,
                'message' => __( 'Note created.', 'jetreader' ),
            )
        );
    }

    /**
     * Update a note.
     */
    public function update_note( $request ) {
        global $wpdb;

        $user_id = get_current_user_id();
        $note_id = intval( $request['id'] );
        $params  = $request->get_params();

        // phpcs:ignore WordPress.DB.DirectDatabaseQuery.DirectQuery,WordPress.DB.DirectDatabaseQuery.NoCaching
        $existing = $wpdb->get_row( $wpdb->prepare(
            "SELECT * FROM {$wpdb->prefix}jetreader_notes WHERE id = %d AND user_id = %d",
            $note_id,
            $user_id
        ) );

        if ( ! $existing ) {
            return new WP_Error(
                'jetreader_not_found',
                __( 'Note not found.', 'jetreader' ),
                array( 'status' => 404 )
            );
        }

        $data = array();
        $updatable = array( 'content', 'quote', 'color', 'is_public', 'position' );
        foreach ( $updatable as $field ) {
            if ( isset( $params[ $field ] ) ) {
                if ( $field === 'is_public' ) {
                    $data[ $field ] = ! empty( $params[ $field ] ) ? 1 : 0;
                } elseif ( $field === 'position' ) {
                    $data[ $field ] = wp_json_encode( $this->sanitize_position( $params[ $field ] ?? array() ) );
                } elseif ( $field === 'color' ) {
                    $data[ $field ] = sanitize_hex_color( $params[ $field ] );
                } elseif ( $field === 'content' ) {
                    $data[ $field ] = wp_kses_post( $params[ $field ] );
                } else {
                    $data[ $field ] = sanitize_textarea_field( $params[ $field ] );
                }
            }
        }

        if ( empty( $data ) ) {
            return new WP_Error(
                'jetreader_no_data',
                __( 'No data to update.', 'jetreader' ),
                array( 'status' => 400 )
            );
        }

        // phpcs:ignore WordPress.DB.DirectDatabaseQuery.DirectQuery,WordPress.DB.DirectDatabaseQuery.NoCaching
        $wpdb->update(
            "{$wpdb->prefix}jetreader_notes",
            $data,
            array( 'id' => $note_id, 'user_id' => $user_id ),
            array_fill( 0, count( $data ), '%s' ),
            array( '%d', '%d' )
        );

        return rest_ensure_response(
            array( 'message' => __( 'Note updated.', 'jetreader' ) )
        );
    }

    /**
     * Delete a note.
     */
    public function delete_note( $request ) {
        global $wpdb;

        $user_id = get_current_user_id();
        $note_id = intval( $request['id'] );

        // phpcs:ignore WordPress.DB.DirectDatabaseQuery.DirectQuery,WordPress.DB.DirectDatabaseQuery.NoCaching
        $deleted = $wpdb->delete(
            "{$wpdb->prefix}jetreader_notes",
            array(
                'id'      => $note_id,
                'user_id' => $user_id,
            ),
            array( '%d', '%d' )
        );

        if ( ! $deleted ) {
            return new WP_Error(
                'jetreader_not_found',
                __( 'Note not found.', 'jetreader' ),
                array( 'status' => 404 )
            );
        }

        return rest_ensure_response(
            array( 'message' => __( 'Note deleted.', 'jetreader' ) )
        );
    }

    /**
     * Arguments for get_items endpoint.
     */
    private function get_items_args() {
        return array(
            'page'            => array( 'default' => 1,  'sanitize_callback' => 'absint' ),
            'per_page'        => array( 'default' => 24, 'sanitize_callback' => 'absint' ),
            'type'            => array( 'default' => '', 'sanitize_callback' => 'sanitize_text_field' ),
            'author'          => array( 'sanitize_callback' => 'sanitize_text_field' ),
            'author_names'    => array( 'sanitize_callback' => 'sanitize_text_field' ),
            'publisher_names' => array( 'sanitize_callback' => 'sanitize_text_field' ),
            'language'        => array( 'sanitize_callback' => 'sanitize_text_field' ),
            'year_from'       => array( 'sanitize_callback' => 'absint' ),
            'year_to'         => array( 'sanitize_callback' => 'absint' ),
            'category_id'     => array( 'sanitize_callback' => 'absint' ),
            'featured'        => array( 'sanitize_callback' => 'sanitize_text_field' ),
            'visibility'      => array( 'sanitize_callback' => 'sanitize_text_field' ),
            'file_type'       => array( 'sanitize_callback' => 'sanitize_text_field' ),
            'view_min'        => array( 'sanitize_callback' => 'absint' ),
            'view_max'        => array( 'sanitize_callback' => 'absint' ),
            'has_volumes'     => array( 'sanitize_callback' => 'absint' ),
            'search'          => array( 'sanitize_callback' => 'sanitize_text_field' ),
        );
    }

    /**
     * Format item for API response.
     */
    /**
     * GET /authors
     * Returns all managed authors from the jetreader_authors table.
     */
    public function get_authors( $request ) {
        global $wpdb;

        $is_admin  = current_user_can( 'manage_options' );
        $cache_key = 'jetreader_authors_list_' . ($is_admin ? 'admin' : 'public');
        $cached    = get_transient( $cache_key );
        if ( false !== $cached ) {
            return rest_ensure_response( $cached );
        }

        if ( ! $is_admin ) {
            // Public frontend: return only authors linked to at least one published library item
            // phpcs:ignore WordPress.DB.DirectDatabaseQuery.DirectQuery,WordPress.DB.DirectDatabaseQuery.NoCaching
            $rows = $wpdb->get_results(
                "SELECT DISTINCT a.* FROM {$wpdb->prefix}jetreader_authors a
                 JOIN {$wpdb->prefix}jetreader_items i ON FIND_IN_SET(a.name, REPLACE(i.author, ', ', ',')) > 0
                 WHERE i.visibility = 'publish'
                 ORDER BY a.name ASC"
            );
        } else {
            // Admin panel: return all managed authors
            // phpcs:ignore WordPress.DB.DirectDatabaseQuery.DirectQuery,WordPress.DB.DirectDatabaseQuery.NoCaching
            $rows = $wpdb->get_results(
                "SELECT * FROM {$wpdb->prefix}jetreader_authors ORDER BY name ASC"
            );
        }

        $result = array_map( function ( $row ) {
            $row->id = intval( $row->id );
            return $row;
        }, $rows );

        set_transient( $cache_key, $result, DAY_IN_SECONDS );

        return rest_ensure_response( $result );
    }

    /**
     * POST /authors
     */
    public function create_author( $request ) {
        global $wpdb;

        $name = sanitize_text_field( $request->get_param( 'name' ) ?? '' );
        if ( '' === trim( $name ) ) {
            return new WP_Error( 'jetreader_missing_name', __( 'Author name is required.', 'jetreader' ), array( 'status' => 400 ) );
        }

        $slug     = sanitize_title( $name );
        // phpcs:ignore WordPress.DB.DirectDatabaseQuery.DirectQuery,WordPress.DB.DirectDatabaseQuery.NoCaching
        $existing = $wpdb->get_var( $wpdb->prepare(
            "SELECT id FROM {$wpdb->prefix}jetreader_authors WHERE slug = %s", $slug
        ) );
        if ( $existing ) {
            $slug .= '-' . time();
        }

        // phpcs:ignore WordPress.DB.DirectDatabaseQuery.DirectQuery,WordPress.DB.DirectDatabaseQuery.NoCaching
        $inserted = $wpdb->insert(
            "{$wpdb->prefix}jetreader_authors",
            array(
                'name'        => $name,
                'slug'        => $slug,
                'description' => sanitize_textarea_field( $request->get_param( 'description' ) ?? '' ),
            ),
            array( '%s', '%s', '%s' )
        );

        if ( false === $inserted ) {
            return new WP_Error( 'jetreader_db_error', __( 'Could not create author.', 'jetreader' ), array( 'status' => 500 ) );
        }

        $insert_id = $wpdb->insert_id;
        $this->invalidate_authors_cache();

        // phpcs:ignore WordPress.DB.DirectDatabaseQuery.DirectQuery,WordPress.DB.DirectDatabaseQuery.NoCaching
        $new_row = $wpdb->get_row( $wpdb->prepare(
            "SELECT * FROM {$wpdb->prefix}jetreader_authors WHERE id = %d", $insert_id
        ) );

        return rest_ensure_response( array(
            'author'  => $new_row,
            'id'      => $insert_id,
            'message' => __( 'Author created successfully.', 'jetreader' ),
        ) );
    }

    /**
     * PUT /authors/{id}
     */
    public function update_author( $request ) {
        global $wpdb;

        $id      = intval( $request['id'] );
        // phpcs:ignore WordPress.DB.DirectDatabaseQuery.DirectQuery,WordPress.DB.DirectDatabaseQuery.NoCaching
        $existing = $wpdb->get_row( $wpdb->prepare(
            "SELECT * FROM {$wpdb->prefix}jetreader_authors WHERE id = %d", $id
        ) );

        if ( ! $existing ) {
            return new WP_Error( 'jetreader_not_found', __( 'Author not found.', 'jetreader' ), array( 'status' => 404 ) );
        }

        $data = array();
        $name = $request->get_param( 'name' );
        if ( isset( $name ) && '' !== trim( $name ) ) {
            $data['name'] = sanitize_text_field( $name );
            $data['slug'] = sanitize_title( $name );
        }
        $desc = $request->get_param( 'description' );
        if ( isset( $desc ) ) {
            $data['description'] = sanitize_textarea_field( $desc );
        }

        if ( empty( $data ) ) {
            return new WP_Error( 'jetreader_no_data', __( 'No data to update.', 'jetreader' ), array( 'status' => 400 ) );
        }

        // phpcs:ignore WordPress.DB.DirectDatabaseQuery.DirectQuery,WordPress.DB.DirectDatabaseQuery.NoCaching
        $wpdb->update( "{$wpdb->prefix}jetreader_authors", $data, array( 'id' => $id ) );
        $this->invalidate_authors_cache();

        return rest_ensure_response( array( 'id' => $id, 'message' => __( 'Author updated successfully.', 'jetreader' ) ) );
    }

    /**
     * DELETE /authors/{id}
     */
    public function delete_author( $request ) {
        global $wpdb;

        $id      = intval( $request['id'] );
        // phpcs:ignore WordPress.DB.DirectDatabaseQuery.DirectQuery,WordPress.DB.DirectDatabaseQuery.NoCaching
        $existing = $wpdb->get_row( $wpdb->prepare(
            "SELECT id FROM {$wpdb->prefix}jetreader_authors WHERE id = %d", $id
        ) );

        if ( ! $existing ) {
            return new WP_Error( 'jetreader_not_found', __( 'Author not found.', 'jetreader' ), array( 'status' => 404 ) );
        }

        // phpcs:ignore WordPress.DB.DirectDatabaseQuery.DirectQuery,WordPress.DB.DirectDatabaseQuery.NoCaching
        $wpdb->delete( "{$wpdb->prefix}jetreader_authors", array( 'id' => $id ), array( '%d' ) );
        $this->invalidate_authors_cache();

        return rest_ensure_response( array( 'id' => $id, 'message' => __( 'Author deleted successfully.', 'jetreader' ) ) );
    }

    /**
     * GET /publishers
     * Returns all managed publishers from the jetreader_publishers table.
     */
    public function get_publishers( $request ) {
        global $wpdb;

        $is_admin  = current_user_can( 'manage_options' );
        $cache_key = 'jetreader_publishers_list_' . ($is_admin ? 'admin' : 'public');
        $cached    = get_transient( $cache_key );
        if ( false !== $cached ) {
            return rest_ensure_response( $cached );
        }

        if ( ! $is_admin ) {
            // Public frontend: return only publishers linked to at least one published library item
            // phpcs:ignore WordPress.DB.DirectDatabaseQuery.DirectQuery,WordPress.DB.DirectDatabaseQuery.NoCaching
            $rows = $wpdb->get_results(
                "SELECT DISTINCT p.* FROM {$wpdb->prefix}jetreader_publishers p
                 JOIN {$wpdb->prefix}jetreader_items i ON FIND_IN_SET(p.name, REPLACE(i.publisher, ', ', ',')) > 0
                 WHERE i.visibility = 'publish'
                 ORDER BY p.name ASC"
            );
        } else {
            // Admin panel: return all managed publishers
            // phpcs:ignore WordPress.DB.DirectDatabaseQuery.DirectQuery,WordPress.DB.DirectDatabaseQuery.NoCaching
            $rows = $wpdb->get_results(
                "SELECT * FROM {$wpdb->prefix}jetreader_publishers ORDER BY name ASC"
            );
        }

        $result = array_map( function ( $row ) {
            $row->id = intval( $row->id );
            return $row;
        }, $rows );

        set_transient( $cache_key, $result, DAY_IN_SECONDS );

        return rest_ensure_response( $result );
    }

    /**
     * POST /publishers
     */
    public function create_publisher( $request ) {
        global $wpdb;

        $name = sanitize_text_field( $request->get_param( 'name' ) ?? '' );
        if ( '' === trim( $name ) ) {
            return new WP_Error( 'jetreader_missing_name', __( 'Publisher name is required.', 'jetreader' ), array( 'status' => 400 ) );
        }

        $slug     = sanitize_title( $name );
        // phpcs:ignore WordPress.DB.DirectDatabaseQuery.DirectQuery,WordPress.DB.DirectDatabaseQuery.NoCaching
        $existing = $wpdb->get_var( $wpdb->prepare(
            "SELECT id FROM {$wpdb->prefix}jetreader_publishers WHERE slug = %s", $slug
        ) );
        if ( $existing ) {
            $slug .= '-' . time();
        }

        // phpcs:ignore WordPress.DB.DirectDatabaseQuery.DirectQuery,WordPress.DB.DirectDatabaseQuery.NoCaching
        $inserted = $wpdb->insert(
            "{$wpdb->prefix}jetreader_publishers",
            array(
                'name'        => $name,
                'slug'        => $slug,
                'description' => sanitize_textarea_field( $request->get_param( 'description' ) ?? '' ),
            ),
            array( '%s', '%s', '%s' )
        );

        if ( false === $inserted ) {
            return new WP_Error( 'jetreader_db_error', __( 'Could not create publisher.', 'jetreader' ), array( 'status' => 500 ) );
        }

        $insert_id = $wpdb->insert_id;
        $this->invalidate_publishers_cache();

        // phpcs:ignore WordPress.DB.DirectDatabaseQuery.DirectQuery,WordPress.DB.DirectDatabaseQuery.NoCaching
        $new_row = $wpdb->get_row( $wpdb->prepare(
            "SELECT * FROM {$wpdb->prefix}jetreader_publishers WHERE id = %d", $insert_id
        ) );

        return rest_ensure_response( array(
            'publisher' => $new_row,
            'id'        => $insert_id,
            'message'   => __( 'Publisher created successfully.', 'jetreader' ),
        ) );
    }

    /**
     * PUT /publishers/{id}
     */
    public function update_publisher( $request ) {
        global $wpdb;

        $id      = intval( $request['id'] );
        // phpcs:ignore WordPress.DB.DirectDatabaseQuery.DirectQuery,WordPress.DB.DirectDatabaseQuery.NoCaching
        $existing = $wpdb->get_row( $wpdb->prepare(
            "SELECT * FROM {$wpdb->prefix}jetreader_publishers WHERE id = %d", $id
        ) );

        if ( ! $existing ) {
            return new WP_Error( 'jetreader_not_found', __( 'Publisher not found.', 'jetreader' ), array( 'status' => 404 ) );
        }

        $data = array();
        $name = $request->get_param( 'name' );
        if ( isset( $name ) && '' !== trim( $name ) ) {
            $data['name'] = sanitize_text_field( $name );
            $data['slug'] = sanitize_title( $name );
        }
        $desc = $request->get_param( 'description' );
        if ( isset( $desc ) ) {
            $data['description'] = sanitize_textarea_field( $desc );
        }

        if ( empty( $data ) ) {
            return new WP_Error( 'jetreader_no_data', __( 'No data to update.', 'jetreader' ), array( 'status' => 400 ) );
        }

        // phpcs:ignore WordPress.DB.DirectDatabaseQuery.DirectQuery,WordPress.DB.DirectDatabaseQuery.NoCaching
        $wpdb->update( "{$wpdb->prefix}jetreader_publishers", $data, array( 'id' => $id ) );
        $this->invalidate_publishers_cache();

        return rest_ensure_response( array( 'id' => $id, 'message' => __( 'Publisher updated successfully.', 'jetreader' ) ) );
    }

    /**
     * DELETE /publishers/{id}
     */
    public function delete_publisher( $request ) {
        global $wpdb;

        $id      = intval( $request['id'] );
        // phpcs:ignore WordPress.DB.DirectDatabaseQuery.DirectQuery,WordPress.DB.DirectDatabaseQuery.NoCaching
        $existing = $wpdb->get_row( $wpdb->prepare(
            "SELECT id FROM {$wpdb->prefix}jetreader_publishers WHERE id = %d", $id
        ) );

        if ( ! $existing ) {
            return new WP_Error( 'jetreader_not_found', __( 'Publisher not found.', 'jetreader' ), array( 'status' => 404 ) );
        }

        // phpcs:ignore WordPress.DB.DirectDatabaseQuery.DirectQuery,WordPress.DB.DirectDatabaseQuery.NoCaching
        $wpdb->delete( "{$wpdb->prefix}jetreader_publishers", array( 'id' => $id ), array( '%d' ) );
        $this->invalidate_publishers_cache();

        return rest_ensure_response( array( 'id' => $id, 'message' => __( 'Publisher deleted successfully.', 'jetreader' ) ) );
    }

    /**
     * Format a single item for API output.
     *
     * @param object $item         Raw DB row.
     * @param array  $cat_map       Pre-fetched item_id → category_ids[] map (batch optimisation).
     * @param array  $permalink_map Pre-fetched item_id → cpt_url map (batch optimisation).
     */
    private function format_item( $item, array $cat_map = array(), array $permalink_map = array() ) {
        if ( $item->metadata && is_string( $item->metadata ) ) {
            $item->metadata = json_decode( $item->metadata, true );
        }

        $volumes = null;
        if ( ! empty( $item->volumes ) && is_string( $item->volumes ) ) {
            $decoded = json_decode( $item->volumes, true );
            if ( is_array( $decoded ) && ! empty( $decoded ) ) {
                $volumes = array();
                foreach ( $decoded as $vol ) {
                    if ( isset( $vol['file_path'] ) ) {
                        $vol['file_path'] = $this->ensure_public_url( $vol['file_path'] );
                    }
                    if ( isset( $vol['cover_image'] ) ) {
                        $vol['cover_image'] = $this->ensure_public_url( $vol['cover_image'] );
                    }
                    $volumes[] = $vol;
                }
            }
        }

        $item_id = intval( $item->id );

        // Use pre-fetched maps when available (batch path); fall back to individual
        // queries for single-item calls (get_item, search_items, etc.).
        $category_ids = isset( $cat_map[ $item_id ] )
            ? $cat_map[ $item_id ]
            : $this->get_item_category_ids( $item_id );

        $cpt_url = isset( $permalink_map[ $item_id ] )
            ? $permalink_map[ $item_id ]
            : ( class_exists( 'JetReader_CPT' ) ? JetReader_CPT::get_permalink_by_item( $item_id ) : '' );

        $data = array(
            'id'               => $item_id,
            'type'             => $item->type,
            'title'            => $item->title,
            'slug'             => $item->slug,
            'description'      => $item->description,
            'cover_image'      => $this->ensure_public_url( $item->cover_image ),
            'file_path'        => $this->ensure_public_url( $item->file_path ),
            'file_type'        => $item->file_type,
            'language'         => $item->language,
            'author'           => $item->author,
            'translator'       => $item->translator,
            'publisher'        => $item->publisher,
            'isbn'             => $item->isbn,
            'publication_year' => intval( $item->publication_year ),
            'reading_time'     => intval( $item->reading_time ),
            'page_count'       => intval( $item->page_count ),
            'visibility'       => $item->visibility,
            'featured'         => boolval( $item->featured ),
            'view_count'       => intval( $item->view_count ),
            'read_count'       => intval( $item->read_count ),
            'volumes'          => $volumes,
            'category_ids'     => $category_ids,
            'cpt_url'          => $cpt_url,
            'metadata'         => $item->metadata,
            'created_at'       => $item->created_at,
            'updated_at'       => $item->updated_at,
        );

        return $data;
    }


    /**
     * POST /cpt-sync
     * Force-create/update CPT posts for all items. Admin only.
     */
    public function cpt_sync_all( WP_REST_Request $request ): WP_REST_Response {
        if ( ! class_exists( 'JetReader_CPT' ) ) {
            require_once JETREADER_PLUGIN_DIR . 'includes/class-cpt.php';
        }

        $count = JetReader_CPT::force_migrate_all();

        return new WP_REST_Response( array(
            'synced'  => $count,
            'message' => sprintf(
                /* translators: %d: number of items synced */
                __( '%d items synced to CPT.', 'jetreader' ),
                $count
            ),
        ) );
    }

    /**
     * Proxy an external file to work around browser CORS restrictions.
     * Only http/https URLs are allowed; private/reserved IP ranges
     * are blocked after DNS resolution to prevent SSRF. Response size is capped.
     */
    public function proxy_file( WP_REST_Request $request ) {
        $url = $request->get_param( 'url' );

        // Only allow http/https — block file://, ftp://, data:, etc.
        $scheme = wp_parse_url( $url, PHP_URL_SCHEME );
        if ( ! in_array( $scheme, array( 'http', 'https' ), true ) ) {
            return new WP_Error( 'jetreader_proxy_invalid', __( 'Invalid URL scheme.', 'jetreader' ), array( 'status' => 400 ) );
        }

        // Block private/reserved IP ranges (SSRF prevention).
        $host = wp_parse_url( $url, PHP_URL_HOST );
        if ( $host ) {
            $hosts_to_check = array();
            if ( filter_var( $host, FILTER_VALIDATE_IP ) ) {
                $hosts_to_check[] = $host;
            } else {
                $records = dns_get_record( $host, DNS_A | DNS_AAAA );
                if ( is_array( $records ) ) {
                    foreach ( $records as $record ) {
                        if ( isset( $record['ip'] ) ) {
                            $hosts_to_check[] = $record['ip'];
                        } elseif ( isset( $record['ipv6'] ) ) {
                            $hosts_to_check[] = $record['ipv6'];
                        }
                    }
                }
            }

            if ( empty( $hosts_to_check ) ) {
                $resolved = gethostbyname( $host );
                if ( $resolved !== $host ) {
                    $hosts_to_check[] = $resolved;
                }
            }

            foreach ( $hosts_to_check as $resolved_ip ) {
                if ( $this->is_private_ip( $resolved_ip ) ) {
                    return new WP_Error( 'jetreader_proxy_forbidden', __( 'Access to internal resources is not allowed.', 'jetreader' ), array( 'status' => 403 ) );
                }
            }
        }

        // 1. Determine expected document extension (pdf, epub, docx, txt) from DB or URL.
        global $wpdb;
        $url_clean    = sanitize_text_field( $url );
        $url_esc      = esc_url_raw( $url );
        $url_json     = trim( wp_json_encode( $url_clean ), '"' );
        $url_json_esc = trim( wp_json_encode( $url_esc ), '"' );

        // phpcs:ignore WordPress.DB.DirectDatabaseQuery.DirectQuery,WordPress.DB.DirectDatabaseQuery.NoCaching
        $items = $wpdb->get_results(
            $wpdb->prepare(
                "SELECT file_path, file_type, volumes FROM {$wpdb->prefix}jetreader_items 
                 WHERE file_path = %s OR file_path = %s 
                    OR volumes LIKE %s OR volumes LIKE %s 
                    OR volumes LIKE %s OR volumes LIKE %s",
                $url_clean,
                $url_esc,
                '%' . $wpdb->esc_like( $url_clean ) . '%',
                '%' . $wpdb->esc_like( $url_esc ) . '%',
                '%' . $wpdb->esc_like( $url_json ) . '%',
                '%' . $wpdb->esc_like( $url_json_esc ) . '%'
            )
        );

        $matched_type = '';
        if ( ! empty( $items ) ) {
            foreach ( $items as $item ) {
                if ( $url_clean === $item->file_path || $url_esc === $item->file_path ) {
                    $matched_type = $item->file_type;
                    break;
                }
                $vols = json_decode( $item->volumes, true );
                if ( is_array( $vols ) ) {
                    foreach ( $vols as $vol ) {
                        if ( isset( $vol['file_path'] ) && ( $url_clean === $vol['file_path'] || $url_esc === $vol['file_path'] ) ) {
                            $matched_type = $vol['file_type'] ?? '';
                            break 2;
                        }
                    }
                }
            }
        }

        if ( empty( $matched_type ) ) {
            $path = wp_parse_url( $url, PHP_URL_PATH );
            $ext  = strtolower( pathinfo( $path, PATHINFO_EXTENSION ) );
            if ( in_array( $ext, array( 'pdf', 'epub', 'docx', 'txt' ), true ) ) {
                $matched_type = $ext;
            }
        }

        $matched_type = strtolower( $matched_type );
        if ( ! in_array( $matched_type, array( 'pdf', 'epub', 'docx', 'txt' ), true ) ) {
            return new WP_Error( 'jetreader_proxy_invalid_type', __( 'Unsupported document type.', 'jetreader' ), array( 'status' => 400 ) );
        }

        $mime_map = array(
            'pdf'  => 'application/pdf',
            'epub' => 'application/epub+zip',
            'docx' => 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
            'txt'  => 'text/plain',
        );
        $safe_mime = $mime_map[ $matched_type ];

        // 2. Fetch the remote resource.
        $response = wp_remote_get( $url, array(
            'timeout'              => 20,
            'user-agent'           => 'Mozilla/5.0 (compatible; JetReader/' . JETREADER_VERSION . ')',
            'sslverify'            => true,
            'limit_response_size'  => 50 * 1024 * 1024, // 50 MB cap.
            'redirection'          => 0, // SSRF bypass mitigation.
        ) );

        if ( is_wp_error( $response ) ) {
            return new WP_Error( 'jetreader_proxy_fetch', __( 'Failed to fetch remote resource.', 'jetreader' ), array( 'status' => 502 ) );
        }

        $code         = (int) wp_remote_retrieve_response_code( $response );
        $content_type = wp_remote_retrieve_header( $response, 'content-type' ) ?: 'application/octet-stream';
        $body         = wp_remote_retrieve_body( $response );

        if ( $code >= 300 && $code < 400 ) {
            return new WP_Error( 'jetreader_proxy_redirect', __( 'Redirects are not allowed.', 'jetreader' ), array( 'status' => 400 ) );
        }

        if ( 200 !== $code ) {
            return new WP_Error( 'jetreader_proxy_upstream', __( 'Remote resource unavailable.', 'jetreader' ), array( 'status' => 502 ) );
        }

        // Validate content-type against mapped MIME.
        $ct_base = strtolower( explode( ';', $content_type )[0] );

        // Strictly reject any HTML content type
        if ( str_contains( $ct_base, 'html' ) ) {
            return new WP_Error( 'jetreader_proxy_type', __( 'HTML is not allowed for security reasons.', 'jetreader' ), array( 'status' => 415 ) );
        }

        // Validate the MIME type against expected document type.
        $allowed = false;
        if ( $ct_base === $safe_mime ) {
            $allowed = true;
        } elseif ( 'application/octet-stream' === $ct_base ) {
            // Secure octet-stream: ensure we have a valid matching file extension in the URL
            $url_path = wp_parse_url( $url, PHP_URL_PATH );
            $url_ext  = strtolower( pathinfo( $url_path, PATHINFO_EXTENSION ) );
            if ( $url_ext === $matched_type ) {
                $allowed = true;
            }
        } elseif ( 'application/zip' === $ct_base && in_array( $matched_type, array( 'epub', 'docx' ), true ) ) {
            // Secure zip: ensure matching file extension in the URL
            $url_path = wp_parse_url( $url, PHP_URL_PATH );
            $url_ext  = strtolower( pathinfo( $url_path, PATHINFO_EXTENSION ) );
            if ( $url_ext === $matched_type ) {
                $allowed = true;
            }
        } elseif ( 'application/epub' === $ct_base && 'epub' === $matched_type ) {
            $allowed = true;
        }

        if ( ! $allowed ) {
            return new WP_Error( 'jetreader_proxy_type', __( 'Content type mismatch or not allowed.', 'jetreader' ), array( 'status' => 415 ) );
        }

        $orig_filename  = pathinfo( wp_parse_url( $url, PHP_URL_PATH ) ?: 'document', PATHINFO_FILENAME );
        $clean_filename = sanitize_file_name( $orig_filename );
        if ( empty( $clean_filename ) ) {
            $clean_filename = 'document';
        }
        $filename_with_ext = $clean_filename . '.' . $matched_type;

        // Build WP_REST_Response instead of direct echo + exit inside callback to satisfy WordPress standards.
        $rest_response = new WP_REST_Response( $body, 200 );
        $rest_response->set_headers( array(
            'Content-Type'                => sanitize_mime_type( $safe_mime ),
            'Access-Control-Allow-Origin' => esc_url_raw( get_site_url() ),
            'X-Content-Type-Options'      => 'nosniff',
            'Content-Security-Policy'     => "default-src 'none'; sandbox;",
            'Cache-Control'               => 'private, max-age=3600',
        ) );

        if ( 'txt' !== $matched_type ) {
            $rest_response->header( 'Content-Disposition', 'attachment; filename="' . esc_attr( $filename_with_ext ) . '"' );
        }

        return $rest_response;
    }

    /**
     * Check permissions for proxying a URL.
     *
     * @param WP_REST_Request $request The REST request.
     * @return bool|WP_Error True if allowed, WP_Error otherwise.
     */
    public function proxy_permissions_check( WP_REST_Request $request ) {
        $url = $request->get_param( 'url' );
        if ( empty( $url ) ) {
            return new WP_Error( 'jetreader_proxy_missing_url', __( 'Missing URL parameter.', 'jetreader' ), array( 'status' => 400 ) );
        }

        // 1. Admins can proxy any URL.
        if ( current_user_can( 'manage_options' ) ) {
            return true;
        }

        // 2. Otherwise, check if the URL is associated with an item in the library.
        global $wpdb;
        $url_clean = sanitize_text_field( $url );
        $url_esc   = esc_url_raw( $url );
        
        // Since volumes is stored in JSON, slashes are escaped as \/.
        // We generate the JSON-escaped version of the URLs to match candidate database values.
        $url_json     = trim( wp_json_encode( $url_clean ), '"' );
        $url_json_esc = trim( wp_json_encode( $url_esc ), '"' );

        // Narrow down candidates in SQL for performance (LIKE search), but we fetch
        // columns file_path and volumes to do an exact match comparison in PHP.
        // phpcs:ignore WordPress.DB.DirectDatabaseQuery.DirectQuery,WordPress.DB.DirectDatabaseQuery.NoCaching
        $items = $wpdb->get_results(
            $wpdb->prepare(
                "SELECT id, visibility, file_path, volumes FROM {$wpdb->prefix}jetreader_items 
                 WHERE file_path = %s OR file_path = %s 
                    OR volumes LIKE %s OR volumes LIKE %s 
                    OR volumes LIKE %s OR volumes LIKE %s",
                $url_clean,
                $url_esc,
                '%' . $wpdb->esc_like( $url_clean ) . '%',
                '%' . $wpdb->esc_like( $url_esc ) . '%',
                '%' . $wpdb->esc_like( $url_json ) . '%',
                '%' . $wpdb->esc_like( $url_json_esc ) . '%'
            )
        );

        if ( empty( $items ) ) {
            return new WP_Error( 'jetreader_proxy_unauthorized', __( 'You do not have permission to proxy this URL.', 'jetreader' ), array( 'status' => 403 ) );
        }

        foreach ( $items as $item ) {
            // Verify exact match of the requested URL in either file_path or parsed volumes.
            $is_matched = false;
            if ( $url_clean === $item->file_path || $url_esc === $item->file_path ) {
                $is_matched = true;
            } else {
                $vols = json_decode( $item->volumes, true );
                if ( is_array( $vols ) ) {
                    foreach ( $vols as $vol ) {
                        if ( isset( $vol['file_path'] ) ) {
                            if ( $url_clean === $vol['file_path'] || $url_esc === $vol['file_path'] ) {
                                    $is_matched = true;
                                    break;
                            }
                        }
                    }
                }
            }

            if ( ! $is_matched ) {
                continue;
            }

            if ( 'publish' === $item->visibility ) {
                return true;
            }

            if ( in_array( $item->visibility, array( 'private', 'draft' ), true ) ) {
                if ( current_user_can( 'manage_options' ) ) {
                    return true;
                }
            }
        }

        return new WP_Error( 'jetreader_proxy_unauthorized', __( 'You do not have permission to proxy this URL.', 'jetreader' ), array( 'status' => 403 ) );
    }

    /**
     * Check if an IP address is in a private or reserved range.
     *
     * @param string $ip IPv4 address string.
     * @return bool
     */
    private function is_private_ip( string $ip ): bool {
        if ( ! filter_var( $ip, FILTER_VALIDATE_IP ) ) {
            return true; // Treat unresolvable/invalid as blocked.
        }
        return ! filter_var(
            $ip,
            FILTER_VALIDATE_IP,
            FILTER_FLAG_NO_PRIV_RANGE | FILTER_FLAG_NO_RES_RANGE
        );
    }

    /**
     * Ensure author name exists in jetreader_authors; insert if missing.
     */
    private function import_ensure_author( $name ) {
        global $wpdb;
        // phpcs:ignore WordPress.DB.DirectDatabaseQuery.DirectQuery,WordPress.DB.DirectDatabaseQuery.NoCaching
        $exists = $wpdb->get_var( $wpdb->prepare(
            "SELECT id FROM {$wpdb->prefix}jetreader_authors WHERE name = %s LIMIT 1", $name
        ) );
        if ( $exists ) return;
        $slug        = sanitize_title( $name );
        // phpcs:ignore WordPress.DB.DirectDatabaseQuery.DirectQuery,WordPress.DB.DirectDatabaseQuery.NoCaching
        $slug_exists = $wpdb->get_var( $wpdb->prepare(
            "SELECT id FROM {$wpdb->prefix}jetreader_authors WHERE slug = %s", $slug
        ) );
        if ( $slug_exists ) { $slug .= '-' . time(); }
        // phpcs:ignore WordPress.DB.DirectDatabaseQuery.DirectQuery,WordPress.DB.DirectDatabaseQuery.NoCaching
        $wpdb->insert(
            "{$wpdb->prefix}jetreader_authors",
            array( 'name' => $name, 'slug' => $slug ),
            array( '%s', '%s' )
        );
    }

    /**
     * Ensure publisher name exists in jetreader_publishers; insert if missing.
     */
    private function import_ensure_publisher( $name ) {
        global $wpdb;
        // phpcs:ignore WordPress.DB.DirectDatabaseQuery.DirectQuery,WordPress.DB.DirectDatabaseQuery.NoCaching
        $exists = $wpdb->get_var( $wpdb->prepare(
            "SELECT id FROM {$wpdb->prefix}jetreader_publishers WHERE name = %s LIMIT 1", $name
        ) );
        if ( $exists ) return;
        $slug        = sanitize_title( $name );
        // phpcs:ignore WordPress.DB.DirectDatabaseQuery.DirectQuery,WordPress.DB.DirectDatabaseQuery.NoCaching
        $slug_exists = $wpdb->get_var( $wpdb->prepare(
            "SELECT id FROM {$wpdb->prefix}jetreader_publishers WHERE slug = %s", $slug
        ) );
        if ( $slug_exists ) { $slug .= '-' . time(); }
        // phpcs:ignore WordPress.DB.DirectDatabaseQuery.DirectQuery,WordPress.DB.DirectDatabaseQuery.NoCaching
        $wpdb->insert(
            "{$wpdb->prefix}jetreader_publishers",
            array( 'name' => $name, 'slug' => $slug ),
            array( '%s', '%s' )
        );
    }

    /**
     * Resolve a comma-separated (JSON) or semicolon-separated (CSV) string
     * of category names into category IDs, auto-creating missing categories.
     *
     * @return int[]
     */
    private function import_resolve_categories( $names_str, $type ) {
        global $wpdb;

        if ( '' === trim( $names_str ) ) return array();

        // Accept both "," (JSON format) and ";" (CSV format).
        $sep   = ( strpos( $names_str, ';' ) !== false ) ? ';' : ',';
        $names = array_filter( array_map( 'trim', explode( $sep, $names_str ) ) );
        $ids   = array();

        foreach ( $names as $name ) {
            if ( '' === $name ) continue;

            // phpcs:ignore WordPress.DB.DirectDatabaseQuery.DirectQuery,WordPress.DB.DirectDatabaseQuery.NoCaching
            $id = $wpdb->get_var( $wpdb->prepare(
                "SELECT id FROM {$wpdb->prefix}jetreader_categories WHERE name = %s AND type = %s LIMIT 1",
                $name,
                $type
            ) );

            if ( ! $id ) {
                $slug        = sanitize_title( $name );
                // phpcs:ignore WordPress.DB.DirectDatabaseQuery.DirectQuery,WordPress.DB.DirectDatabaseQuery.NoCaching
                $slug_exists = $wpdb->get_var( $wpdb->prepare(
                    "SELECT id FROM {$wpdb->prefix}jetreader_categories WHERE slug = %s AND type = %s",
                    $slug,
                    $type
                ) );
                if ( $slug_exists ) { $slug .= '-' . time(); }
                // phpcs:ignore WordPress.DB.DirectDatabaseQuery.DirectQuery,WordPress.DB.DirectDatabaseQuery.NoCaching
                $wpdb->insert(
                    "{$wpdb->prefix}jetreader_categories",
                    array( 'name' => $name, 'slug' => $slug, 'type' => $type ),
                    array( '%s', '%s', '%s' )
                );
                $id = $wpdb->insert_id;
            }

            if ( $id ) { $ids[] = intval( $id ); }
        }

        return $ids;
    }

    /**
     * Bulk create items.
     */
    public function bulk_create_items( $request ) {
        global $wpdb;

        $items = $request->get_param( 'items' );

        if ( ! is_array( $items ) || empty( $items ) ) {
            return new WP_Error( 'jetreader_no_items', __( 'No items provided.', 'jetreader' ), array( 'status' => 400 ) );
        }

        $success = 0;
        $failed  = 0;
        $errors  = array();

        $allowed_types = array( 'book', 'article', 'magazine', 'qa' );

        foreach ( $items as $idx => $raw ) {
            $item_data = (array) $raw;
            $title = sanitize_text_field( $item_data['title'] ?? '' );

            if ( '' === trim( $title ) ) {
                $failed++;
                $errors[] = array(
                    'row'     => $idx + 1,
                    'title'   => '',
                    'message' => 'Title is required.',
                );
                continue;
            }

            $type = sanitize_text_field( $item_data['type'] ?? 'book' );
            if ( ! in_array( $type, $allowed_types, true ) ) {
                $type = 'book';
            }

            $slug = sanitize_title( $title );
            // phpcs:ignore WordPress.DB.DirectDatabaseQuery.DirectQuery,WordPress.DB.DirectDatabaseQuery.NoCaching
            $existing_slug = $wpdb->get_var( $wpdb->prepare(
                "SELECT id FROM {$wpdb->prefix}jetreader_items WHERE slug = %s",
                $slug
            ) );
            if ( $existing_slug ) {
                $slug .= '-' . time() . '-' . $idx;
            }

            $visibility = sanitize_text_field( $item_data['visibility'] ?? 'publish' );
            $featured = ! empty( $item_data['featured'] ) ? 1 : 0;

            // Ensure authors / publishers exist if passed as text strings.
            $author = sanitize_text_field( $item_data['author'] ?? '' );
            $publisher = sanitize_text_field( $item_data['publisher'] ?? '' );
            if ( ! empty( $author ) ) {
                $author_names = array_filter( array_map( 'trim', explode( ',', $author ) ) );
                foreach ( $author_names as $auth_name ) {
                    if ( '' !== $auth_name ) {
                        $this->import_ensure_author( $auth_name );
                    }
                }
            }
            if ( ! empty( $publisher ) ) {
                $publisher_names = array_filter( array_map( 'trim', explode( ',', $publisher ) ) );
                foreach ( $publisher_names as $pub_name ) {
                    if ( '' !== $pub_name ) {
                        $this->import_ensure_publisher( $pub_name );
                    }
                }
            }

            $data = array(
                'type'             => $type,
                'title'            => $title,
                'slug'             => $slug,
                'description'      => wp_kses_post( $item_data['description'] ?? '' ),
                'cover_image'      => esc_url_raw( $item_data['cover_image'] ?? '' ),
                'file_path'        => sanitize_text_field( $item_data['file_path'] ?? '' ),
                'file_type'        => sanitize_text_field( $item_data['file_type'] ?? '' ),
                'language'         => sanitize_text_field( $item_data['language'] ?? 'en' ),
                'author'           => $author,
                'translator'       => sanitize_text_field( $item_data['translator'] ?? '' ),
                'publisher'        => $publisher,
                'isbn'             => sanitize_text_field( $item_data['isbn'] ?? '' ),
                'publication_year' => ! empty( $item_data['publication_year'] ) ? intval( $item_data['publication_year'] ) : null,
                'visibility'       => $visibility,
                'featured'         => $featured,
                'volumes'          => null,
            );

            // Validate file path
            if ( ! $this->validate_file_reference( $data['file_path'] ) ) {
                $failed++;
                $errors[] = array(
                    'row'     => $idx + 1,
                    'title'   => $title,
                    'message' => 'Invalid file path/URL or domain not allowed.',
                );
                continue;
            }

            // Handle volumes
            if ( ! empty( $item_data['volumes'] ) && is_array( $item_data['volumes'] ) ) {
                $clean_vols = array();
                $vols_valid = true;
                foreach ( array_values( $item_data['volumes'] ) as $vi => $vol ) {
                    $vol = (array) $vol;
                    if ( empty( $vol['file_path'] ) ) continue;
                    $vol_path = sanitize_text_field( $vol['file_path'] );
                    if ( ! $this->validate_file_reference( $vol_path ) ) {
                        $vols_valid = false;
                        $failed++;
                        $errors[] = array(
                            'row'     => $idx + 1,
                            'title'   => $title,
                            'message' => 'Invalid volume file path/URL or domain not allowed.',
                        );
                        break;
                    }

                    // Auto detect encoding for volume if text file.
                    $vol_type = sanitize_text_field( $vol['file_type'] ?? '' );
                    $vol_encoding = isset( $vol['encoding'] ) ? sanitize_text_field( $vol['encoding'] ) : 'utf-8';
                    if ( 'txt' === $vol_type && empty( $vol['encoding'] ) ) {
                        $local_path = JetReader_Upload_Handler::url_to_local_path( $vol_path );
                        if ( file_exists( $local_path ) ) {
                            $content_sample = file_get_contents( $local_path, false, null, 0, 10000 );
                            if ( function_exists( 'mb_detect_encoding' ) && $content_sample ) {
                                $enc = mb_detect_encoding( $content_sample, array( 'UTF-8', 'ISO-8859-9', 'Windows-1254', 'Windows-1251', 'ISO-8859-1', 'ASCII', 'UTF-16', 'UTF-16LE', 'UTF-16BE', 'BIG5', 'GBK', 'EUC-JP', 'SJIS' ), true );
                                if ( $enc ) {
                                    $vol_encoding = strtolower( $enc );
                                }
                            }
                        }
                    }

                    $clean_vols[] = array(
                        'vol'         => $vi + 1,
                        'file_path'   => $vol_path,
                        'file_type'   => $vol_type,
                        'cover_image' => esc_url_raw( $vol['cover_image'] ?? '' ),
                        'page_count'  => isset( $vol['page_count'] ) ? intval( $vol['page_count'] ) : 0,
                        'encoding'    => $vol_encoding,
                    );
                }
                if ( ! $vols_valid ) {
                    continue;
                }
                if ( ! empty( $clean_vols ) ) {
                    $data['volumes']     = wp_json_encode( $clean_vols );
                    $data['file_path']   = $clean_vols[0]['file_path'];
                    $data['file_type']   = $clean_vols[0]['file_type'];
                    $data['cover_image'] = $clean_vols[0]['cover_image'];
                }
            }

            // Detect encoding for single file TXT during bulk create
            $item_metadata = array();
            if ( ! empty( $data['file_path'] ) && 'txt' === $data['file_type'] ) {
                $local_path = JetReader_Upload_Handler::url_to_local_path( $data['file_path'] );
                if ( file_exists( $local_path ) ) {
                    $content_sample = file_get_contents( $local_path, false, null, 0, 10000 );
                    if ( function_exists( 'mb_detect_encoding' ) && $content_sample ) {
                        $enc = mb_detect_encoding( $content_sample, array( 'UTF-8', 'ISO-8859-9', 'Windows-1254', 'Windows-1251', 'ISO-8859-1', 'ASCII', 'UTF-16', 'UTF-16LE', 'UTF-16BE', 'BIG5', 'GBK', 'EUC-JP', 'SJIS' ), true );
                        if ( $enc ) {
                            $item_metadata['encoding'] = strtolower( $enc );
                        }
                    }
                }
            }
            $data['metadata'] = ! empty( $item_metadata ) ? wp_json_encode( $item_metadata ) : null;

            // Formats array for insert
            $formats = array();
            foreach ( $data as $value ) {
                $formats[] = is_null( $value ) ? '%s' : ( is_int( $value ) ? '%d' : '%s' );
            }

            // phpcs:ignore WordPress.DB.DirectDatabaseQuery.DirectQuery,WordPress.DB.DirectDatabaseQuery.NoCaching
            $result = $wpdb->insert( "{$wpdb->prefix}jetreader_items", $data, $formats );

            if ( false === $result ) {
                $failed++;
                $errors[] = array(
                    'row'     => $idx + 1,
                    'title'   => $title,
                    'message' => $wpdb->last_error ?: 'DB insert failed.',
                );
                continue;
            }

            $item_id = $wpdb->insert_id;
            $success++;

            // Sync category IDs (support category_names mapping)
            $category_names = isset( $item_data['category_names'] ) ? sanitize_text_field( $item_data['category_names'] ) : '';
            if ( ! empty( $category_names ) ) {
                $category_ids = $this->import_resolve_categories( $category_names, $type );
            } else {
                $category_ids = isset( $item_data['category_ids'] ) && is_array( $item_data['category_ids'] )
                    ? array_map( 'intval', $item_data['category_ids'] )
                    : array();
            }
            try {
                $this->sync_item_categories( $item_id, $category_ids, $type );
            } catch ( \Throwable $e ) {}

            // Sync CPT
            try {
                if ( class_exists( 'JetReader_CPT' ) ) {
                    JetReader_CPT::sync_from_item( $item_id );
                }
            } catch ( \Throwable $e ) {}
        }

        $this->invalidate_dashboard_cache();
        $this->invalidate_authors_cache();
        $this->invalidate_publishers_cache();
        $this->invalidate_categories_cache();
        $this->invalidate_permalink_cache();
        $this->invalidate_files_cache();

        return new WP_REST_Response( array(
            'success' => $success,
            'failed'  => $failed,
            'errors'  => $errors,
        ), 200 );
    }

    /**
     * Validate file path or URL references.
     */
    private function validate_file_reference( $file_path ) {
        if ( empty( $file_path ) ) {
            return true; // Empty path is valid (e.g. Article CPT without attachment).
        }

        // 1. Enforce allowed extension.
        $ext = strtolower( pathinfo( $file_path, PATHINFO_EXTENSION ) );
        if ( str_contains( $ext, '?' ) ) {
            $parsed_url_path = wp_parse_url( $file_path, PHP_URL_PATH );
            $ext = strtolower( pathinfo( $parsed_url_path, PATHINFO_EXTENSION ) );
        }
        if ( ! in_array( $ext, array( 'pdf', 'epub', 'txt', 'docx', 'doc' ), true ) ) {
            return false;
        }

        // 2. Local path check.
        if ( str_starts_with( $file_path, '/' ) || ! str_contains( $file_path, '://' ) ) {
            $upload_dir = wp_upload_dir();
            $base_dir   = realpath( $upload_dir['basedir'] );
            $real_path  = realpath( $file_path );
            if ( $real_path ) {
                if ( ! str_starts_with( $real_path, $base_dir ) ) {
                    return false; // Traversal / out of uploads folder.
                }
            } else {
                $base_dir_clean = str_replace( '\\', '/', $upload_dir['basedir'] );
                $file_path_clean = str_replace( '\\', '/', $file_path );
                if ( ! str_starts_with( $file_path_clean, $base_dir_clean ) ) {
                    return false;
                }
            }
            return true;
        }

        // 3. Remote URL check.
        $scheme = wp_parse_url( $file_path, PHP_URL_SCHEME );
        if ( ! in_array( $scheme, array( 'http', 'https' ), true ) ) {
            return false;
        }

        $host = wp_parse_url( $file_path, PHP_URL_HOST );
        if ( $host ) {
            // Allow files hosted on the current WordPress site (including localhost during dev).
            $site_host = wp_parse_url( site_url(), PHP_URL_HOST );
            if ( strcasecmp( $host, $site_host ) === 0 ) {
                return true;
            }

            $hosts_to_check = array();
            if ( filter_var( $host, FILTER_VALIDATE_IP ) ) {
                $hosts_to_check[] = $host;
            } else {
                $records = dns_get_record( $host, DNS_A | DNS_AAAA );
                if ( is_array( $records ) ) {
                    foreach ( $records as $record ) {
                        if ( isset( $record['ip'] ) ) {
                            $hosts_to_check[] = $record['ip'];
                        } elseif ( isset( $record['ipv6'] ) ) {
                            $hosts_to_check[] = $record['ipv6'];
                        }
                    }
                }
            }

            foreach ( $hosts_to_check as $resolved_ip ) {
                if ( $this->is_private_ip( $resolved_ip ) ) {
                    return false; // SSRF protection: block private/local hostnames.
                }
            }
        }

        return true;
    }


    /**
     * GET /files
     * List all files inside the jetreader uploads directory with their metadata and linked item statuses.
     */
    public function get_files( WP_REST_Request $request ): WP_REST_Response {
        $cache_key = 'jetreader_files_list';
        // phpcs:ignore WordPress.DB.DirectDatabaseQuery.NoCaching
        $cached = get_transient( $cache_key );
        if ( false !== $cached ) {
            return new WP_REST_Response( $cached, 200 );
        }

        $upload_dir    = wp_upload_dir();
        $jetreader_dir = $upload_dir['basedir'] . '/jetreader';

        if ( ! is_dir( $jetreader_dir ) ) {
            return new WP_REST_Response( array(), 200 );
        }

        // Search directory for all files
        $files = glob( $jetreader_dir . '/*' );
        if ( ! is_array( $files ) ) {
            return new WP_REST_Response( array(), 200 );
        }

        // Fetch all items from the database to map linkages
        global $wpdb;
        // phpcs:ignore WordPress.DB.DirectDatabaseQuery.DirectQuery,WordPress.DB.DirectDatabaseQuery.NoCaching
        $items = $wpdb->get_results(
            "SELECT id, title, type, file_path, cover_image, volumes FROM {$wpdb->prefix}jetreader_items",
            ARRAY_A
        );

        $result = array();

        foreach ( $files as $file_path ) {
            if ( ! is_file( $file_path ) ) {
                continue;
            }

            $filename  = basename( $file_path );
            $extension = strtolower( pathinfo( $file_path, PATHINFO_EXTENSION ) );
            $file_size = filesize( $file_path );
            $mod_time  = filemtime( $file_path );
            $file_url  = $upload_dir['baseurl'] . '/jetreader/' . $filename;

            // Check linked items
            $linked_items = array();
            foreach ( $items as $item ) {
                $is_linked = false;

                // Check standard file_path or cover_image fields
                if ( ! empty( $item['file_path'] ) && ( $item['file_path'] === $file_url || basename( $item['file_path'] ) === $filename ) ) {
                    $is_linked = true;
                }
                if ( ! empty( $item['cover_image'] ) && ( $item['cover_image'] === $file_url || basename( $item['cover_image'] ) === $filename ) ) {
                    $is_linked = true;
                }

                // Check volumes list JSON field
                if ( ! empty( $item['volumes'] ) ) {
                    $volumes = json_decode( $item['volumes'], true );
                    if ( is_array( $volumes ) ) {
                        foreach ( $volumes as $vol ) {
                            if ( ! empty( $vol['file_path'] ) && ( $vol['file_path'] === $file_url || basename( $vol['file_path'] ) === $filename ) ) {
                                $is_linked = true;
                                break;
                            }
                            if ( ! empty( $vol['cover_image'] ) && ( $vol['cover_image'] === $file_url || basename( $vol['cover_image'] ) === $filename ) ) {
                                $is_linked = true;
                                break;
                            }
                        }
                    }
                }

                if ( $is_linked ) {
                    $linked_items[] = array(
                        'id'    => intval( $item['id'] ),
                        'title' => $item['title'],
                        'type'  => $item['type']
                    );
                }
            }

            $result[] = array(
                'name'         => $filename,
                'url'          => $file_url,
                'extension'    => $extension,
                'size'         => $file_size,
                'modified'     => $mod_time,
                'linked_items' => $linked_items
            );
        }

        // Sort files by modified time descending (newest first)
        usort( $result, function( $a, $b ) {
            return $b['modified'] <=> $a['modified'];
        } );

        set_transient( $cache_key, $result, 5 * MINUTE_IN_SECONDS );

        return new WP_REST_Response( $result, 200 );
    }

    /**
     * DELETE /files
     * Delete one or more selected files from disk.
     */
    public function delete_files( WP_REST_Request $request ): WP_REST_Response {
        $filenames = $request->get_param( 'filenames' );
        if ( empty( $filenames ) ) {
            $single = $request->get_param( 'filename' );
            if ( ! empty( $single ) ) {
                $filenames = array( $single );
            }
        }

        if ( empty( $filenames ) || ! is_array( $filenames ) ) {
            return new WP_REST_Response(
                array( 'success' => false, 'message' => __( 'No filenames provided for deletion.', 'jetreader' ) ),
                400
            );
        }

        $upload_dir    = wp_upload_dir();
        $jetreader_dir = realpath( $upload_dir['basedir'] . '/jetreader' );
        if ( ! $jetreader_dir ) {
            $jetreader_dir = $upload_dir['basedir'] . '/jetreader';
        }
        $jetreader_dir_clean = str_replace( '\\', '/', $jetreader_dir );
        $success_count = 0;
        $failed_files  = array();

        foreach ( $filenames as $filename ) {
            $filename  = sanitize_file_name( $filename );
            $file_path = $jetreader_dir . '/' . $filename;

            $real_file_path = realpath( $file_path );
            if ( ! $real_file_path ) {
                $failed_files[] = $filename;
                continue;
            }

            $real_file_path_clean = str_replace( '\\', '/', $real_file_path );

            // Ensure the resolved path resides strictly within the JetReader uploads directory.
            if ( strpos( $real_file_path_clean, $jetreader_dir_clean ) !== 0 ) {
                $failed_files[] = $filename;
                continue;
            }

            if ( is_file( $real_file_path ) ) {
                // phpcs:ignore WordPress.WP.AlternativeFunctions.unlink_unlink
                if ( @unlink( $real_file_path ) ) {
                    $success_count++;
                } else {
                    $failed_files[] = $filename;
                }
            } else {
                $failed_files[] = $filename;
            }
        }

        if ( $success_count > 0 ) {
            // Invalidate CPT permalinks cache just in case we deleted files that were linked
            delete_transient( 'jetreader_cpt_permalink_map' );
            $this->invalidate_files_cache();
        }

        if ( count( $failed_files ) === 0 ) {
            return new WP_REST_Response(
                array( 'success' => true, 'message' => __( 'Selected files deleted successfully.', 'jetreader' ) ),
                200
            );
        } else {
            return new WP_REST_Response(
                array(
                    'success' => $success_count > 0,
                    /* translators: 1: number of deleted files, 2: number of files that failed to delete */
                    'message' => sprintf( __( 'Deleted %1$d files, failed to delete %2$d files.', 'jetreader' ), $success_count, count( $failed_files ) ),
                    'failed'  => $failed_files
                ),
                207 // Multi-Status
            );
        }
    }

    /**
     * PUT /files/rename
     * Rename a file on disk and update all database and metadata references.
     */
    public function rename_file( WP_REST_Request $request ): WP_REST_Response {
        $old_name = sanitize_file_name( $request->get_param( 'old_name' ) ?? '' );
        $new_name = sanitize_file_name( $request->get_param( 'new_name' ) ?? '' );

        if ( empty( $old_name ) || empty( $new_name ) ) {
            return new WP_REST_Response(
                array( 'success' => false, 'message' => __( 'Both old and new file names are required.', 'jetreader' ) ),
                400
            );
        }

        if ( $old_name === $new_name ) {
            return new WP_REST_Response(
                array( 'success' => false, 'message' => __( 'New file name must be different.', 'jetreader' ) ),
                400
            );
        }

        $upload_dir    = wp_upload_dir();
        $jetreader_dir = realpath( $upload_dir['basedir'] . '/jetreader' );
        if ( ! $jetreader_dir ) {
            $jetreader_dir = $upload_dir['basedir'] . '/jetreader';
        }
        $jetreader_dir_clean = str_replace( '\\', '/', $jetreader_dir );

        $old_path = $jetreader_dir . '/' . $old_name;
        $new_path = $jetreader_dir . '/' . $new_name;

        $real_old_path = realpath( $old_path );
        if ( ! $real_old_path ) {
            return new WP_REST_Response(
                array( 'success' => false, 'message' => __( 'Source file does not exist.', 'jetreader' ) ),
                404
            );
        }

        $real_old_path_clean = str_replace( '\\', '/', $real_old_path );
        $new_path_clean      = str_replace( '\\', '/', $new_path );

        // Ensure the source file and new path both reside strictly within the JetReader uploads directory.
        if ( strpos( $real_old_path_clean, $jetreader_dir_clean ) !== 0 || strpos( $new_path_clean, $jetreader_dir_clean ) !== 0 ) {
            return new WP_REST_Response(
                array( 'success' => false, 'message' => __( 'Access denied outside the uploads folder.', 'jetreader' ) ),
                403
            );
        }

        if ( ! is_file( $real_old_path ) ) {
            return new WP_REST_Response(
                array( 'success' => false, 'message' => __( 'Source is not a file.', 'jetreader' ) ),
                400
            );
        }

        if ( file_exists( $new_path ) ) {
            return new WP_REST_Response(
                array( 'success' => false, 'message' => __( 'A file with the new name already exists.', 'jetreader' ) ),
                409
            );
        }

        // phpcs:ignore WordPress.WP.AlternativeFunctions.rename_rename
        $renamed = @rename( $real_old_path, $new_path );

        if ( ! $renamed ) {
            return new WP_REST_Response(
                array( 'success' => false, 'message' => __( 'Failed to rename file on disk.', 'jetreader' ) ),
                500
            );
        }

        // Update database references
        global $wpdb;
        $old_url = $upload_dir['baseurl'] . '/jetreader/' . $old_name;
        $new_url = $upload_dir['baseurl'] . '/jetreader/' . $new_name;

        // 1. Update items table file_path and cover_image
        // phpcs:ignore WordPress.DB.DirectDatabaseQuery.DirectQuery,WordPress.DB.DirectDatabaseQuery.NoCaching
        $wpdb->query( $wpdb->prepare(
            "UPDATE {$wpdb->prefix}jetreader_items SET file_path = %s WHERE file_path = %s",
            $new_url,
            $old_url
        ) );
        // phpcs:ignore WordPress.DB.DirectDatabaseQuery.DirectQuery,WordPress.DB.DirectDatabaseQuery.NoCaching
        $wpdb->query( $wpdb->prepare(
            "UPDATE {$wpdb->prefix}jetreader_items SET cover_image = %s WHERE cover_image = %s",
            $new_url,
            $old_url
        ) );

        // 2. Fetch all items with volumes to check inside JSON fields
        // phpcs:ignore WordPress.DB.DirectDatabaseQuery.DirectQuery,WordPress.DB.DirectDatabaseQuery.NoCaching
        $items_with_vols = $wpdb->get_results(
            "SELECT id, volumes FROM {$wpdb->prefix}jetreader_items WHERE volumes IS NOT NULL AND volumes != ''",
            ARRAY_A
        );

        foreach ( $items_with_vols as $item ) {
            $volumes = json_decode( $item['volumes'], true );
            if ( ! is_array( $volumes ) ) {
                continue;
            }

            $updated = false;
            foreach ( $volumes as &$vol ) {
                if ( ! empty( $vol['file_path'] ) && ( $vol['file_path'] === $old_url || basename( $vol['file_path'] ) === $old_name ) ) {
                    $vol['file_path'] = $new_url;
                    $updated = true;
                }
                if ( ! empty( $vol['cover_image'] ) && ( $vol['cover_image'] === $old_url || basename( $vol['cover_image'] ) === $old_name ) ) {
                    $vol['cover_image'] = $new_url;
                    $updated = true;
                }
            }

            if ( $updated ) {
                // phpcs:ignore WordPress.DB.DirectDatabaseQuery.DirectQuery,WordPress.DB.DirectDatabaseQuery.NoCaching
                $wpdb->query( $wpdb->prepare(
                    "UPDATE {$wpdb->prefix}jetreader_items SET volumes = %s WHERE id = %d",
                    wp_json_encode( $volumes ),
                    $item['id']
                ) );
            }
        }

        // 3. Update related CPT posts meta if any
        // phpcs:ignore WordPress.DB.DirectDatabaseQuery.DirectQuery,WordPress.DB.DirectDatabaseQuery.NoCaching
        $wpdb->query( $wpdb->prepare(
            "UPDATE {$wpdb->postmeta} SET meta_value = %s WHERE meta_key = '_jetreader_file_url' AND meta_value = %s",
            $new_url,
            $old_url
        ) );
        // phpcs:ignore WordPress.DB.DirectDatabaseQuery.DirectQuery,WordPress.DB.DirectDatabaseQuery.NoCaching
        $wpdb->query( $wpdb->prepare(
            "UPDATE {$wpdb->postmeta} SET meta_value = %s WHERE meta_key = '_jetreader_cover_url' AND meta_value = %s",
            $new_url,
            $old_url
        ) );

        // Invalidate permalink cache and files list cache
        delete_transient( 'jetreader_cpt_permalink_map' );
        $this->invalidate_files_cache();

        return new WP_REST_Response(
            array(
                'success'   => true,
                'message'   => __( 'File renamed and references updated successfully.', 'jetreader' ),
                'new_name'  => $new_name,
                'new_url'   => $new_url
            ),
            200
        );
    }

    /**
     * POST /files/clean-unused
     * Scan and delete all orphan files from the jetreader uploads directory.
     */
    public function clean_unused_files( WP_REST_Request $request ): WP_REST_Response {
        $upload_dir    = wp_upload_dir();
        $jetreader_dir = $upload_dir['basedir'] . '/jetreader';

        if ( ! is_dir( $jetreader_dir ) ) {
            return new WP_REST_Response(
                array( 'success' => true, 'deleted_count' => 0, 'deleted_size' => 0, 'message' => __( 'No JetReader uploads directory exists.', 'jetreader' ) ),
                200
            );
        }

        $files = glob( $jetreader_dir . '/*' );
        if ( ! is_array( $files ) ) {
            return new WP_REST_Response(
                array( 'success' => true, 'deleted_count' => 0, 'deleted_size' => 0, 'message' => __( 'No files found to clean.', 'jetreader' ) ),
                200
            );
        }

        global $wpdb;
        // phpcs:ignore WordPress.DB.DirectDatabaseQuery.DirectQuery,WordPress.DB.DirectDatabaseQuery.NoCaching
        $items = $wpdb->get_results(
            "SELECT file_path, cover_image, volumes FROM {$wpdb->prefix}jetreader_items",
            ARRAY_A
        );

        $used_files = array();
        foreach ( $items as $item ) {
            if ( ! empty( $item['file_path'] ) ) {
                $used_files[ basename( $item['file_path'] ) ] = true;
            }
            if ( ! empty( $item['cover_image'] ) ) {
                $used_files[ basename( $item['cover_image'] ) ] = true;
            }
            if ( ! empty( $item['volumes'] ) ) {
                $volumes = json_decode( $item['volumes'], true );
                if ( is_array( $volumes ) ) {
                    foreach ( $volumes as $vol ) {
                        if ( ! empty( $vol['file_path'] ) ) {
                            $used_files[ basename( $vol['file_path'] ) ] = true;
                        }
                        if ( ! empty( $vol['cover_image'] ) ) {
                            $used_files[ basename( $vol['cover_image'] ) ] = true;
                        }
                    }
                }
            }
        }

        $deleted_count = 0;
        $deleted_size  = 0;
        $failed_files  = array();

        foreach ( $files as $file_path ) {
            if ( ! is_file( $file_path ) ) {
                continue;
            }

            $filename = basename( $file_path );
            
            // If it's not in the used list, delete it!
            if ( ! isset( $used_files[ $filename ] ) ) {
                $size = filesize( $file_path );
                // phpcs:ignore WordPress.WP.AlternativeFunctions.unlink_unlink
                if ( @unlink( $file_path ) ) {
                    $deleted_count++;
                    $deleted_size += $size;
                } else {
                    $failed_files[] = $filename;
                }
            }
        }

        if ( $deleted_count > 0 ) {
            delete_transient( 'jetreader_cpt_permalink_map' );
            $this->invalidate_files_cache();
        }

        return new WP_REST_Response(
            array(
                'success' => true,
                'deleted_count' => $deleted_count,
                'deleted_size' => $deleted_size,
                'failed_files' => $failed_files,
                'message' => sprintf(
                    /* translators: 1: number of deleted files, 2: human readable size */
                    __( 'Cleaned %1$d unused files (%2$s).', 'jetreader' ),
                    $deleted_count,
                    size_format( $deleted_size )
                )
            ),
            200
        );
    }

    /**
     * Sanitize a position array before JSON encoding.
     *
     * @param mixed $position The raw position data.
     * @return array Sanitized position.
     */
    private function sanitize_position( $position ) {
        if ( ! is_array( $position ) ) {
            return array();
        }

        $sanitized = array();
        $int_keys  = array( 'pageIndex', 'charOffset', 'startOffset', 'endOffset', 'nodeIndex', 'paragraphIndex', 'spineIndex' );
        $str_keys  = array( 'fragmentId', 'anchor', 'selector', 'cfi' );

        foreach ( $position as $key => $val ) {
            if ( in_array( $key, $int_keys, true ) ) {
                $sanitized[ $key ] = absint( $val );
            } elseif ( in_array( $key, $str_keys, true ) ) {
                $sanitized[ $key ] = sanitize_text_field( $val );
            }
        }

        return $sanitized;
    }

    /**
     * Convert a local file path to a URL if it points to the uploads folder.
     * If it's already a URL, return it as is.
     *
     * @param string $path_or_url The local path or URL.
     * @return string Normalized URL or empty string.
     */
    private function ensure_public_url( $path_or_url ) {
        if ( empty( $path_or_url ) ) {
            return '';
        }

        // If it starts with http/https or is a scheme-relative URL, it's already a URL.
        if ( preg_match( '#^(https?:)?//#i', $path_or_url ) ) {
            return $path_or_url;
        }

        // Check if it's a local absolute path within the WordPress uploads directory.
        $upload_dir = wp_upload_dir();
        $base_dir   = rtrim( str_replace( '\\', '/', realpath( $upload_dir['basedir'] ) ), '/' );
        $base_url   = rtrim( $upload_dir['baseurl'], '/' );

        $clean_path = str_replace( '\\', '/', realpath( $path_or_url ) ?: $path_or_url );

        if ( strpos( $clean_path, $base_dir ) === 0 ) {
            return $base_url . substr( $clean_path, strlen( $base_dir ) );
        }

        // If it is a relative path starting with wp-content/uploads/
        if ( strpos( $clean_path, 'wp-content/uploads/' ) !== false ) {
            $site_url = rtrim( get_site_url(), '/' );
            return $site_url . '/' . substr( $clean_path, strpos( $clean_path, 'wp-content/uploads/' ) );
        }

        // Do not return local absolute path to prevent information leakage.
        return '';
    }

    /**
     * Intercept and output binary response for our /proxy route using the standard WordPress hook.
     * Prevents raw exit and direct output alerts from WP.org Plugin Check.
     */
    public function serve_binary_proxy_response( $served, $result, $request, $server ) {
        if ( '/' . $this->namespace . '/proxy' === $request->get_route() ) {
            if ( is_wp_error( $result ) ) {
                return $served;
            }

            $headers = $result->get_headers();
            $data    = $result->get_data();

            foreach ( $headers as $key => $value ) {
                $server->send_header( $key, $value );
            }

            $server->send_status( $result->get_status() );

            // Output raw binary or plain text body securely.
            // 
            // MULTI-LAYERED SECURITY IN PLACE:
            // 1. Allowed file formats are restricted to: pdf, epub, docx, txt.
            // 2. Strict permission checks filter access (admins or exact match against public library item URLs).
            // 3. SSRF mitigation intercepts internal/private/reserved IP addresses.
            // 4. Content-Type and URL extension validations ensure file integrity.
            // 5. Browser-level XSS prevention is enforced using:
            //    - Content-Security-Policy: default-src 'none'; sandbox;
            //    - X-Content-Type-Options: nosniff
            //
            // WHY ESCAPING IS NOT APPLICABLE:
            // - Binary files (PDF, EPUB, DOCX): Escaping binary data corrupts the file stream, making files unreadable.
            // - Plain Text files (TXT): Escaping raw text (e.g. with esc_html) translates characters like '<', '>', '&' into HTML entities (e.g. &lt;), causing corruption when rendered in the client-side reader (since client renders txt dynamically as text nodes).
            //
            // phpcs:ignore WordPress.Security.EscapeOutput.OutputNotEscaped -- binary/text content, escaping corrupts file data.
            echo $data;

            return true; // Stop standard REST response processing.
        }
        return $served;
    }
}