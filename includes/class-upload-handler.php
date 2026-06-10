<?php
/**
 * Upload handler class.
 *
 * @package JetReader
 */

// If this file is called directly, abort.
if ( ! defined( 'WPINC' ) ) {
    die;
}

/**
 * Class JetReader_Upload_Handler
 *
 * Handles file uploads and processing pipeline.
 */
class JetReader_Upload_Handler {

    /**
     * Allowed MIME types.
     *
     * @var array
     */
    private $allowed_mimes = array(
        'epub' => 'application/epub+zip',
        'pdf'  => 'application/pdf',
        'txt'  => 'text/plain',
        'doc'  => 'application/msword',
        'docx' => 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        'jpg'  => 'image/jpeg',
        'jpeg' => 'image/jpeg',
        'png'  => 'image/png',
        'webp' => 'image/webp',
        'gif'  => 'image/gif',
        'svg'  => 'image/svg+xml',
    );

    private $image_exts = array( 'jpg', 'jpeg', 'png', 'webp', 'gif', 'svg' );

    /**
     * Handle file upload from REST API request.
     */
    public function handle_upload( $request ) {
        $files = $request->get_file_params();

        if ( empty( $files['file'] ) ) {
            return new WP_Error(
                'jetreader_no_file',
                __( 'No file was uploaded.', 'jetreader' ),
                array( 'status' => 400 )
            );
        }

        $file = $files['file'];

        // Validate file extension.
        $extension = strtolower( pathinfo( $file['name'], PATHINFO_EXTENSION ) );

        if ( ! array_key_exists( $extension, $this->allowed_mimes ) ) {
            return new WP_Error(
                'jetreader_invalid_type',
                sprintf(
                    /* translators: %s: file extension */
                    __( 'File type .%s is not supported.', 'jetreader' ),
                    esc_html( $extension )
                ),
                array( 'status' => 400 )
            );
        }

        // Validate real MIME type via magic bytes (prevents disguised uploads).
        if ( function_exists( 'finfo_open' ) ) {
            $finfo     = finfo_open( FILEINFO_MIME_TYPE );
            $real_mime = finfo_file( $finfo, $file['tmp_name'] );
            finfo_close( $finfo );

            $expected_mime = $this->allowed_mimes[ $extension ];
            // Allow application/zip as a valid magic-byte result for epub (zip-based format).
            $zip_exts      = array( 'epub' );
            // For images, allow any image/* MIME type to accommodate minor browser variations.
            $is_image = in_array( $extension, $this->image_exts, true );
            $mime_ok  = ( $real_mime === $expected_mime )
                || ( in_array( $extension, $zip_exts, true ) && 'application/zip' === $real_mime )
                || ( $is_image && strpos( $real_mime, 'image/' ) === 0 );

            if ( ! $mime_ok ) {
                return new WP_Error(
                    'jetreader_mime_mismatch',
                    __( 'File content does not match the declared file type.', 'jetreader' ),
                    array( 'status' => 400 )
                );
            }
        }

        // Validate file size.
        $settings  = get_option( 'jetreader_settings', array() );
        $max_size  = isset( $settings['upload_max_size'] ) ? intval( $settings['upload_max_size'] ) * 1024 * 1024 : 100 * 1024 * 1024;
        $file_size = $file['size'];

        if ( $file_size > $max_size ) {
            return new WP_Error(
                'jetreader_file_too_large',
                sprintf(
                    /* translators: %s: max file size */
                    __( 'File size exceeds the maximum allowed size of %s MB.', 'jetreader' ),
                    esc_html( $settings['upload_max_size'] ?? '100' )
                ),
                array( 'status' => 400 )
            );
        }

        // Use WordPress upload API to benefit from upload filters and hooks.
        if ( ! function_exists( 'wp_handle_upload' ) ) {
            require_once ABSPATH . 'wp-admin/includes/file.php';
        }

        $overrides = array(
            'test_form'   => false,
            'test_type'   => false,
            'mimes'       => $this->allowed_mimes,
        );

        $uploaded = wp_handle_upload( $file, $overrides );

        if ( isset( $uploaded['error'] ) ) {
            return new WP_Error(
                'jetreader_upload_failed',
                $uploaded['error'],
                array( 'status' => 500 )
            );
        }

        // Move file from default WP uploads dir into the JetReader subdirectory.
        $upload_dir    = wp_upload_dir();
        $jetreader_dir = $upload_dir['basedir'] . '/jetreader';

        if ( ! file_exists( $jetreader_dir ) ) {
            wp_mkdir_p( $jetreader_dir );
        }

        $unique_name = wp_unique_filename( $jetreader_dir, sanitize_file_name( $file['name'] ) );
        $destination = $jetreader_dir . '/' . $unique_name;

        global $wp_filesystem;
        if ( empty( $wp_filesystem ) ) {
            require_once ABSPATH . 'wp-admin/includes/file.php';
            WP_Filesystem();
        }

        if ( ! empty( $wp_filesystem ) ) {
            $moved = $wp_filesystem->move( $uploaded['file'], $destination );
        } else {
            // phpcs:ignore WordPress.WP.AlternativeFunctions.rename_rename
            $moved = @rename( $uploaded['file'], $destination );
        }

        if ( ! $moved ) {
            if ( ! empty( $wp_filesystem ) ) {
                $wp_filesystem->delete( $uploaded['file'] );
            } else {
                // phpcs:ignore WordPress.WP.AlternativeFunctions.unlink_unlink
                @unlink( $uploaded['file'] );
            }
            return new WP_Error(
                'jetreader_upload_failed',
                __( 'Failed to save uploaded file.', 'jetreader' ),
                array( 'status' => 500 )
            );
        }

        // Get file URL.
        $file_url = $upload_dir['baseurl'] . '/jetreader/' . $unique_name;

        // Images don't need metadata extraction or chapter parsing.
        if ( in_array( $extension, $this->image_exts, true ) ) {
            return rest_ensure_response(
                array(
                    'file_name' => $unique_name,
                    'file_url'  => $file_url,
                    'file_path' => $destination,
                    'file_type' => $extension,
                    'file_size' => $file_size,
                    'metadata'  => array(),
                    'message'   => __( 'Image uploaded successfully.', 'jetreader' ),
                )
            );
        }

        // Extract metadata based on file type.
        $metadata = $this->extract_metadata( $destination, $extension );

        // Parse chapters (for TOC / chapter list in the reader).
        require_once JETREADER_PLUGIN_DIR . 'includes/class-parser-engine.php';
        $parser   = new JetReader_Parser_Engine();
        $chapters = $parser->parse_chapters( $destination, $extension );

        return rest_ensure_response(
            array(
                'file_name'      => $unique_name,
                'file_url'       => $file_url,
                'file_path'      => $destination,
                'file_type'      => $extension,
                'file_size'      => $file_size,
                'metadata'       => $metadata,
                'chapters'       => $chapters,
                'chapters_count' => count( $chapters ),
                'message'        => __( 'File uploaded and processed successfully.', 'jetreader' ),
            )
        );
    }

