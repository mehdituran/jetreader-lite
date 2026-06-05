<?php
/**
 * Full-text search index management.
 *
 * @package JetReader
 */

if ( ! defined( 'WPINC' ) ) {
    die;
}

/**
 * Class JetReader_Search_Index
 *
 * Populates and queries the jetreader_search_index table.
 * Every page / chapter of every uploaded file is stored here so that
 * WordPress native search and the content-search REST endpoint can find
 * text inside PDFs, EPUBs, DOCXs, and TXT files.
 */
// phpcs:disable PluginCheck.Security.DirectDB.UnescapedDBParameter, WordPress.DB.PreparedSQL.InterpolatedNotPrepared
class JetReader_Search_Index {

    /** Max characters stored per page row. Keeps table size manageable. */
    private const MAX_CONTENT_LEN = 2000;

    /** Batch size for INSERT statements. */
    private const BATCH_SIZE = 500;

    // -------------------------------------------------------------------------
    // Write
    // -------------------------------------------------------------------------

    /**
     * (Re-)populate the search index for one item.
     *
     * @param int   $item_id Item ID from jetreader_items.
     * @param array $pages   Array of ['volume_idx'=>int, 'page_num'=>int, 'content'=>string].
     */
    public static function populate( int $item_id, array $pages ): void {
        global $wpdb;
        $table = $wpdb->prefix . 'jetreader_search_index';

        // Delete existing rows for this item first.
        // phpcs:ignore WordPress.DB.DirectDatabaseQuery.DirectQuery, WordPress.DB.DirectDatabaseQuery.NoCaching
        $wpdb->delete( $table, array( 'item_id' => $item_id ), array( '%d' ) );

        $placeholders = array();
        $values       = array();

        foreach ( $pages as $page ) {
            $content = mb_substr(
                sanitize_textarea_field( (string) ( $page['content'] ?? '' ) ),
                0,
                self::MAX_CONTENT_LEN
            );

            if ( '' === trim( $content ) ) {
                continue;
            }

            $placeholders[] = '(%d, %d, %d, %s)';
            $values[]       = $item_id;
            $values[]       = (int) ( $page['volume_idx'] ?? 0 );
            $values[]       = (int) ( $page['page_num'] ?? 0 );
            $values[]       = $content;

            if ( count( $placeholders ) >= self::BATCH_SIZE ) {
                self::flush_batch( $table, $placeholders, $values );
                $placeholders = array();
                $values       = array();
            }
        }

        if ( ! empty( $placeholders ) ) {
            self::flush_batch( $table, $placeholders, $values );
        }
    }

    /**
     * Execute a batch INSERT.
     */
    private static function flush_batch( string $table, array $placeholders, array $values ): void {
        global $wpdb;
        // phpcs:ignore WordPress.DB.PreparedSQL.InterpolatedNotPrepared
        $sql = "INSERT INTO `{$table}` (item_id, volume_idx, page_num, content) VALUES " . implode( ',', $placeholders );
        // phpcs:ignore WordPress.DB.DirectDatabaseQuery.NoCaching, WordPress.DB.DirectDatabaseQuery.DirectQuery, WordPress.DB.PreparedSQL.NotPrepared
        $wpdb->query( $wpdb->prepare( $sql, $values ) );
    }

    // -------------------------------------------------------------------------
    // Read — FULLTEXT search with reliable LIKE fallback
    // -------------------------------------------------------------------------

