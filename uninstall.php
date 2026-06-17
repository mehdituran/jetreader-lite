<?php
/**
 * Fired when the plugin is deleted from WordPress admin.
 *
 * Removes ALL plugin data: custom tables, CPT posts, options, transients,
 * scheduled cron events, and uploaded files — without touching any other
 * plugin or theme data.
 *
 * Multisite-aware: on network installs, iterates all subsites.
 *
 * @package JetReader
 */

// phpcs:disable WordPress.DB.DirectDatabaseQuery

// WordPress calls this file directly; abort if accessed outside that context.
if ( ! defined( 'WP_UNINSTALL_PLUGIN' ) ) {
    die;
}

/**
 * Perform all cleanup for a single blog/site.
 * Called once on single-site or once per subsite on multisite.
 */
function jetreader_uninstall_site(): void {
    global $wpdb;

    // ── 1. Drop all custom database tables ─────────────────────────────────────
    // Child tables first to avoid FK issues on strict servers.
    // Includes both current (jetreader_*) and legacy (lector_*) table names.
    $tables = array(
        // Current jetreader_* tables.
        'jetreader_search_index',
        'jetreader_notes',
        'jetreader_bookmarks',
        'jetreader_user_preferences',
        'jetreader_item_tags',
        'jetreader_item_categories',
        'jetreader_tags',
        'jetreader_categories',
        'jetreader_chapters',
        'jetreader_authors',
        'jetreader_publishers',
        'jetreader_items',
        // Legacy lector_* tables from the pre-rename version.
        'lector_search_index',
        'lector_notes',
        'lector_bookmarks',
        'lector_user_preferences',
        'lector_item_tags',
        'lector_item_categories',
        'lector_tags',
        'lector_categories',
        'lector_chapters',
        'lector_authors',
        'lector_publishers',
        'lector_items',
    );

    foreach ( $tables as $table ) {
        // phpcs:ignore WordPress.DB.DirectDatabaseQuery.NoCaching, WordPress.DB.DirectDatabaseQuery.SchemaChange, WordPress.DB.PreparedSQL.InterpolatedNotPrepared
        $wpdb->query( "DROP TABLE IF EXISTS `{$wpdb->prefix}{$table}`" );
    }

    // ── 2. Delete all CPT posts created by JetReader ───────────────────────────
    // Includes current (jetreader_*) and legacy (lector_*) post types.
    // wp_delete_post( $id, true ) also removes all associated post meta automatically.
    $cpt_slugs = array(
        'jetreader_book', 'jetreader_article', 'jetreader_magazine', 'jetreader_qa',
        'lector_book',    'lector_article',    'lector_magazine',    'lector_qa',
    );

    foreach ( $cpt_slugs as $cpt ) {
        // phpcs:ignore WordPress.DB.DirectDatabaseQuery.NoCaching, WordPress.DB.DirectDatabaseQuery.DirectQuery
        $post_ids = $wpdb->get_col(
            $wpdb->prepare(
                "SELECT ID FROM {$wpdb->posts} WHERE post_type = %s",
                $cpt
            )
        );

        foreach ( $post_ids as $post_id ) {
            wp_delete_post( (int) $post_id, true );
        }
    }

    // ── 3. Delete plugin options ────────────────────────────────────────────────
    $options = array(
        // Current jetreader_* options.
        'jetreader_settings',
        'jetreader_db_version',
        'jetreader_cpt_slugs',
        'jetreader_cpt_migrated',
        'jetreader_rewrite_flushed_v2',
        'jetreader_license_key',
        'jetreader_license_status',
        'jetreader_license_expires',
        'jetreader_license_instance_id',
        'jetreader_edition',
        // Legacy lector_* options from the pre-rename version.
        'lector_settings',
        'lector_db_version',
        'lector_cpt_slugs',
        'lector_cpt_migrated',
        'lector_rewrite_flushed_v2',
        'lector_license_key',
        'lector_license_status',
        'lector_license_expires',
        'lector_license_instance_id',
    );

    foreach ( $options as $option ) {
        delete_option( $option );
    }

    // ── 4. Delete transients (named + wildcard patterns) ────────────────────────
    $named_transients = array(
        'jetreader_dashboard_stats',
        'jetreader_authors_list_admin',
        'jetreader_authors_list_public',
        'jetreader_publishers_list_admin',
        'jetreader_publishers_list_public',
    );

    foreach ( $named_transients as $t ) {
        delete_transient( $t );
    }

    $patterns = array(
        '_transient_jetreader_%',
        '_transient_timeout_jetreader_%',
        '_transient_jr_%',
        '_transient_timeout_jr_%',
        // Legacy lector_* transients from the pre-rename version.
        '_transient_lector_%',
        '_transient_timeout_lector_%',
    );

    foreach ( $patterns as $pattern ) {
        // phpcs:ignore WordPress.DB.DirectDatabaseQuery.NoCaching, WordPress.DB.DirectDatabaseQuery.DirectQuery
        $wpdb->query(
            $wpdb->prepare(
                "DELETE FROM {$wpdb->options} WHERE option_name LIKE %s",
                $pattern
            )
        );
    }

    // ── 5. Clear scheduled WP-Cron events ──────────────────────────────────────
    // Current jetreader_* events.
    wp_clear_scheduled_hook( 'jetreader_process_queue' );
    wp_clear_scheduled_hook( 'jetreader_cleanup_temp' );
    // Legacy lector_* events from the pre-rename version.
    wp_clear_scheduled_hook( 'lector_process_queue' );
    wp_clear_scheduled_hook( 'lector_cleanup_temp' );

    // ── 6. Delete uploaded files ────────────────────────────────────────────────
    $upload_dir    = wp_upload_dir();
    $base          = trailingslashit( $upload_dir['basedir'] );

    // Current jetreader/ uploads directory.
    $jetreader_dir = $base . 'jetreader';
    if ( is_dir( $jetreader_dir ) ) {
        jetreader_uninstall_rmdir( $jetreader_dir );
    }

    // Legacy lector/ uploads directory from the pre-rename version.
    $lector_dir = $base . 'lector';
    if ( is_dir( $lector_dir ) ) {
        jetreader_uninstall_rmdir( $lector_dir );
    }

    // ── 7. Flush rewrite rules ─────────────────────────────────────────────────
    flush_rewrite_rules();
}