    /**
     * Schedule a background WP-Cron job to index the full text of an item.
     * Called after the item row is saved to the DB (item_id is known).
     *
     * We deliberately schedule for 10 seconds from now so the current HTTP
     * request finishes before the heavy parse work begins.
     *
     * @param int    $item_id   jetreader_items.id
     * @param string $file_path Absolute path to the uploaded file.
     * @param string $file_type File extension.
     */
    /**
     * @param string $file_path Unused — kept for backward compatibility with callers.
     * @param string $file_type Unused — kept for backward compatibility with callers.
     *                         run_index_job now reads all volumes from the DB itself.
     */
    public static function schedule_index( int $item_id, string $file_path = '', string $file_type = '' ): void {
        if ( ! $item_id ) {
            return;
        }

        // Store a minimal flag — actual paths are resolved from the DB at run time
        // so all volumes are always processed in a single job.
        set_transient(
            'jetreader_index_job_' . $item_id,
            array( 'item_id' => $item_id ),
            HOUR_IN_SECONDS
        );

        // Schedule once using Action Scheduler if available, otherwise fallback to WP-Cron.
        if ( function_exists( 'as_has_scheduled_action' ) ) {
            if ( ! as_has_scheduled_action( 'jetreader_index_item', array( $item_id ), 'jetreader' ) ) {
                as_schedule_single_action( time() + 10, 'jetreader_index_item', array( $item_id ), 'jetreader' );
            }
        } else {
            if ( ! wp_next_scheduled( 'jetreader_index_item', array( $item_id ) ) ) {
                wp_schedule_single_event( time() + 10, 'jetreader_index_item', array( $item_id ) );
            }
        }
    }