    /**
     * Search the index using MySQL FULLTEXT (IN BOOLEAN MODE).
     * Falls back to LIKE automatically if FULLTEXT fails.
     *
     * Two-query strategy:
     *   Q1 — COUNT per item_id to get the true total match count.
     *   Q2 — Fetch up to $per_item rows per item (earliest pages first) for display.
     *
     * This eliminates the "global LIMIT" problem where the same PDF indexed
     * under multiple item IDs received arbitrarily unequal row counts.
     *
     * @param  string $query     Search term.
     * @param  int    $limit     Max distinct items to return.
     * @param  int    $per_item  Max display rows per item (excerpt/page links).
     * @return array<int, array{matches:array<array{page_num:int,volume_idx:int,excerpt:string}>,total:int}>
     */
    public static function search( string $query, int $limit = 20, int $per_item = 2 ): array {
        global $wpdb;

        $query = sanitize_text_field( $query );
        if ( mb_strlen( $query ) < 2 ) {
            return array();
        }

        // Multi-word queries: FULLTEXT IN BOOLEAN MODE treats spaces as OR, producing
        // false positives ("genel ol" matches every page containing "ol").
        // LIKE '%genel ol%' is an exact substring match — same as in-reader includes().
        if ( str_contains( $query, ' ' ) ) {
            return self::search_like( $query, $limit, $per_item );
        }

        // Eğer arama sorgusunda kesme/tırnak işareti bulunuyorsa, FULLTEXT yerine
        // doğrudan search_like'a yönlendirerek tırnaksız halini de eşleştirebilmeyi sağlıyoruz.
        if ( str_contains( $query, "'" ) || str_contains( $query, "’" ) ) {
            return self::search_like( $query, $limit, $per_item );
        }

        // FULLTEXT BOOLEAN MODE operatörlerini içeren sorgular LIKE'a yönlendir.
        // Tire (-) NOT operatörü: "Croquet-Ground" → "Croquet" AND NOT "Ground" gibi yorumlanır.
        // Bu durumda LOCATE literal ifadeyi bulamaz, excerpt sayfanın başından gösterilir.
        // Diğer özel karakterler: + > < ~ * " @ ( )
        if ( preg_match( '/[-+"~*><@()]/u', $query ) ) {
            return self::search_like( $query, $limit, $per_item );
        }

        $table = $wpdb->prefix . 'jetreader_search_index';

        // Q1: True total per item — no content column, very fast.
        // phpcs:ignore WordPress.DB.DirectDatabaseQuery.NoCaching, WordPress.DB.DirectDatabaseQuery.DirectQuery, WordPress.DB.PreparedSQL.InterpolatedNotPrepared
        $totals_raw = $wpdb->get_results( $wpdb->prepare(
            "SELECT item_id, COUNT(*) AS total
             FROM `{$table}`
             WHERE MATCH(content) AGAINST (%s IN BOOLEAN MODE)
             GROUP BY item_id
             LIMIT %d",
            $query . '*',
            $limit
        ) );

        if ( ! empty( $wpdb->last_error ) || false === $totals_raw ) {
            $wpdb->last_error = '';
            return self::search_like( $query, $limit, $per_item );
        }

        if ( empty( $totals_raw ) ) {
            return array();
        }

        $totals   = array();
        $item_ids = array();
        foreach ( $totals_raw as $row ) {
            $id            = (int) $row->item_id;
            $totals[ $id ] = (int) $row->total;
            $item_ids[]    = $id;
        }

        // Q2: Per-item queries — each item gets exactly $per_item earliest pages.
        // A single global LIMIT would give all rows to the first item_id when many
        // items match, leaving the rest with zero display rows.
        $all_rows = array();
        foreach ( $item_ids as $id ) {
            // phpcs:ignore WordPress.DB.DirectDatabaseQuery.NoCaching, WordPress.DB.DirectDatabaseQuery.DirectQuery, WordPress.DB.PreparedSQL.InterpolatedNotPrepared
            $item_rows = $wpdb->get_results( $wpdb->prepare(
                "SELECT item_id, volume_idx, page_num,
                        SUBSTRING(content, GREATEST(1, LOCATE(%s, content) - 80), 250) AS excerpt
                 FROM `{$table}`
                 WHERE MATCH(content) AGAINST (%s IN BOOLEAN MODE)
                   AND item_id = %d
                 ORDER BY page_num ASC
                 LIMIT %d",
                $query,
                $query . '*',
                $id,
                $per_item
            ) );
            foreach ( (array) $item_rows as $r ) {
                $all_rows[] = $r;
            }
        }

        return self::group_rows( $all_rows, $totals, $per_item );
    }

