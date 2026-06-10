<?php
/**
 * Database handler class.
 *
 * @package JetReader
 */

// If this file is called directly, abort.
if ( ! defined( 'WPINC' ) ) {
    die;
}

/**
 * Class JetReader_Database
 *
 * Handles all database operations including table creation.
 */
// phpcs:disable PluginCheck.Security.DirectDB.UnescapedDBParameter
class JetReader_Database {

    /**
     * Create all custom database tables.
     */
    public static function create_tables() {
        global $wpdb;

        $charset_collate = $wpdb->get_charset_collate();

        $sql = array();

        // 1. Library Items table.
        $sql[] = "CREATE TABLE IF NOT EXISTS {$wpdb->prefix}jetreader_items (
            id BIGINT(20) UNSIGNED NOT NULL AUTO_INCREMENT,
            type VARCHAR(20) NOT NULL DEFAULT 'book',
            title VARCHAR(500) NOT NULL,
            slug VARCHAR(500) NOT NULL,
            description LONGTEXT DEFAULT NULL,
            cover_image VARCHAR(1000) DEFAULT NULL,
            file_path VARCHAR(1000) NOT NULL,
            file_type VARCHAR(20) NOT NULL,
            file_size BIGINT(20) UNSIGNED DEFAULT 0,
            language VARCHAR(20) DEFAULT 'en',
            author VARCHAR(500) DEFAULT NULL,
            translator VARCHAR(500) DEFAULT NULL,
            publisher VARCHAR(500) DEFAULT NULL,
            isbn VARCHAR(50) DEFAULT NULL,
            publication_year INT(4) UNSIGNED DEFAULT NULL,
            page_count INT(10) UNSIGNED DEFAULT 0,
            reading_time INT(10) UNSIGNED DEFAULT 0,
            visibility VARCHAR(20) NOT NULL DEFAULT 'publish',
            featured TINYINT(1) NOT NULL DEFAULT 0,
            view_count BIGINT(20) UNSIGNED DEFAULT 0,
            read_count BIGINT(20) UNSIGNED DEFAULT 0,
            metadata LONGTEXT DEFAULT NULL,
            volumes TEXT DEFAULT NULL,
            created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
            PRIMARY KEY (id),
            UNIQUE KEY slug (slug),
            KEY type (type),
            KEY author (author(191)),
            KEY language (language),
            KEY visibility (visibility),
            KEY featured (featured),
            KEY created_at (created_at),
            KEY visibility_type_created (visibility, type, created_at),
            FULLTEXT KEY ft_title_description (title, description)
        ) ENGINE=InnoDB $charset_collate;";

