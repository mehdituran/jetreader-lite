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
    private const MAX_CONTENT_LEN = 10000;

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

        // Apostrophe, double-quote, or dash variants → LIKE so get_query_variants can
        // expand them to all typographic forms and find the content regardless of encoding.
        if ( self::query_has_apostrophe( $query )
            || self::query_has_chars( $query, self::DQUOTE_CHARS )
            || self::query_has_chars( $query, self::DASH_CHARS ) ) {
            return self::search_like( $query, $limit, $per_item );
        }

        // FULLTEXT BOOLEAN MODE operatörlerini içeren sorgular LIKE'a yönlendir.
        // Diğer özel karakterler: + > < ~ * " @ ( )
        if ( preg_match( '/[-+"~*><@()]/u', $query ) ) {
            return self::search_like( $query, $limit, $per_item );
        }

        $table = $wpdb->prefix . 'jetreader_search_index';

        // Q1: True total per item — no content column, very fast.
        // phpcs:ignore WordPress.DB.DirectDatabaseQuery.NoCaching, WordPress.DB.DirectDatabaseQuery.DirectQuery, WordPress.DB.PreparedSQL.InterpolatedNotPrepared
        $totals_raw = $wpdb->get_results( $wpdb->prepare(
            "SELECT item_id, SUM((CHAR_LENGTH(content) - CHAR_LENGTH(REPLACE(LOWER(content), LOWER(%s), ''))) / CHAR_LENGTH(%s)) AS total
             FROM `{$table}`
             WHERE MATCH(content) AGAINST (%s IN BOOLEAN MODE)
             GROUP BY item_id
             LIMIT %d",
            $query,
            $query,
            $query, // No wildcard '*' to enforce exact word boundary matching by MySQL FULLTEXT
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
            $totals[ $id ] = max( 1, (int) $row->total );
            $item_ids[]    = $id;
        }

        // Q2: Per-item queries — each item gets exactly $per_item earliest pages.
        $all_rows = array();
        foreach ( $item_ids as $id ) {
            // phpcs:ignore WordPress.DB.DirectDatabaseQuery.NoCaching, WordPress.DB.DirectDatabaseQuery.DirectQuery, WordPress.DB.PreparedSQL.InterpolatedNotPrepared
            $item_rows = $wpdb->get_results( $wpdb->prepare(
                "SELECT item_id, volume_idx, page_num, content
                 FROM `{$table}`
                 WHERE MATCH(content) AGAINST (%s IN BOOLEAN MODE)
                   AND item_id = %d
                 ORDER BY page_num ASC",
                $query, // No wildcard '*'
                $id
            ) );

            $count = 0;
            foreach ( (array) $item_rows as $r ) {
                if ( self::has_word_match( $r->content, $query ) ) {
                    $pos = mb_strpos( mb_strtolower( $r->content ), mb_strtolower( $query ) );
                    $start_pos = max( 0, $pos - 80 );
                    $r->excerpt = mb_substr( $r->content, $start_pos, 250 );
                    unset( $r->content );
                    $all_rows[] = $r;
                    $count++;
                    if ( $count >= $per_item ) {
                        break;
                    }
                }
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

        $sum_parts = array();
        $sum_params = array();
        foreach ( $variants as $var ) {
            $sum_parts[] = "(CHAR_LENGTH(content) - CHAR_LENGTH(REPLACE(LOWER(content), LOWER(%s), ''))) / CHAR_LENGTH(%s)";
            $sum_params[] = $var;
            $sum_params[] = $var;
        }
        $sql_sum = "SUM(" . implode( ' + ', $sum_parts ) . ")";

        $prep_params = array_merge( $sum_params, $params );

        // phpcs:ignore WordPress.DB.DirectDatabaseQuery.NoCaching, WordPress.DB.DirectDatabaseQuery.DirectQuery, WordPress.DB.PreparedSQL.InterpolatedNotPrepared
        $totals_raw = $wpdb->get_results( $wpdb->prepare(
            "SELECT item_id, {$sql_sum} AS total
             FROM `{$table}`
             WHERE {$sql_cond}
             GROUP BY item_id
             LIMIT %d",
            ...$prep_params
        ) );

        if ( empty( $totals_raw ) ) {
            return array();
        }

        $totals   = array();
        $item_ids = array();
        foreach ( $totals_raw as $row ) {
            $id            = (int) $row->item_id;
            $totals[ $id ] = max( 1, (int) $row->total );
            $item_ids[]    = $id;
        }

        // Per-item queries — each item gets exactly $per_item earliest pages.
        $all_rows = array();
        foreach ( $item_ids as $id ) {
            $item_conditions = array();
            $item_params     = array();

            foreach ( $variants as $var ) {
                $item_conditions[] = "content LIKE %s";
                $item_params[]     = '%' . $wpdb->esc_like( $var ) . '%';
            }

            $sql_item_cond = implode( ' OR ', $item_conditions );
            $query_params  = array_merge( $item_params, array( $id ) );

            // phpcs:ignore WordPress.DB.DirectDatabaseQuery.NoCaching, WordPress.DB.DirectDatabaseQuery.DirectQuery, WordPress.DB.PreparedSQL.InterpolatedNotPrepared
            $item_rows = $wpdb->get_results( $wpdb->prepare(
                "SELECT item_id, volume_idx, page_num, content
                 FROM `{$table}`
                 WHERE ({$sql_item_cond})
                   AND item_id = %d
                 ORDER BY page_num ASC",
                ...$query_params
            ) );

            $count = 0;
            foreach ( (array) $item_rows as $r ) {
                $matched_var = null;
                foreach ( $variants as $var ) {
                    if ( self::has_word_match( $r->content, $var ) ) {
                        $matched_var = $var;
                        break;
                    }
                }

                if ( $matched_var !== null ) {
                    $pos = mb_strpos( mb_strtolower( $r->content ), mb_strtolower( $matched_var ) );
                    $start_pos = max( 0, $pos - 80 );
                    $r->excerpt = mb_substr( $r->content, $start_pos, 250 );
                    unset( $r->content );
                    $all_rows[] = $r;
                    $count++;
                    if ( $count >= $per_item ) {
                        break;
                    }
                }
            }
        }

        return self::group_rows( $all_rows, $totals, $per_item );
    }

    /**
     * Single-quote / apostrophe variants (keyboard straight ↔ typographic ↔ modifier letters).
     * U+02BE = RIGHT HALF RING used in Arabic romanization for hamza (ʾ).
     * U+02BF = LEFT HALF RING used in Arabic romanization for ʿain (ʿ).
     */
    private const APOS_CHARS = [
        "\u{0027}", // APOSTROPHE (straight/keyboard)
        "\u{2018}", // LEFT SINGLE QUOTATION MARK
        "\u{2019}", // RIGHT SINGLE QUOTATION MARK (Word/PDF smart quote)
        "\u{201A}", // SINGLE LOW-9 QUOTATION MARK
        "\u{201B}", // SINGLE HIGH-REVERSED-9 QUOTATION MARK
        "\u{02BC}", // MODIFIER LETTER APOSTROPHE (transliteration)
        "\u{02BB}", // MODIFIER LETTER TURNED COMMA (Hawaiian/romanization)
        "\u{FF07}", // FULLWIDTH APOSTROPHE (CJK documents)
        "\u{02BE}", // MODIFIER LETTER RIGHT HALF RING (Arabic romanization)
        "\u{02BF}", // MODIFIER LETTER LEFT HALF RING (Arabic ʿain romanization)
        "\u{0060}", // GRAVE ACCENT / BACKTICK (sometimes used as apostrophe)
    ];

    /** Curly/guillemet double-quote variants → keyboard " (U+0022). */
    private const DQUOTE_CHARS = [
        '"',        // QUOTATION MARK (straight/keyboard) — literal to avoid \u{0022} closing the string
        "\u{201C}", // LEFT DOUBLE QUOTATION MARK
        "\u{201D}", // RIGHT DOUBLE QUOTATION MARK
        "\u{201E}", // DOUBLE LOW-9 QUOTATION MARK (German)
        "\u{201F}", // DOUBLE HIGH-REVERSED-9 QUOTATION MARK
        "\u{00AB}", // LEFT-POINTING DOUBLE ANGLE QUOTATION MARK (guillemet)
        "\u{00BB}", // RIGHT-POINTING DOUBLE ANGLE QUOTATION MARK
        "\u{FF02}", // FULLWIDTH QUOTATION MARK
    ];

    /** Dash/hyphen variants → keyboard - (U+002D). */
    private const DASH_CHARS = [
        "\u{002D}", // HYPHEN-MINUS (keyboard)
        "\u{2010}", // HYPHEN
        "\u{2011}", // NON-BREAKING HYPHEN
        "\u{2012}", // FIGURE DASH
        "\u{2013}", // EN DASH
        "\u{2014}", // EM DASH
        "\u{2015}", // HORIZONTAL BAR
        "\u{2212}", // MINUS SIGN
        "\u{FF0D}", // FULLWIDTH HYPHEN-MINUS
    ];

    /** Returns true if the query contains any character from the given set. */
    private static function query_has_chars( string $query, array $chars ): bool {
        foreach ( $chars as $ch ) {
            if ( str_contains( $query, $ch ) ) {
                return true;
            }
        }
        return false;
    }

    /**
     * Returns true if the query contains any apostrophe/quote-like character.
     */
    private static function query_has_apostrophe( string $query ): bool {
        return self::query_has_chars( $query, self::APOS_CHARS );
    }

    /**
     * Helper to perform Unicode-safe whole-word matching.
     */
    private static function has_word_match( string $content, string $query ): bool {
        $q = mb_strtolower( $query );
        $text = mb_strtolower( $content );
        $q_len = mb_strlen( $q );
        if ( $q_len === 0 ) {
            return false;
        }

        $pos = mb_strpos( $text, $q );
        if ( false === $pos ) {
            return false;
        }

        $is_word_char = function( string $char ): bool {
            return (bool) preg_match( '/[\p{L}\p{N}]/u', $char );
        };

        $q_starts_word = $is_word_char( mb_substr( $q, 0, 1 ) );
        $q_ends_word = $is_word_char( mb_substr( $q, $q_len - 1, 1 ) );

        while ( false !== $pos ) {
            $valid = true;
            if ( $q_starts_word && $pos > 0 ) {
                $prev_char = mb_substr( $text, $pos - 1, 1 );
                if ( $is_word_char( $prev_char ) ) {
                    $valid = false;
                }
            }
            if ( $q_ends_word && ( $pos + $q_len ) < mb_strlen( $text ) ) {
                $next_char = mb_substr( $text, $pos + $q_len, 1 );
                if ( $is_word_char( $next_char ) ) {
                    $valid = false;
                }
            }
            if ( $valid ) {
                return true;
            }
            $pos = mb_strpos( $text, $q, $pos + 1 );
        }

        return false;
    }

    /**
     * Expand search query to include all typographic-character variants.
     * Handles single quotes (apostrophes), double quotes, and dashes so that
     * a user typing the keyboard character matches any variant in the document.
     *
     * @param string $query Original search query.
     * @return string[] Unique variants of the query to search.
     */
    private static function get_query_variants( string $query ): array {
        $variants = [ $query ];

        // --- Single-quote / apostrophe variants ---
        if ( self::query_has_chars( $query, self::APOS_CHARS ) ) {
            foreach ( self::APOS_CHARS as $replacement ) {
                $variants[] = str_replace( self::APOS_CHARS, $replacement, $query );
            }
        }

        // --- Double-quote variants ---
        if ( self::query_has_chars( $query, self::DQUOTE_CHARS ) ) {
            foreach ( self::DQUOTE_CHARS as $replacement ) {
                $variants[] = str_replace( self::DQUOTE_CHARS, $replacement, $query );
            }
        }

        // --- Dash variants ---
        if ( self::query_has_chars( $query, self::DASH_CHARS ) ) {
            // Variant: no dash (compounds sometimes written without)
            $stripped_dash = str_replace( self::DASH_CHARS, '', $query );
            if ( $stripped_dash !== $query && mb_strlen( $stripped_dash ) >= 2 ) {
                $variants[] = $stripped_dash;
            }
            foreach ( self::DASH_CHARS as $replacement ) {
                $variants[] = str_replace( self::DASH_CHARS, $replacement, $query );
            }
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

        // Filter out any items that ended up with 0 actual word matches after post-filtering
        $filtered = array();
        foreach ( $grouped as $id => $data ) {
            if ( ! empty( $data['matches'] ) ) {
                $filtered[ $id ] = $data;
            }
        }

        return $filtered;
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
        $vol_counts = array();

        foreach ( $files as $vol_idx => $file_info ) {
            $pages = JetReader_Parser_Engine::extract_all_pages( $file_info['path'], $file_info['type'] );
            $vol_counts[ $vol_idx ] = count( $pages );
            foreach ( $pages as &$p ) {
                $p['volume_idx'] = $vol_idx;
            }
            unset( $p );
            $all_pages = array_merge( $all_pages, $pages );
        }

        // populate() always deletes existing rows first — safe to call repeatedly.
        self::populate( $item_id, $all_pages );

        // Update page_count and volumes (with individual page counts) in the items table.
        $update_data = array( 'page_count' => count( $all_pages ) );
        if ( ! empty( $item->volumes ) && ! empty( $vol_counts ) ) {
            $decoded = json_decode( $item->volumes, true );
            if ( is_array( $decoded ) ) {
                foreach ( $decoded as $idx => &$vol ) {
                    if ( isset( $vol_counts[ $idx ] ) ) {
                        $vol['page_count'] = $vol_counts[ $idx ];
                    }
                }
                unset( $vol );
                $update_data['volumes'] = wp_json_encode( $decoded );
            }
        }

        // phpcs:ignore WordPress.DB.DirectDatabaseQuery.DirectQuery
        $wpdb->update(
            "{$wpdb->prefix}jetreader_items",
            $update_data,
            array( 'id' => $item_id )
        );

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
                $vol_counts = array();
                foreach ( $files as $vol_idx => $file_info ) {
                    $pages = JetReader_Parser_Engine::extract_all_pages(
                        $file_info['path'],
                        $file_info['type']
                    );
                    $vol_counts[ $vol_idx ] = count( $pages );
                    foreach ( $pages as &$p ) {
                        $p['volume_idx'] = $vol_idx;
                    }
                    unset( $p );
                    $all_pages = array_merge( $all_pages, $pages );
                }

                if ( ! empty( $all_pages ) ) {
                    // Write into the shadow table instead of the live one.
                    self::populate_table( (int) $item->id, $all_pages, $tmp_table );

                    // Update page_count and volumes (with individual page counts) in the items table.
                    $update_data = array( 'page_count' => count( $all_pages ) );
                    if ( ! empty( $item->volumes ) && ! empty( $vol_counts ) ) {
                        $decoded = json_decode( $item->volumes, true );
                        if ( is_array( $decoded ) ) {
                            foreach ( $decoded as $idx => &$vol ) {
                                if ( isset( $vol_counts[ $idx ] ) ) {
                                    $vol['page_count'] = $vol_counts[ $idx ];
                                }
                            }
                            unset( $vol );
                            $update_data['volumes'] = wp_json_encode( $decoded );
                        }
                    }

                    // phpcs:ignore WordPress.DB.DirectDatabaseQuery.DirectQuery
                    $wpdb->update(
                        "{$wpdb->prefix}jetreader_items",
                        $update_data,
                        array( 'id' => (int) $item->id )
                    );

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
                $content = mb_substr( (string) ( $page['content'] ?? '' ), 0, self::MAX_CONTENT_LEN );
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

            // Escaping the table name via esc_sql before query construction. Placeholders are safe and must not be escaped, otherwise prepare() fails to match format specifiers.
            $escaped_table = esc_sql( $table );
            $placeholders_str = implode( ', ', $placeholders );
            $sql = "INSERT INTO `{$escaped_table}` (item_id, volume_idx, page_num, content) VALUES {$placeholders_str}";
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
                    $is_temp = false;

                    if ( $path && preg_match( '#^https?://#i', $path ) ) {
                        $downloaded = self::download_remote_file_to_temp( $path );
                        if ( ! is_wp_error( $downloaded ) && file_exists( $downloaded ) ) {
                            $path = $downloaded;
                            $is_temp = true;
                        } else {
                            continue;
                        }
                    }

                    if ( $path && file_exists( $path ) ) {
                        $files[ $idx ] = array( 'path' => $path, 'type' => $type, 'is_temp' => $is_temp );
                    }
                }
            }
        }

        if ( empty( $files ) && ! empty( $item->file_path ) ) {
            $url = $item->file_path;
            $path = self::url_to_local_path( $url );
            $type     = self::detect_type( $url, $item->file_type ?? '' );
            $is_temp = false;

            if ( $path && preg_match( '#^https?://#i', $path ) ) {
                $downloaded = self::download_remote_file_to_temp( $path );
                if ( ! is_wp_error( $downloaded ) && file_exists( $downloaded ) ) {
                    $path = $downloaded;
                    $is_temp = true;
                }
            }

            if ( $path && file_exists( $path ) ) {
                $files[0] = array( 'path' => $path, 'type' => $type, 'is_temp' => $is_temp );
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

    /**
     * Download a remote file to a temporary local path.
     */
    private static function download_remote_file_to_temp( string $url ) {
        if ( ! function_exists( 'download_url' ) ) {
            require_once ABSPATH . 'wp-admin/includes/file.php';
        }

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
                if ( self::is_private_ip( $resolved_ip ) ) {
                    return new WP_Error( 'jetreader_private_ip', 'Internal resource download blocked.' );
                }
            }
        }

        $tmp_file = download_url( $url, 30 ); // 30 seconds timeout.
        return $tmp_file;
    }

    /**
     * Check if an IP address is in a private or reserved range.
     */
    private static function is_private_ip( string $ip ): bool {
        if ( ! filter_var( $ip, FILTER_VALIDATE_IP ) ) {
            return true;
        }
        return ! filter_var(
            $ip,
            FILTER_VALIDATE_IP,
            FILTER_FLAG_NO_PRIV_RANGE | FILTER_FLAG_NO_RES_RANGE
        );
    }
}