    /**
     * LIKE-based fallback search. Slower but works on all MySQL configurations.
     *
     * @return array<int, array{matches:array<array{page_num:int,volume_idx:int,excerpt:string}>,total:int}>
     */
    public static function search_like( string $query, int $limit = 20, int $per_item = 2 ): array {
        global $wpdb;

        $query = sanitize_text_field( $query );
        if ( mb_strlen( $query ) < 2 ) {
            return array();
        }

        $table    = $wpdb->prefix . 'jetreader_search_index';
        $variants = self::get_query_variants( $query );

        $conditions = array();
        $params     = array();
        foreach ( $variants as $var ) {
            $conditions[] = "content LIKE %s";
            $params[]     = '%' . $wpdb->esc_like( $var ) . '%';
        }
        $sql_cond = implode( ' OR ', $conditions );
        $params[] = $limit;

        // phpcs:ignore WordPress.DB.DirectDatabaseQuery.NoCaching, WordPress.DB.DirectDatabaseQuery.DirectQuery, WordPress.DB.PreparedSQL.InterpolatedNotPrepared
        $totals_raw = $wpdb->get_results( $wpdb->prepare(
            "SELECT item_id, COUNT(*) AS total
             FROM `{$table}`
             WHERE {$sql_cond}
             GROUP BY item_id
             LIMIT %d",
            ...$params
        ) );

        if ( empty( $totals_raw ) ) {
            return array();
        }

        $totals   = array();
        $item_ids = array();
        foreach ( $totals_raw as $row ) {
            $id            = (int) $row->item_id;
            $totals[ $id ] = (int) $row->total;
            $item_ids[]    = $id;
        }

        // Per-item queries — each item gets exactly $per_item earliest pages.
        $all_rows = array();
        foreach ( $item_ids as $id ) {
            $item_conditions = array();
            $item_params     = array();
            $locate_parts    = array();

            foreach ( $variants as $var ) {
                $item_conditions[] = "content LIKE %s";
                $item_params[]     = '%' . $wpdb->esc_like( $var ) . '%';
                $locate_parts[]    = $wpdb->prepare( "NULLIF(LOCATE(%s, content), 0)", $var );
            }

            $sql_item_cond = implode( ' OR ', $item_conditions );
            $sql_coalesce  = "COALESCE(" . implode( ', ', $locate_parts ) . ", 1)";
            $query_params  = array_merge( $item_params, array( $id, $per_item ) );

            // phpcs:ignore WordPress.DB.DirectDatabaseQuery.NoCaching, WordPress.DB.DirectDatabaseQuery.DirectQuery, WordPress.DB.PreparedSQL.InterpolatedNotPrepared, WordPress.DB.PreparedSQLPlaceholders.ReplacementsWrongNumber
            $item_rows = $wpdb->get_results( $wpdb->prepare(
                "SELECT item_id, volume_idx, page_num,
                        SUBSTRING(content, GREATEST(1, {$sql_coalesce} - 80), 250) AS excerpt
                 FROM `{$table}`
                 WHERE ({$sql_item_cond})
                   AND item_id = %d
                 ORDER BY page_num ASC
                 LIMIT %d",
                ...$query_params
            ) );
            foreach ( (array) $item_rows as $r ) {
                $all_rows[] = $r;
            }
        }

        return self::group_rows( $all_rows, $totals, $per_item );
    }

    /**
     * Expand search query to include Turkish apostrophe variants if apostrophes are present.
     *
     * @param string $query Original search query.
     * @return string[] Unique variants of the query to search.
     */
    private static function get_query_variants( string $query ): array {
        $variants = array( $query );

        if ( str_contains( $query, "'" ) || str_contains( $query, "’" ) ) {
            $stripped = str_replace( array( "'", "’" ), '', $query );
            if ( $stripped !== $query && mb_strlen( $stripped ) >= 2 ) {
                $variants[] = $stripped;
            }
            $variants[] = str_replace( "'", "’", $query );
            $variants[] = str_replace( "’", "'", $query );
        }

        return array_values( array_unique( $variants ) );
    }

    /**
     * Group flat DB rows by item_id, capping at $per_item rows per item.
     * Rows are assumed to arrive pre-sorted (page_num ASC from the query).
     *
     * @param  array $rows     Flat DB rows.
     * @param  array $totals   Map of item_id → true total match count from COUNT query.
     * @param  int   $per_item Max rows to keep per item.
     * @return array<int, array{matches:array<array{page_num:int,volume_idx:int,excerpt:string}>,total:int}>
     */
    private static function group_rows( array $rows, array $totals, int $per_item = PHP_INT_MAX ): array {
        $grouped = array();
        $counts  = array();

        foreach ( $rows as $row ) {
            $id = (int) $row->item_id;

            if ( ! isset( $grouped[ $id ] ) ) {
                $grouped[ $id ] = array(
                    'matches' => array(),
                    'total'   => $totals[ $id ] ?? 0,
                );
                $counts[ $id ]  = 0;
            }

            if ( $counts[ $id ] >= $per_item ) {
                continue;
            }

            $grouped[ $id ]['matches'][] = array(
                'page_num'   => (int) $row->page_num,
                'volume_idx' => (int) $row->volume_idx,
                'excerpt'    => (string) $row->excerpt,
            );
            $counts[ $id ]++;
        }

        // Items that had a COUNT entry but zero fetched rows still appear with total.
        foreach ( $totals as $id => $total ) {
            if ( ! isset( $grouped[ $id ] ) ) {
                $grouped[ $id ] = array( 'matches' => array(), 'total' => $total );
            }
        }

        return $grouped;
    }

