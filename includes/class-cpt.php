<?php
/**
 * Custom Post Type registration, sync, SEO, and WordPress native search integration.
 *
 * @package JetReader
 */

if ( ! defined( 'WPINC' ) ) {
    die;
}

/**
 * Class JetReader_CPT
 *
 * Manages the four JetReader CPTs and their connection to the items table.
 * Each CPT post mirrors one jetreader_items row so WordPress features
 * (native search, sitemap, SEO plugins, theme templates) work out of the box.
 */
class JetReader_CPT {

    /**
     * Maps item type → CPT slug + default rewrite slug + admin label.
     *
     * @var array<string, array{slug: string, rewrite: string, label: string, schema: string}>
     */
    private static array $type_map = array(
        'book'     => array( 'slug' => 'jetreader_book',     'rewrite' => 'jetreader-books',    'label' => 'Books',    'schema' => 'Book' ),
        'article'  => array( 'slug' => 'jetreader_article',  'rewrite' => 'jetreader-articles', 'label' => 'Articles', 'schema' => 'Article' ),
        'magazine' => array( 'slug' => 'jetreader_magazine', 'rewrite' => 'jetreader-magazines','label' => 'Magazines','schema' => 'Periodical' ),
        'qa'       => array( 'slug' => 'jetreader_qa',       'rewrite' => 'jetreader-qa',       'label' => 'Q&A',      'schema' => 'QAPage' ),
    );

    // -------------------------------------------------------------------------
    // Registration
    // -------------------------------------------------------------------------

    /**
     * Register all four CPTs. Called on 'init' hook.
     */
    public static function register(): void {
        $settings = get_option( 'jetreader_settings', array() );
        $locale   = $settings['plugin_language'] ?? 'en';
        $trans    = jetreader_get_translations( $locale );
        $tb       = static function ( $key ) use ( $trans ) {
            return $trans['cpt'][ $key ] ?? $key;
        };

        foreach ( self::$type_map as $type => $def ) {
            $rewrite = $def['rewrite'];

            // Labels ARE translated (only shown in admin screens / REST).
            $label = $tb( 'label_' . $type ) ?: $def['label'];

            register_post_type(
                $def['slug'],
                array(
                    'labels'          => array(
                        'name'               => $label,
                        'singular_name'      => $label,
                        'add_new_item'       => sprintf( '%s %s', $tb( 'addNew' ) ?: 'Add New', $label ),
                        'edit_item'          => sprintf( '%s %s', $tb( 'edit' ) ?: 'Edit', $label ),
                        'view_item'          => sprintf( '%s %s', $tb( 'view' ) ?: 'View', $label ),
                        'search_items'       => sprintf( '%s %s', $tb( 'searchLabel' ) ?: 'Search', $label ),
                        'not_found'          => $tb( 'notFound' ) ?: 'Not found',
                        'not_found_in_trash' => $tb( 'notFoundTrash' ) ?: 'Not found in Trash',
                    ),
                    'public'              => true,
                    'exclude_from_search' => true,
                    'show_ui'             => false,
                    'show_in_menu'        => false,
                    'show_in_rest'        => true,
                    // Archive disabled: /books/ should not list all books.
                    // Individual post URLs (/books/title/) still work.
                    'has_archive'         => false,
                    'rewrite'             => array( 'slug' => $rewrite, 'with_front' => false ),
                    'supports'            => array( 'title', 'editor', 'thumbnail', 'excerpt', 'custom-fields' ),
                    'capability_type'     => 'post',
                    'map_meta_cap'        => true,
                    'show_in_nav_menus'   => true,
                    'query_var'           => true,
                )
            );
        }

        // Auto-flush rewrite rules once after CPT registration if they're stale.
        add_action( 'init', array( __CLASS__, 'maybe_flush_rewrites' ), 999 );

        add_filter( 'template_include',  array( __CLASS__, 'reader_template' ), 99999 );
        add_action( 'wp_head',            array( __CLASS__, 'output_seo_head' ) );

    }