        // 2. Chapters table.
        $sql[] = "CREATE TABLE IF NOT EXISTS {$wpdb->prefix}jetreader_chapters (
            id BIGINT(20) UNSIGNED NOT NULL AUTO_INCREMENT,
            item_id BIGINT(20) UNSIGNED NOT NULL,
            title VARCHAR(500) NOT NULL,
            content LONGTEXT DEFAULT NULL,
            order_index INT(10) UNSIGNED NOT NULL DEFAULT 0,
            page_start INT(10) UNSIGNED DEFAULT 0,
            page_end INT(10) UNSIGNED DEFAULT 0,
            created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY (id),
            KEY item_id (item_id),
            KEY order_index (order_index)
        ) ENGINE=InnoDB $charset_collate;";

        // 3. Categories table.
        $sql[] = "CREATE TABLE IF NOT EXISTS {$wpdb->prefix}jetreader_categories (
            id BIGINT(20) UNSIGNED NOT NULL AUTO_INCREMENT,
            name VARCHAR(200) NOT NULL,
            slug VARCHAR(200) NOT NULL,
            description LONGTEXT DEFAULT NULL,
            parent_id BIGINT(20) UNSIGNED DEFAULT 0,
            item_count BIGINT(20) UNSIGNED DEFAULT 0,
            type VARCHAR(20) NOT NULL DEFAULT 'book',
            created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY (id),
            UNIQUE KEY slug_type (slug, type),
            KEY parent_id (parent_id),
            KEY type (type),
            KEY name (name(191))
        ) ENGINE=InnoDB $charset_collate;";

        // 4. Item-Category relationship.
        $sql[] = "CREATE TABLE IF NOT EXISTS {$wpdb->prefix}jetreader_item_categories (
            item_id BIGINT(20) UNSIGNED NOT NULL,
            category_id BIGINT(20) UNSIGNED NOT NULL,
            PRIMARY KEY (item_id, category_id),
            KEY category_id (category_id)
        ) ENGINE=InnoDB $charset_collate;";

        // 5. Tags table.
        $sql[] = "CREATE TABLE IF NOT EXISTS {$wpdb->prefix}jetreader_tags (
            id BIGINT(20) UNSIGNED NOT NULL AUTO_INCREMENT,
            name VARCHAR(200) NOT NULL,
            slug VARCHAR(200) NOT NULL,
            description LONGTEXT DEFAULT NULL,
            item_count BIGINT(20) UNSIGNED DEFAULT 0,
            created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY (id),
            UNIQUE KEY slug (slug)
        ) ENGINE=InnoDB $charset_collate;";

        // 6. Item-Tag relationship.
        $sql[] = "CREATE TABLE IF NOT EXISTS {$wpdb->prefix}jetreader_item_tags (
            item_id BIGINT(20) UNSIGNED NOT NULL,
            tag_id BIGINT(20) UNSIGNED NOT NULL,
            PRIMARY KEY (item_id, tag_id),
            KEY tag_id (tag_id)
        ) ENGINE=InnoDB $charset_collate;";

        // 7. User preferences table.
        $sql[] = "CREATE TABLE IF NOT EXISTS {$wpdb->prefix}jetreader_user_preferences (
            id BIGINT(20) UNSIGNED NOT NULL AUTO_INCREMENT,
            user_id BIGINT(20) UNSIGNED NOT NULL,
            font_size VARCHAR(20) DEFAULT 'medium',
            line_height VARCHAR(20) DEFAULT 'medium',
            font_family VARCHAR(50) DEFAULT 'auto',
            theme_mode VARCHAR(20) DEFAULT 'auto',
            reading_mode VARCHAR(20) DEFAULT 'paginated',
            sidebar_state VARCHAR(20) DEFAULT 'open',
            last_item_id BIGINT(20) UNSIGNED DEFAULT NULL,
            last_position LONGTEXT DEFAULT NULL,
            updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
            PRIMARY KEY (id),
            UNIQUE KEY user_id (user_id)
        ) ENGINE=InnoDB $charset_collate;";

        // 8. Bookmarks table.
        $sql[] = "CREATE TABLE IF NOT EXISTS {$wpdb->prefix}jetreader_bookmarks (
            id BIGINT(20) UNSIGNED NOT NULL AUTO_INCREMENT,
            user_id BIGINT(20) UNSIGNED NOT NULL,
            item_id BIGINT(20) UNSIGNED NOT NULL,
            chapter_id BIGINT(20) UNSIGNED DEFAULT NULL,
            position LONGTEXT NOT NULL,
            label VARCHAR(500) DEFAULT NULL,
            color VARCHAR(20) DEFAULT '#FFD700',
            created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY (id),
            KEY user_id (user_id),
            KEY item_id (item_id),
            KEY user_item (user_id, item_id)
        ) ENGINE=InnoDB $charset_collate;";

        // 9. Notes/Highlights table.
        $sql[] = "CREATE TABLE IF NOT EXISTS {$wpdb->prefix}jetreader_notes (
            id BIGINT(20) UNSIGNED NOT NULL AUTO_INCREMENT,
            user_id BIGINT(20) UNSIGNED NOT NULL,
            item_id BIGINT(20) UNSIGNED NOT NULL,
            chapter_id BIGINT(20) UNSIGNED DEFAULT NULL,
            type VARCHAR(20) NOT NULL DEFAULT 'note',
            content LONGTEXT DEFAULT NULL,
            quote TEXT DEFAULT NULL,
            position LONGTEXT DEFAULT NULL,
            color VARCHAR(20) DEFAULT '#FFFF00',
            is_public TINYINT(1) NOT NULL DEFAULT 0,
            created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
            PRIMARY KEY (id),
            KEY user_id (user_id),
            KEY item_id (item_id),
            KEY type (type),
            KEY user_item (user_id, item_id)
        ) ENGINE=InnoDB $charset_collate;";

        require_once ABSPATH . 'wp-admin/includes/upgrade.php';

        foreach ( $sql as $query ) {
            dbDelta( $query );
        }

        // Store current database version.
        update_option( 'jetreader_db_version', JETREADER_VERSION );

        // Ensure the volumes column exists on existing installs.
        self::maybe_add_volumes_column();
        // Ensure the translator column exists on existing installs.
        self::maybe_add_translator_column();
        // Ensure the type column exists on categories table.
        self::maybe_add_categories_type_column();
        // Fix categories unique key: replace slug-only with (slug,type) composite.
        self::maybe_fix_categories_unique_key();
        // Ensure authors and publishers tables exist.
        self::maybe_add_authors_table();
        self::maybe_add_publishers_table();

        // Add composite index for the common list query pattern.
        self::maybe_add_composite_index();

        // Bust the CPT permalink transient so stale slugs are never served
        // after an upgrade or fresh activation.
        delete_transient( 'jetreader_cpt_permalink_map' );
    }

    /**
     * Fix categories unique key: replace old single-column slug key
     * with composite (slug, type) key so the same slug can exist in different types.
     * Safe to call multiple times — checks before altering.
     */
    public static function maybe_fix_categories_unique_key() {
        global $wpdb;
        $table = $wpdb->prefix . 'jetreader_categories';

        // Check if the composite key already exists.
        // phpcs:ignore WordPress.DB.DirectDatabaseQuery.DirectQuery, WordPress.DB.DirectDatabaseQuery.NoCaching
        $composite_exists = $wpdb->get_var(
            // phpcs:ignore WordPress.DB.PreparedSQL.InterpolatedNotPrepared
            $wpdb->prepare( "SHOW INDEX FROM `{$table}` WHERE Key_name = %s", 'slug_type' )
        );

        if ( ! $composite_exists ) {
            // Drop old unique key if it exists.
            // phpcs:ignore WordPress.DB.DirectDatabaseQuery.DirectQuery, WordPress.DB.DirectDatabaseQuery.NoCaching
            $old_unique = $wpdb->get_var(
                // phpcs:ignore WordPress.DB.PreparedSQL.InterpolatedNotPrepared
                $wpdb->prepare( "SHOW INDEX FROM `{$table}` WHERE Key_name = %s AND Non_unique = 0", 'slug' )
            );
            if ( $old_unique ) {
                // phpcs:ignore WordPress.DB.DirectDatabaseQuery.NoCaching, WordPress.DB.DirectDatabaseQuery.SchemaChange, WordPress.DB.PreparedSQL.InterpolatedNotPrepared, WordPress.DB.DirectDatabaseQuery.DirectQuery
                $wpdb->query( "ALTER TABLE `{$table}` DROP INDEX `slug`" );
            }
            // Add composite unique key.
            // phpcs:ignore WordPress.DB.DirectDatabaseQuery.NoCaching, WordPress.DB.DirectDatabaseQuery.SchemaChange, WordPress.DB.PreparedSQL.InterpolatedNotPrepared, WordPress.DB.DirectDatabaseQuery.DirectQuery
            $wpdb->query( "ALTER TABLE `{$table}` ADD UNIQUE KEY `slug_type` (`slug`, `type`)" );
        }
    }

    /**
     * Add the translator column to existing installs that pre-date this feature.
     * Safe to call multiple times — checks before altering.
     */
    public static function maybe_add_translator_column() {
        global $wpdb;
        $table = $wpdb->prefix . 'jetreader_items';
        // phpcs:ignore WordPress.DB.DirectDatabaseQuery.DirectQuery, WordPress.DB.DirectDatabaseQuery.NoCaching
        $exists = $wpdb->get_var(
            // phpcs:ignore WordPress.DB.PreparedSQL.InterpolatedNotPrepared
            $wpdb->prepare( "SHOW COLUMNS FROM `{$table}` LIKE %s", 'translator' )
        );
        if ( ! $exists ) {
            // phpcs:ignore WordPress.DB.DirectDatabaseQuery.SchemaChange, WordPress.DB.PreparedSQL.InterpolatedNotPrepared, WordPress.DB.DirectDatabaseQuery.NoCaching, WordPress.DB.DirectDatabaseQuery.DirectQuery
            $wpdb->query( "ALTER TABLE `{$table}` ADD COLUMN `translator` VARCHAR(500) DEFAULT NULL AFTER `author`" );
        }
    }

    /**
     * Add the volumes column to existing installs that pre-date this feature.
     * Safe to call multiple times — checks before altering.
     */
    public static function maybe_add_volumes_column() {
        global $wpdb;
        $table = $wpdb->prefix . 'jetreader_items';
        // phpcs:ignore WordPress.DB.DirectDatabaseQuery.DirectQuery, WordPress.DB.DirectDatabaseQuery.NoCaching
        $exists = $wpdb->get_var(
            // phpcs:ignore WordPress.DB.PreparedSQL.InterpolatedNotPrepared
            $wpdb->prepare( "SHOW COLUMNS FROM `{$table}` LIKE %s", 'volumes' )
        );
        if ( ! $exists ) {
            // phpcs:ignore WordPress.DB.DirectDatabaseQuery.SchemaChange, WordPress.DB.PreparedSQL.InterpolatedNotPrepared, WordPress.DB.DirectDatabaseQuery.NoCaching, WordPress.DB.DirectDatabaseQuery.DirectQuery
            $wpdb->query( "ALTER TABLE `{$table}` ADD COLUMN `volumes` TEXT DEFAULT NULL" );
        }
    }

    /**
     * Add the type column to categories table for existing installs.
     * Safe to call multiple times — checks before altering.
     */
    public static function maybe_add_categories_type_column() {
        global $wpdb;
        $table = $wpdb->prefix . 'jetreader_categories';
        // phpcs:ignore WordPress.DB.DirectDatabaseQuery.DirectQuery, WordPress.DB.DirectDatabaseQuery.NoCaching
        $exists = $wpdb->get_var(
            // phpcs:ignore WordPress.DB.PreparedSQL.InterpolatedNotPrepared
            $wpdb->prepare( "SHOW COLUMNS FROM `{$table}` LIKE %s", 'type' )
        );
        if ( ! $exists ) {
            // phpcs:ignore WordPress.DB.DirectDatabaseQuery.SchemaChange, WordPress.DB.PreparedSQL.InterpolatedNotPrepared, WordPress.DB.DirectDatabaseQuery.NoCaching, WordPress.DB.DirectDatabaseQuery.DirectQuery
            $wpdb->query( "ALTER TABLE `{$table}` ADD COLUMN `type` VARCHAR(20) NOT NULL DEFAULT 'book', ADD KEY `type` (`type`)" );
        }
    }

    /**
     * Add the name index to categories table for existing installs.
     * Safe to call multiple times — checks before altering.
     */
    public static function maybe_add_categories_name_index() {
        global $wpdb;
        $table = $wpdb->prefix . 'jetreader_categories';
        // phpcs:ignore WordPress.DB.DirectDatabaseQuery.NoCaching, WordPress.DB.DirectDatabaseQuery.DirectQuery
        $exists = $wpdb->get_var(
            // phpcs:ignore WordPress.DB.PreparedSQL.InterpolatedNotPrepared
            $wpdb->prepare( "SHOW INDEX FROM `{$table}` WHERE Key_name = %s", 'name' )
        );
        if ( ! $exists ) {
            // phpcs:ignore WordPress.DB.DirectDatabaseQuery.SchemaChange, WordPress.DB.PreparedSQL.InterpolatedNotPrepared, WordPress.DB.DirectDatabaseQuery.NoCaching, WordPress.DB.DirectDatabaseQuery.DirectQuery
            $wpdb->query( "ALTER TABLE `{$table}` ADD KEY `name` (`name`(191))" );
        }
    }

    /**
     * Create the jetreader_authors table. Safe to call on every request.
     */
    public static function maybe_add_authors_table() {
        global $wpdb;

        $table = $wpdb->prefix . 'jetreader_authors';
        // phpcs:ignore WordPress.DB.DirectDatabaseQuery.NoCaching, WordPress.DB.DirectDatabaseQuery.DirectQuery
        if ( $wpdb->get_var( $wpdb->prepare( 'SHOW TABLES LIKE %s', $table ) ) ) {
            return;
        }

        $charset_collate = $wpdb->get_charset_collate();

        $sql = "CREATE TABLE IF NOT EXISTS {$table} (
            id BIGINT(20) UNSIGNED NOT NULL AUTO_INCREMENT,
            name VARCHAR(200) NOT NULL,
            slug VARCHAR(200) NOT NULL,
            description LONGTEXT DEFAULT NULL,
            created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY (id),
            UNIQUE KEY slug (slug),
            KEY name (name(191))
        ) ENGINE=InnoDB {$charset_collate};";

        require_once ABSPATH . 'wp-admin/includes/upgrade.php';
        dbDelta( $sql );
    }

    /**
     * Create the jetreader_publishers table. Safe to call on every request.
     */
    public static function maybe_add_publishers_table() {
        global $wpdb;

        $table = $wpdb->prefix . 'jetreader_publishers';
        // phpcs:ignore WordPress.DB.DirectDatabaseQuery.NoCaching, WordPress.DB.DirectDatabaseQuery.DirectQuery
        if ( $wpdb->get_var( $wpdb->prepare( 'SHOW TABLES LIKE %s', $table ) ) ) {
            return;
        }

        $charset_collate = $wpdb->get_charset_collate();

        $sql = "CREATE TABLE IF NOT EXISTS {$table} (
            id BIGINT(20) UNSIGNED NOT NULL AUTO_INCREMENT,
            name VARCHAR(200) NOT NULL,
            slug VARCHAR(200) NOT NULL,
            description LONGTEXT DEFAULT NULL,
            created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY (id),
            UNIQUE KEY slug (slug),
            KEY name (name(191))
        ) ENGINE=InnoDB {$charset_collate};";

        require_once ABSPATH . 'wp-admin/includes/upgrade.php';
        dbDelta( $sql );
    }

    /**
     * Add composite index (visibility, type, created_at) to jetreader_items for existing installs.
     * Speeds up the common list query: WHERE visibility = 'publish' AND type = 'book' ORDER BY created_at DESC.
     * Safe to call multiple times — checks before altering.
     */
    public static function maybe_add_composite_index() {
        global $wpdb;
        $table = $wpdb->prefix . 'jetreader_items';
        // phpcs:ignore WordPress.DB.DirectDatabaseQuery.DirectQuery, WordPress.DB.DirectDatabaseQuery.NoCaching
        $exists = $wpdb->get_var(
            // phpcs:ignore WordPress.DB.PreparedSQL.InterpolatedNotPrepared
            $wpdb->prepare( "SHOW INDEX FROM `{$table}` WHERE Key_name = %s", 'visibility_type_created' )
        );
        if ( ! $exists ) {
            // phpcs:ignore WordPress.DB.DirectDatabaseQuery.SchemaChange, WordPress.DB.PreparedSQL.InterpolatedNotPrepared, WordPress.DB.DirectDatabaseQuery.NoCaching, WordPress.DB.DirectDatabaseQuery.DirectQuery
            $wpdb->query( "ALTER TABLE `{$table}` ADD KEY `visibility_type_created` (`visibility`, `type`, `created_at`)" );
        }
    }
}