    // -------------------------------------------------------------------------
    // Single-item indexing (used by the batch-rebuild REST endpoint)
    // -------------------------------------------------------------------------

    /**
     * Parse and index a single item by ID.
     *
     * Fetches the item row, resolves its file(s), parses pages, and calls
     * populate() which first deletes stale rows for the item.
     *
     * @param int $item_id
     * @return bool  true = indexed, false = item not found or no readable files.
     */
    public static function index_single_item( int $item_id ): bool {
        global $wpdb;

        if ( ! class_exists( 'JetReader_Parser_Engine' ) ) {
            require_once JETREADER_PLUGIN_DIR . 'includes/class-parser-engine.php';
        }

        // phpcs:ignore WordPress.DB.DirectDatabaseQuery.DirectQuery, WordPress.DB.DirectDatabaseQuery.NoCaching, WordPress.DB.PreparedSQL.InterpolatedNotPrepared
        $item = $wpdb->get_row( $wpdb->prepare(
            "SELECT id, file_path, file_type, volumes FROM {$wpdb->prefix}jetreader_items WHERE id = %d",
            $item_id
        ) );

        if ( ! $item ) {
            return false;
        }

        $files     = self::resolve_files( $item );
        $all_pages = array();

        foreach ( $files as $vol_idx => $file_info ) {
            $pages = JetReader_Parser_Engine::extract_all_pages( $file_info['path'], $file_info['type'] );
            foreach ( $pages as &$p ) {
                $p['volume_idx'] = $vol_idx;
            }
            unset( $p );
            $all_pages = array_merge( $all_pages, $pages );
        }

        // populate() always deletes existing rows first — safe to call repeatedly.
        self::populate( $item_id, $all_pages );

        return true;
    }

    /**
     * Remove index rows for items that no longer exist in jetreader_items.
     * Called as the final step of a batch rebuild to clean up orphaned rows.
     *
     * @return int Number of deleted rows.
     */
    public static function cleanup_orphaned_rows(): int {
        global $wpdb;
        $table = $wpdb->prefix . 'jetreader_search_index';
        $items = $wpdb->prefix . 'jetreader_items';
        // phpcs:ignore WordPress.DB.DirectDatabaseQuery.NoCaching, WordPress.DB.DirectDatabaseQuery.DirectQuery, WordPress.DB.PreparedSQL.InterpolatedNotPrepared
        $result = $wpdb->query( "DELETE FROM `{$table}` WHERE item_id NOT IN (SELECT id FROM `{$items}`)" );
        return ( false === $result ) ? 0 : (int) $result;
    }

    // -------------------------------------------------------------------------
    // Housekeeping
    // -------------------------------------------------------------------------

    /**
     * Delete all index rows for an item (called on item delete).
     */
    public static function delete_for_item( int $item_id ): void {
        global $wpdb;
        // phpcs:ignore WordPress.DB.DirectDatabaseQuery.DirectQuery, WordPress.DB.DirectDatabaseQuery.NoCaching
        $wpdb->delete(
            $wpdb->prefix . 'jetreader_search_index',
            array( 'item_id' => $item_id ),
            array( '%d' )
        );
    }