    /**
     * Flush rewrite rules once after any CPT slug change.
     * Compares the current registered slugs against the last-flushed snapshot
     * stored in an option. Runs at priority 999 on 'init' so all CPTs are
     * registered before we compare.
     */
     public static function maybe_flush_rewrites(): void {
          $current = array();
          foreach ( self::$type_map as $type => $def ) {
               $current[ $type ] = $def['rewrite'];
          }

          $stored = get_option( 'jetreader_cpt_slugs', array() );

          // Check if rewrite rules are actually registered in WordPress.
          $permalink_structure = get_option( 'permalink_structure' );
          $rules_exist         = false;
          if ( ! empty( $permalink_structure ) ) {
              $rules = get_option( 'rewrite_rules' );
              if ( is_array( $rules ) ) {
                  $first_slug = reset( $current );
                  if ( $first_slug ) {
                      foreach ( $rules as $rule => $rewrite ) {
                          if ( str_contains( $rule, $first_slug ) ) {
                              $rules_exist = true;
                              break;
                          }
                      }
                  }
              }
          } else {
              // Plain permalinks are active, pretty rules don't exist by design.
              $rules_exist = true;
          }

          if ( $stored !== $current || ! $rules_exist ) {
              flush_rewrite_rules( false );
              update_option( 'jetreader_cpt_slugs', $current, false );
          }
     }

    // -------------------------------------------------------------------------
    // CPT ↔ Item sync
    // -------------------------------------------------------------------------

    /**
     * Create or update the CPT post that mirrors a jetreader_items row.
     */
    public static function sync_from_item( int $item_id ): int {
        global $wpdb;

        // phpcs:ignore WordPress.DB.DirectDatabaseQuery.DirectQuery, WordPress.DB.DirectDatabaseQuery.NoCaching, WordPress.DB.PreparedSQL.InterpolatedNotPrepared
        $item = $wpdb->get_row( $wpdb->prepare(
            "SELECT * FROM {$wpdb->prefix}jetreader_items WHERE id = %d",
            $item_id
        ) );

        if ( ! $item ) {
            return 0;
        }

        $post_id  = self::get_post_id_by_item( $item_id );
        $cpt_slug = self::get_cpt_slug( $item->type ?? 'book' );
        $status   = 'publish' === ( $item->visibility ?? 'publish' ) ? 'publish' : 'draft';

        $post_data = array(
            'post_title'   => wp_strip_all_tags( $item->title ),
            'post_name'    => $item->slug,
            'post_status'  => $status,
            'post_type'    => $cpt_slug,
            'post_content' => wp_kses_post( $item->description ?? '' ),
            'post_excerpt' => wp_trim_words( wp_strip_all_tags( $item->description ?? '' ), 30 ),
        );

        if ( $post_id ) {
            $post_data['ID'] = $post_id;
            $result = wp_update_post( $post_data, true );
            if ( is_wp_error( $result ) ) {
                return 0;
            }
        } else {
            $result = wp_insert_post( $post_data, true );
            if ( is_wp_error( $result ) ) {
                return 0;
            }
            $post_id = $result;
        }

        // Store meta.
        update_post_meta( $post_id, '_jetreader_item_id',   $item_id );
        update_post_meta( $post_id, '_jetreader_file_url',  esc_url_raw( $item->file_path ?? '' ) );
        update_post_meta( $post_id, '_jetreader_format',    sanitize_key( $item->file_type ?? '' ) );
        update_post_meta( $post_id, '_jetreader_item_type', sanitize_key( $item->type ?? 'book' ) );
        update_post_meta( $post_id, '_jetreader_cover_url', esc_url_raw( $item->cover_image ?? '' ) );
        update_post_meta( $post_id, '_jetreader_author',    sanitize_text_field( $item->author ?? '' ) );
        update_post_meta( $post_id, '_jetreader_volumes',   $item->volumes ?? '' );

        $encoding = 'utf-8';
        if ( ! empty( $item->metadata ) ) {
            $meta = json_decode( $item->metadata, true );
            if ( is_array( $meta ) && isset( $meta['encoding'] ) ) {
                $encoding = sanitize_text_field( $meta['encoding'] );
            }
        }
        update_post_meta( $post_id, '_jetreader_encoding', $encoding );

        // Handle featured thumbnail via cover image URL.
        if ( ! empty( $item->cover_image ) && ! has_post_thumbnail( $post_id ) ) {
            self::maybe_set_thumbnail_from_url( $post_id, $item->cover_image );
        }

        return $post_id;
    }