// ── Entry point: single-site or multisite ───────────────────────────────────
if ( is_multisite() ) {
    $jetreader_sites = get_sites( array( 'number' => 0, 'fields' => 'ids' ) );
    foreach ( $jetreader_sites as $jetreader_site_id ) {
        switch_to_blog( (int) $jetreader_site_id );
        jetreader_uninstall_site();
        restore_current_blog();
    }
} else {
    jetreader_uninstall_site();
}

/**
 * Recursively delete a directory and all its contents.
 * Skips symlinks to prevent accidental deletion outside the expected directory.
 *
 * @param string $dir Absolute path to the directory.
 */
function jetreader_uninstall_rmdir( string $dir ): void {
    if ( ! is_dir( $dir ) || is_link( $dir ) ) {
        return;
    }

    // Ensure we stay within the expected base path (symlink guard).
    $real_base = realpath( dirname( $dir ) );
    $real_dir  = realpath( $dir );
    if ( false === $real_dir || false === strpos( $real_dir, $real_base ) ) {
        return;
    }

    $items = array_diff( (array) scandir( $dir ), array( '.', '..' ) );

    foreach ( $items as $item ) {
        $path = $dir . DIRECTORY_SEPARATOR . $item;

        if ( is_link( $path ) ) {
            // Skip symlinks entirely — never follow them during deletion.
            continue;
        }

        if ( is_dir( $path ) ) {
            jetreader_uninstall_rmdir( $path );
        } else {
            // phpcs:ignore WordPress.WP.AlternativeFunctions.unlink_unlink
            unlink( $path );
        }
    }

    // phpcs:ignore WordPress.WP.AlternativeFunctions.file_system_operations_rmdir
    rmdir( $dir );
}