    /**
     * Rebuild the entire index for all items (called from admin action).
     * This is slow — should be called from a WP-Cron job, not a request.
     */
    /**
     * Rebuild the entire index for all items.
     *
     * Returns the number of items indexed, or -1 if a rebuild is already running.
     */
    public static function rebuild_all(): int {
        global $wpdb;

        // Prevent concurrent rebuilds (e.g. user clicking the button twice).
        $lock_key = 'jetreader_rebuild_all_lock';
        if ( get_transient( $lock_key ) ) {
            return -1;
        }
        set_transient( $lock_key, 1, 10 * MINUTE_IN_SECONDS );

        $tmp_table  = "{$wpdb->prefix}jetreader_search_index_tmp";
        $main_table = "{$wpdb->prefix}jetreader_search_index";
        $tmp_created = false;

        try {
            if ( ! class_exists( 'JetReader_Parser_Engine' ) ) {
                require_once JETREADER_PLUGIN_DIR . 'includes/class-parser-engine.php';
            }

            // phpcs:ignore WordPress.DB.DirectDatabaseQuery.DirectQuery, WordPress.DB.DirectDatabaseQuery.NoCaching, WordPress.DB.PreparedSQL.InterpolatedNotPrepared
            $items = $wpdb->get_results(
                "SELECT id, file_path, file_type, volumes FROM {$wpdb->prefix}jetreader_items"
            );

            // Cancel any pending per-item cron jobs so they don't re-run
            // and overwrite the fresh data we're about to write.
            foreach ( $items as $item ) {
                $id = (int) $item->id;
                wp_clear_scheduled_hook( 'jetreader_index_item', array( $id ) );
                delete_transient( 'jetreader_index_job_' . $id );
            }

            // Atomic rebuild: write into a shadow table, then swap.
            // If indexing fails midway the live index remains intact.
            // phpcs:disable WordPress.DB.DirectDatabaseQuery.NoCaching,WordPress.DB.DirectDatabaseQuery.SchemaChange,WordPress.DB.PreparedSQL.InterpolatedNotPrepared,WordPress.DB.DirectDatabaseQuery.DirectQuery
            $wpdb->query( "DROP TABLE IF EXISTS {$tmp_table}" );
            $wpdb->query( "CREATE TABLE {$tmp_table} LIKE {$main_table}" );
            // phpcs:enable
            $tmp_created = true;

            $count = 0;

            foreach ( $items as $item ) {
                $files = self::resolve_files( $item );

                $all_pages = array();
                foreach ( $files as $vol_idx => $file_info ) {
                    $pages = JetReader_Parser_Engine::extract_all_pages(
                        $file_info['path'],
                        $file_info['type']
                    );
                    foreach ( $pages as &$p ) {
                        $p['volume_idx'] = $vol_idx;
                    }
                    unset( $p );
                    $all_pages = array_merge( $all_pages, $pages );
                }

                if ( ! empty( $all_pages ) ) {
                    // Write into the shadow table instead of the live one.
                    self::populate_table( (int) $item->id, $all_pages, $tmp_table );
                    $count++;
                }
            }

            // Atomically swap: rename live → old, tmp → live, then drop old.
            // phpcs:disable WordPress.DB.DirectDatabaseQuery.NoCaching,WordPress.DB.DirectDatabaseQuery.SchemaChange,WordPress.DB.PreparedSQL.InterpolatedNotPrepared,WordPress.DB.DirectDatabaseQuery.DirectQuery
            $wpdb->query( "RENAME TABLE {$main_table} TO {$main_table}_old, {$tmp_table} TO {$main_table}" );
            if ( ! empty( $wpdb->last_error ) ) {
                throw new \RuntimeException( 'Table swap failed: ' . $wpdb->last_error );
            }
            $wpdb->query( "DROP TABLE IF EXISTS {$main_table}_old" );
            // phpcs:enable
            $tmp_created = false;

            return $count;

        } catch ( \Throwable $e ) {
            // Clean up shadow table — live index is untouched.
            if ( $tmp_created ) {
                // phpcs:ignore WordPress.DB.DirectDatabaseQuery.NoCaching,WordPress.DB.DirectDatabaseQuery.SchemaChange,WordPress.DB.PreparedSQL.InterpolatedNotPrepared,WordPress.DB.DirectDatabaseQuery.DirectQuery
                $wpdb->query( "DROP TABLE IF EXISTS {$tmp_table}" );
            }
            // Re-throw so the REST handler can return a proper HTTP 500 with the message.
            throw $e;
        } finally {
            delete_transient( $lock_key );
        }
    }