    /**
     * Delete the CPT post when an item is deleted.
     */
    public static function delete_by_item( int $item_id ): void {
        $post_id = self::get_post_id_by_item( $item_id );
        if ( $post_id ) {
            wp_delete_post( $post_id, true );
        }
    }

    /**
     * Get the CPT post_id associated with a given item_id.
     */
    public static function get_post_id_by_item( int $item_id ): int {
        // phpcs:disable WordPress.DB.SlowDBQuery.slow_db_query_meta_key, WordPress.DB.SlowDBQuery.slow_db_query_meta_value
        $posts = get_posts( array(
            'post_type'      => array_column( self::$type_map, 'slug' ),
            'post_status'    => array( 'publish', 'draft', 'private', 'pending', 'future', 'trash' ),
            'meta_key'       => '_jetreader_item_id',
            'meta_value'     => $item_id,
            'meta_compare'   => '=',
            'posts_per_page' => 1,
            'fields'         => 'ids',
            'no_found_rows'  => true,
        ) );
        // phpcs:enable WordPress.DB.SlowDBQuery.slow_db_query_meta_key, WordPress.DB.SlowDBQuery.slow_db_query_meta_value

        return ! empty( $posts ) ? (int) $posts[0] : 0;
    }

    /**
     * Get the public permalink for an item.
     */
    public static function get_permalink_by_item( int $item_id ): string {
        $post_id = self::get_post_id_by_item( $item_id );
        return $post_id ? (string) get_permalink( $post_id ) : '';
    }

    /**
     * Return the CPT slug for a given item type.
     */
    public static function get_cpt_slug( string $item_type ): string {
        return self::$type_map[ $item_type ]['slug'] ?? 'jetreader_book';
    }

    /**
     * Return all registered CPT slugs.
     *
     * @return string[]
     */
    public static function get_all_cpt_slugs(): array {
        return array_column( self::$type_map, 'slug' );
    }

    /**
     * Flush rewrite rules once after activation.
     */
    public static function flush_once(): void {
        if ( ! get_option( 'jetreader_rewrite_flushed_v2' ) ) {
            flush_rewrite_rules();
            update_option( 'jetreader_rewrite_flushed_v2', '1' );
        }
    }

    // -------------------------------------------------------------------------
    // Template
    // -------------------------------------------------------------------------

    /**
     * Route CPT singular pages to the reader template.
     */
    public static function reader_template( string $template ): string {
        if ( ! is_singular( self::get_all_cpt_slugs() ) ) {
            return $template;
        }

        // Allow theme to override: place single-jetreader_book.php in the theme folder.
        $theme_override = locate_template( array(
            'single-' . get_post_type() . '.php',
            'single-jetreader.php',
        ) );

        if ( $theme_override ) {
            return $theme_override;
        }

        $plugin_template = JETREADER_PLUGIN_DIR . 'templates/single-reader.php';
        if ( file_exists( $plugin_template ) ) {
            return $plugin_template;
        }

        return $template;
    }


    // -------------------------------------------------------------------------
    // SEO
    // -------------------------------------------------------------------------