    /**
     * Convert a URL that lives under the uploads directory to an absolute local path.
     * If the argument is already a local path, return it unchanged.
     */
    public static function url_to_local_path( string $url_or_path ): string {
        if ( ! preg_match( '#^https?://#i', $url_or_path ) ) {
            return $url_or_path;
        }

        $upload_dir = wp_upload_dir();
        $base_url   = rtrim( $upload_dir['baseurl'], '/' );
        $base_dir   = rtrim( $upload_dir['basedir'], '/' );

        if ( strpos( $url_or_path, $base_url ) === 0 ) {
            return $base_dir . substr( $url_or_path, strlen( $base_url ) );
        }

        // Fallback: replace site URL with ABSPATH (handles non-uploads URLs).
        $site_url = rtrim( get_site_url(), '/' );
        $abs_path = rtrim( ABSPATH, '/' );

        if ( strpos( $url_or_path, $site_url ) === 0 ) {
            return $abs_path . substr( $url_or_path, strlen( $site_url ) );
        }

        return $url_or_path;
    }

    /**
     * Execute the indexing job. Called by WP-Cron via 'jetreader_index_item' hook.
     *
     * @param int $item_id jetreader_items.id
     */
    public static function run_index_job( int $item_id ): void {
        $job = get_transient( 'jetreader_index_job_' . $item_id );
        if ( ! $job ) {
            return;
        }

        // Per-item lock: if another worker is already indexing this item,
        // reschedule for 2 minutes later instead of running in parallel.
        $lock_key = 'jetreader_indexing_' . $item_id;
        if ( get_transient( $lock_key ) ) {
            if ( function_exists( 'as_schedule_single_action' ) ) {
                as_schedule_single_action( time() + 120, 'jetreader_index_item', array( $item_id ), 'jetreader' );
            } else {
                wp_schedule_single_event( time() + 120, 'jetreader_index_item', array( $item_id ) );
            }
            return;
        }
        set_transient( $lock_key, 1, 15 * MINUTE_IN_SECONDS );

        try {
            delete_transient( 'jetreader_index_job_' . $item_id );

            // GhostScript can take 10–60 s for large PDFs; let it finish.
            // phpcs:ignore Squiz.PHP.DiscouragedFunctions.Discouraged
            @set_time_limit( 0 );

            if ( ! class_exists( 'JetReader_Parser_Engine' ) ) {
                require_once JETREADER_PLUGIN_DIR . 'includes/class-parser-engine.php';
            }
            if ( ! class_exists( 'JetReader_Search_Index' ) ) {
                require_once JETREADER_PLUGIN_DIR . 'includes/class-search-index.php';
            }

            // Read the item from DB so we pick up ALL volumes, not just the first one.
            global $wpdb;
            // phpcs:ignore WordPress.DB.DirectDatabaseQuery.DirectQuery, WordPress.DB.DirectDatabaseQuery.NoCaching, WordPress.DB.PreparedSQL.InterpolatedNotPrepared
            $item = $wpdb->get_row( $wpdb->prepare(
                "SELECT id, file_path, file_type, volumes FROM {$wpdb->prefix}jetreader_items WHERE id = %d",
                $item_id
            ) );

            if ( ! $item ) {
                return;
            }

            // Clear existing chapters first.
            $wpdb->delete( "{$wpdb->prefix}jetreader_chapters", array( 'item_id' => $item_id ) );

            // resolve_files() handles both single-file and multi-volume items,
            // converting URLs to local paths and verifying they exist.
            $files     = JetReader_Search_Index::resolve_files( $item );
            $all_pages = array();
            $vol_counts = array();
            $page_offset = 0;
            $chapter_order = 0;
            $parser = new JetReader_Parser_Engine();

            foreach ( $files as $vol_idx => $file_info ) {
                $pages = JetReader_Parser_Engine::extract_all_pages( $file_info['path'], $file_info['type'] );
                $vol_counts[ $vol_idx ] = count( $pages );

                // Parse and save chapters.
                $vol_chapters = $parser->parse_chapters( $file_info['path'], $file_info['type'] );
                if ( is_array( $vol_chapters ) ) {
                    foreach ( $vol_chapters as $chap ) {
                        $p_start = ( isset( $chap['page_start'] ) ? intval( $chap['page_start'] ) : 0 ) + $page_offset;
                        $p_end   = ( isset( $chap['page_end'] ) ? intval( $chap['page_end'] ) : 0 ) + $page_offset;

                        $wpdb->insert(
                            "{$wpdb->prefix}jetreader_chapters",
                            array(
                                'item_id'     => $item_id,
                                'title'       => sanitize_text_field( $chap['title'] ),
                                'content'     => isset( $chap['content'] ) ? wp_kses_post( $chap['content'] ) : '',
                                'order_index' => $chapter_order++,
                                'page_start'  => $p_start,
                                'page_end'    => $p_end,
                            )
                        );
                    }
                }

                foreach ( $pages as &$p ) {
                    $p['volume_idx'] = $vol_idx;
                }
                unset( $p );
                $all_pages = array_merge( $all_pages, $pages );
                $page_offset += count( $pages );
            }

            // populate() deletes all existing rows for the item before inserting,
            // so all volumes land in one atomic operation.
            if ( ! empty( $all_pages ) ) {
                JetReader_Search_Index::populate( $item_id, $all_pages );

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
            }

            // Also ensure the CPT post exists / is up-to-date.
            if ( class_exists( 'JetReader_CPT' ) ) {
                JetReader_CPT::sync_from_item( $item_id );
            }

        } finally {
            // Cleanup temp downloaded files.
            if ( isset( $files ) && is_array( $files ) ) {
                foreach ( $files as $file_info ) {
                    if ( ! empty( $file_info['is_temp'] ) && file_exists( $file_info['path'] ) ) {
                        @unlink( $file_info['path'] );
                    }
                }
            }
            delete_transient( $lock_key );
        }
    }