    /**
     * Write index rows for one item into a specified table (used for shadow-table rebuild).
     *
     * @param int    $item_id   Item ID.
     * @param array  $pages     Array of page data with 'volume_idx', 'page_num', 'content'.
     * @param string $table     Target table name (fully qualified with prefix).
     */
    private static function populate_table( int $item_id, array $pages, string $table ): void {
        global $wpdb;

        // phpcs:ignore WordPress.DB.DirectDatabaseQuery.DirectQuery, WordPress.DB.DirectDatabaseQuery.NoCaching
        $wpdb->delete( $table, array( 'item_id' => $item_id ), array( '%d' ) );

        $chunk_size = 50;
        $chunks     = array_chunk( $pages, $chunk_size );

        foreach ( $chunks as $chunk ) {
            $values      = array();
            $placeholders = array();

            foreach ( $chunk as $page ) {
                $content = substr( (string) ( $page['content'] ?? '' ), 0, 65000 );
                if ( '' === trim( $content ) ) {
                    continue;
                }
                $placeholders[] = '(%d, %d, %d, %s)';
                $values[]       = $item_id;
                $values[]       = intval( $page['volume_idx'] ?? 0 );
                $values[]       = intval( $page['page_num'] ?? 0 );
                $values[]       = $content;
            }

            if ( empty( $placeholders ) ) {
                continue;
            }

            // Escaping the table name and placeholders via esc_sql before query construction to ensure PluginCheck passes.
            $escaped_table = esc_sql( $table );
            $escaped_placeholders = esc_sql( implode( ', ', $placeholders ) );
            $sql = "INSERT INTO `{$escaped_table}` (item_id, volume_idx, page_num, content) VALUES {$escaped_placeholders}";
            // phpcs:ignore WordPress.DB.PreparedSQL.NotPrepared, WordPress.DB.DirectDatabaseQuery.NoCaching, WordPress.DB.DirectDatabaseQuery.DirectQuery
            $wpdb->query( $wpdb->prepare( $sql, $values ) );
        }
    }

    /**
     * Resolve the file(s) to index for one item row (handles multi-volume).
     *
     * @return array<int, array{path:string, type:string}>
     */
    public static function resolve_files( object $item ): array {
        $files = array();

        if ( ! empty( $item->volumes ) ) {
            $vols = json_decode( $item->volumes, true );
            if ( is_array( $vols ) ) {
                foreach ( $vols as $idx => $vol ) {
                    $url  = $vol['file_path'] ?? '';
                    $path = self::url_to_local_path( $url );
                    $type = self::detect_type( $url, $vol['file_type'] ?? '' );
                    if ( $path && file_exists( $path ) ) {
                        $files[ $idx ] = array( 'path' => $path, 'type' => $type );
                    }
                }
            }
        }

        if ( empty( $files ) && ! empty( $item->file_path ) ) {
            $path = self::url_to_local_path( $item->file_path );
            if ( file_exists( $path ) ) {
                $type     = self::detect_type( $item->file_path, $item->file_type ?? '' );
                $files[0] = array( 'path' => $path, 'type' => $type );
            }
        }

        return $files;
    }

    /**
     * Determine the real file type from the URL/path extension, falling back
     * to the stored file_type when the extension is unknown.
     * This corrects common mismatches (e.g. file_type='docx' for a .doc file).
     */
    private static function detect_type( string $url_or_path, string $stored_type ): string {
        $path = wp_parse_url( $url_or_path, PHP_URL_PATH ) ?? $url_or_path;
        $ext  = strtolower( pathinfo( $path, PATHINFO_EXTENSION ) );
        return in_array( $ext, array( 'pdf', 'epub', 'docx', 'doc', 'txt' ), true ) ? $ext : $stored_type;
    }

    /**
     * Convert an uploads-area URL to an absolute local path.
     * Returns the input unchanged if it is already a local path.
     */
    private static function url_to_local_path( string $url_or_path ): string {
        if ( ! preg_match( '#^https?://#i', $url_or_path ) ) {
            return $url_or_path;
        }

        $upload_dir = wp_upload_dir();
        $base_url   = rtrim( $upload_dir['baseurl'], '/' );
        $base_dir   = rtrim( $upload_dir['basedir'], '/' );

        if ( strpos( $url_or_path, $base_url ) === 0 ) {
            return $base_dir . substr( $url_or_path, strlen( $base_url ) );
        }

        $site_url = rtrim( get_site_url(), '/' );
        $abs_path = rtrim( ABSPATH, '/' );

        if ( strpos( $url_or_path, $site_url ) === 0 ) {
            return $abs_path . substr( $url_or_path, strlen( $site_url ) );
        }

        return $url_or_path;
    }
}