    /**
     * Output Schema.org + Open Graph + Canonical tags for CPT singular pages.
     * Skipped if a SEO plugin (Yoast, RankMath, AIOSEO) is already handling it.
     */
    public static function output_seo_head(): void {
        if ( ! is_singular( self::get_all_cpt_slugs() ) ) {
            return;
        }

        // Let popular SEO plugins take over.
        if ( defined( 'WPSEO_VERSION' ) || defined( 'RANK_MATH_VERSION' ) || defined( 'AIOSEO_VERSION' ) ) {
            return;
        }

        $post_id     = get_the_ID();
        $cover       = get_post_meta( $post_id, '_jetreader_cover_url', true );
        $author      = get_post_meta( $post_id, '_jetreader_author',    true );
        $cpt         = get_post_type();
        $schema_type = self::$type_map[ array_search( $cpt, array_column( self::$type_map, 'slug' ), true ) ]['schema'] ?? 'CreativeWork';

        $schema = array(
            '@context'    => 'https://schema.org',
            '@type'       => $schema_type,
            'name'        => esc_html( get_the_title() ),
            'description' => esc_html( get_the_excerpt() ),
            'url'         => esc_url( get_permalink() ),
        );

        if ( $author ) {
            $schema['author'] = array( '@type' => 'Person', 'name' => esc_html( $author ) );
        }
        if ( $cover ) {
            $schema['image'] = esc_url( $cover );
        }

        $page_count = get_post_meta( $post_id, '_jetreader_page_count', true );
        if ( $page_count ) {
            $schema['numberOfPages'] = (int) $page_count;
        }

        wp_print_inline_script_tag(
            wp_json_encode( $schema, JSON_HEX_TAG | JSON_HEX_AMP | JSON_HEX_APOS | JSON_HEX_QUOT | JSON_UNESCAPED_UNICODE ),
            array( 'type' => 'application/ld+json' )
        );

        // Open Graph.
        echo '<meta property="og:type"  content="book" />' . "\n";
        echo '<meta property="og:title" content="' . esc_attr( get_the_title() ) . '" />' . "\n";
        echo '<meta property="og:url"   content="' . esc_url( get_permalink() ) . '" />' . "\n";
        echo '<meta property="og:description" content="' . esc_attr( get_the_excerpt() ) . '" />' . "\n";
        if ( $cover ) {
            echo '<meta property="og:image" content="' . esc_url( $cover ) . '" />' . "\n";
        }

        // Canonical.
        echo '<link rel="canonical" href="' . esc_url( get_permalink() ) . '" />' . "\n";
    }

    // -------------------------------------------------------------------------
    // Helpers
    // -------------------------------------------------------------------------

    /**
     * Attempt to set a post thumbnail from a remote/local image URL.
     * Only runs if the function exists (WP media functions loaded).
     */
    private static function maybe_set_thumbnail_from_url( int $post_id, string $url ): void {
        // Only handle absolute HTTP/HTTPS URLs; skip relative paths.
        if ( 0 !== strpos( $url, 'http' ) ) {
            return;
        }

        $clean_url = esc_url_raw( $url );

        // If the URL already belongs to a media library attachment, reuse it
        // directly — no re-download, no duplicate file.
        $existing_id = attachment_url_to_postid( $clean_url );
        if ( $existing_id ) {
            set_post_thumbnail( $post_id, $existing_id );
            return;
        }

        // URL is external or not registered in the media library — sideload it.
        if ( ! function_exists( 'media_sideload_image' ) ) {
            require_once ABSPATH . 'wp-admin/includes/media.php';
            require_once ABSPATH . 'wp-admin/includes/file.php';
            require_once ABSPATH . 'wp-admin/includes/image.php';
        }

        $attachment_id = media_sideload_image( $clean_url, $post_id, '', 'id' );
        if ( ! is_wp_error( $attachment_id ) ) {
            set_post_thumbnail( $post_id, $attachment_id );
        }
    }

    /**
     * Migrate all existing items to CPT posts (called from activator + admin action).
     */
    public static function migrate_all(): void {
        global $wpdb;

        if ( get_option( 'jetreader_cpt_migrated' ) ) {
            return;
        }

        // phpcs:ignore WordPress.DB.DirectDatabaseQuery.DirectQuery, WordPress.DB.DirectDatabaseQuery.NoCaching, WordPress.DB.PreparedSQL.InterpolatedNotPrepared
        $ids = $wpdb->get_col( "SELECT id FROM {$wpdb->prefix}jetreader_items" );
        foreach ( $ids as $id ) {
            self::sync_from_item( (int) $id );
        }

        update_option( 'jetreader_cpt_migrated', '1' );
    }

    /**
     * Force re-migrate (called from admin "Sync CPT" button via REST endpoint).
     */
    public static function force_migrate_all(): int {
        global $wpdb;

        // phpcs:ignore WordPress.DB.DirectDatabaseQuery.DirectQuery, WordPress.DB.DirectDatabaseQuery.NoCaching, WordPress.DB.PreparedSQL.InterpolatedNotPrepared
        $ids   = $wpdb->get_col( "SELECT id FROM {$wpdb->prefix}jetreader_items" );
        $count = 0;
        foreach ( $ids as $id ) {
            if ( self::sync_from_item( (int) $id ) ) {
                $count++;
            }
        }

        update_option( 'jetreader_cpt_migrated', '1' );
        return $count;
    }
}