    /**
     * Extract metadata from uploaded file.
     */
    private function extract_metadata( $file_path, $extension ) {
        $metadata = array(
            'title'       => pathinfo( $file_path, PATHINFO_FILENAME ),
            'author'      => '',
            'language'    => 'en',
            'page_count'  => 0,
            'isbn'        => '',
            'publisher'   => '',
        );

        switch ( $extension ) {
            case 'epub':
                $metadata = $this->extract_ebook_metadata( $file_path, $extension );
                break;

            case 'pdf':
                $metadata = $this->extract_pdf_metadata( $file_path );
                break;

            case 'txt':
                $metadata['page_count'] = $this->estimate_txt_pages( $file_path );
                break;

            case 'doc':
                $metadata = $this->extract_doc_metadata( $file_path );
                break;

            case 'docx':
                $metadata = $this->extract_docx_metadata( $file_path );
                break;
        }

        return $metadata;
    }

    /**
     * Extract metadata from EPUB/MOBI/FB2 files.
     */
    private function extract_ebook_metadata( $file_path, $extension ) {
        $metadata = array(
            'title'       => pathinfo( $file_path, PATHINFO_FILENAME ),
            'author'      => '',
            'language'    => 'en',
            'page_count'  => 0,
            'isbn'        => '',
            'publisher'   => '',
        );

        if ( $extension === 'epub' ) {
            if ( ! class_exists( 'JetReader_Parser_Engine' ) ) {
                require_once JETREADER_PLUGIN_DIR . 'includes/class-parser-engine.php';
            }
            if ( ! JetReader_Parser_Engine::is_safe_zip( $file_path ) ) {
                return $metadata;
            }
            $zip = new ZipArchive();
            if ( $zip->open( $file_path ) === true ) {
                // Try to read container.xml and OPF for metadata.
                $container_xml = $zip->getFromName( 'META-INF/container.xml' );
                if ( $container_xml ) {
                    $xml = simplexml_load_string( $container_xml );
                    if ( $xml ) {
                        $namespaces = $xml->getNamespaces( true );
                        $rootfile = $xml->rootfiles->rootfile;
                        if ( $rootfile ) {
                            $opf_path = (string) $rootfile['full-path'];
                            $opf_content = $zip->getFromName( $opf_path );
                            if ( $opf_content ) {
                                $opf_xml = simplexml_load_string( $opf_content );
                                if ( $opf_xml ) {
                                    $dc = $opf_xml->metadata->children( 'http://purl.org/dc/elements/1.1/' );
                                    $metadata['title']    = (string) $dc->title ?: $metadata['title'];
                                    $metadata['author']   = (string) $dc->creator ?: '';
                                    $metadata['language'] = (string) $dc->language ?: 'en';
                                    $metadata['publisher'] = (string) $dc->publisher ?: '';

                                    // Try to get ISBN from identifier.
                                    foreach ( $dc->identifier as $identifier ) {
                                        $id_str = (string) $identifier;
                                        if ( strlen( $id_str ) === 13 || strlen( $id_str ) === 10 ) {
                                            $metadata['isbn'] = $id_str;
                                            break;
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
                $zip->close();
            }
        }

        return $metadata;
    }

    /**
     * Extract metadata from PDF files.
     */
    private function extract_pdf_metadata( $file_path ) {
        $metadata = array(
            'title'       => pathinfo( $file_path, PATHINFO_FILENAME ),
            'author'      => '',
            'language'    => 'en',
            'page_count'  => 0,
            'isbn'        => '',
            'publisher'   => '',
        );

        // Basic PDF parsing for page count.
        $content = file_get_contents( $file_path, false, null, 0, 500000 );
        if ( $content && preg_match_all( '/\/Type\s*\/Page[^s]/', $content, $matches ) ) {
            $metadata['page_count'] = count( $matches[0] );
        }

        // Try to find PDF title.
        if ( preg_match( '/\/Title\s*\(([^)]+)\)/', $content, $title_match ) ) {
            $metadata['title'] = $title_match[1];
        }

        // Try to find PDF author.
        if ( preg_match( '/\/Author\s*\(([^)]+)\)/', $content, $author_match ) ) {
            $metadata['author'] = $author_match[1];
        }

        return $metadata;
    }

    /**
     * Extract metadata from legacy DOC (OLE binary) files.
     * DOC stores text as UTF-16LE; we scan for readable sequences to estimate page count.
     */
    private function extract_doc_metadata( $file_path ) {
        $metadata = array(
            'title'      => pathinfo( $file_path, PATHINFO_FILENAME ),
            'author'     => '',
            'language'   => 'en',
            'page_count' => 0,
            'isbn'       => '',
            'publisher'  => '',
        );

        $content = file_get_contents( $file_path );
        if ( ! $content ) {
            return $metadata;
        }

        $text = self::extract_doc_text( $content );
        $word_count = str_word_count( $text, 0 );
        $metadata['page_count'] = max( 1, (int) ceil( $word_count / 300 ) );

        return $metadata;
    }

    /**
     * Extract readable text from a DOC binary by scanning for UTF-16LE sequences.
     * Works on any server without external tools.
     *
     * @param string $binary Raw file contents.
     * @return string Plain text.
     */
    private static function extract_doc_text( string $binary ): string {
        $text = '';
        $len  = strlen( $binary );

        for ( $i = 0; $i < $len - 1; $i += 2 ) {
            $lo = ord( $binary[ $i ] );
            $hi = ord( $binary[ $i + 1 ] );

            if ( $hi === 0 && $lo >= 0x20 && $lo <= 0x7E ) {
                $text .= chr( $lo );
            } elseif ( $hi === 0 && ( $lo === 0x0A || $lo === 0x0D ) ) {
                $text .= "\n";
            }
        }

        $text = preg_replace( '/[ \t]{4,}/', "\n", $text );
        $text = preg_replace( '/\n{3,}/', "\n\n", trim( $text ) );

        return $text;
    }

    /**
     * Extract metadata from DOCX files.
     */
    private function extract_docx_metadata( $file_path ) {
        $metadata = array(
            'title'       => pathinfo( $file_path, PATHINFO_FILENAME ),
            'author'      => '',
            'language'    => 'en',
            'page_count'  => 0,
            'isbn'        => '',
            'publisher'   => '',
        );

        if ( ! class_exists( 'JetReader_Parser_Engine' ) ) {
            require_once JETREADER_PLUGIN_DIR . 'includes/class-parser-engine.php';
        }
        if ( ! JetReader_Parser_Engine::is_safe_zip( $file_path ) ) {
            return $metadata;
        }
        $zip = new ZipArchive();
        if ( $zip->open( $file_path ) === true ) {
            // Read core.xml for metadata.
            $core_xml = $zip->getFromName( 'docProps/core.xml' );
            if ( $core_xml ) {
                $xml = simplexml_load_string( $core_xml );
                if ( $xml ) {
                    $dc = $xml->children( 'http://purl.org/dc/elements/1.1/' );
                    $metadata['title']  = (string) $dc->title ?: $metadata['title'];
                    $metadata['author'] = (string) $dc->creator ?: '';
                }
            }

            // Count words for page estimate.
            $document_xml = $zip->getFromName( 'word/document.xml' );
            if ( $document_xml ) {
                $word_count = str_word_count( wp_strip_all_tags( $document_xml ), 0 );
                $metadata['page_count'] = ceil( $word_count / 300 ); // ~300 words per page.
            }

            $zip->close();
        }

        return $metadata;
    }

    /**
     * Estimate page count for TXT files.
     */
    private function estimate_txt_pages( $file_path ) {
        $content = file_get_contents( $file_path );
        $chars = strlen( $content );
        // ~3000 characters per page.
        return ceil( $chars / 3000 );
    }
}