<?php
/**
 * Parser engine class.
 *
 * @package JetReader
 */

// If this file is called directly, abort.
if ( ! defined( 'WPINC' ) ) {
    die;
}

/**
 * Class JetReader_Parser_Engine
 *
 * Handles chapter extraction from various file formats.
 */
class JetReader_Parser_Engine {

    /** Maximum number of entries allowed in a ZIP/EPUB/DOCX archive. */
    const ZIP_MAX_ENTRIES = 10000;

    /** Maximum total uncompressed size allowed (500 MB). */
    const ZIP_MAX_UNCOMPRESSED_BYTES = 524288000;

    /**
     * Validate a ZIP-based archive for zip-bomb and path-traversal attacks.
     * Returns true if safe, false if the archive should be rejected.
     *
     * @param string $file_path Absolute path to the ZIP file.
     * @return bool
     */
    public static function is_safe_zip( string $file_path ): bool {
        $zip = new ZipArchive();
        if ( $zip->open( $file_path ) !== true ) {
            return false;
        }

        $entry_count      = $zip->numFiles;
        $total_uncompressed = 0;

        if ( $entry_count > self::ZIP_MAX_ENTRIES ) {
            $zip->close();
            return false;
        }

        for ( $i = 0; $i < $entry_count; $i++ ) {
            $stat = $zip->statIndex( $i );
            if ( false === $stat ) {
                continue;
            }

            // Block path traversal attempts.
            $name = $stat['name'];
            if ( false !== strpos( $name, '..' ) || '/' === $name[0] ) {
                $zip->close();
                return false;
            }

            $total_uncompressed += $stat['size'];
            if ( $total_uncompressed > self::ZIP_MAX_UNCOMPRESSED_BYTES ) {
                $zip->close();
                return false;
            }
        }

        $zip->close();
        return true;
    }

    /**
     * Extract all pages/chunks of text content from a file for search indexing.
     *
     * Returns an array of rows, each with:
     *   ['volume_idx' => int, 'page_num' => int, 'content' => string]
     *
     * volume_idx is always 0 here; the caller sets the real value for multi-volume items.
     *
     * @param string $file_path Absolute path to the file.
     * @param string $format    File extension (pdf, epub, docx, txt, …).
     * @return array
     */
    public static function extract_all_pages( string $file_path, string $format ): array {
        if ( ! file_exists( $file_path ) || ! is_readable( $file_path ) ) {
            return array();
        }

        // For Word files, ignore stored file_type and detect from actual file magic bytes.
        // This handles the common case where a .doc is stored as file_type='docx' or vice-versa.
        if ( in_array( strtolower( $format ), array( 'doc', 'docx' ), true ) ) {
            $format = self::detect_word_format( $file_path );
        }

        switch ( strtolower( $format ) ) {
            case 'epub':
                return self::index_epub( $file_path );
            case 'pdf':
                return self::index_pdf( $file_path );
            case 'doc':
                return self::index_doc( $file_path );
            case 'docx':
                return self::index_docx( $file_path );
            case 'txt':
            case 'text':
                return self::index_txt( $file_path );
            default:
                return array();
        }
    }

    /**
     * Detect whether a Word file is OOXML (DOCX/ZIP) or legacy OLE2 (DOC)
     * by reading the first 4 magic bytes. Stored file_type is often wrong.
     */
    private static function detect_word_format( string $file_path ): string {
        // phpcs:ignore WordPress.WP.AlternativeFunctions.file_get_contents_file_get_contents
        $magic = file_get_contents( $file_path, false, null, 0, 4 );
        if ( false === $magic ) {
            return 'docx';
        }

        // ZIP magic (PK\x03\x04 or PK\x05\x06) → OOXML = DOCX.
        if ( strlen( $magic ) >= 2 && "\x50\x4B" === substr( $magic, 0, 2 ) ) {
            return 'docx';
        }
        // OLE2 compound document magic D0 CF 11 E0 → legacy DOC.
        if ( $magic === "\xD0\xCF\x11\xE0" ) {
            return 'doc';
        }

        return 'docx'; // safe default
    }

    /**
     * Extract text from an EPUB file, chunking long text into ~1500-char pages.
     */
    private static function index_epub( string $file_path ): array {
        $pages = array();

        if ( ! self::is_safe_zip( $file_path ) ) {
            return $pages;
        }

        $zip = new ZipArchive();

        if ( $zip->open( $file_path ) !== true ) {
            return $pages;
        }

        // Try to read container.xml and parse OPF to resolve linear spine order
        $files_to_read = array();
        $container_xml = $zip->getFromName( 'META-INF/container.xml' );
        
        if ( $container_xml ) {
            $xml = @simplexml_load_string( $container_xml );
            if ( $xml && isset( $xml->rootfiles->rootfile ) ) {
                $rootfile = $xml->rootfiles->rootfile;
                $opf_path = (string) $rootfile['full-path'];
                $opf_content = $zip->getFromName( $opf_path );
                
                if ( $opf_content ) {
                    $opf_xml = @simplexml_load_string( $opf_content );
                    if ( $opf_xml ) {
                        $opf_dir = str_contains( $opf_path, '/' ) ? substr( $opf_path, 0, strrpos( $opf_path, '/' ) + 1 ) : '';
                        $opf_xml->registerXPathNamespace( 'opf', 'http://www.idpf.org/2007/opf' );
                        
                        // Parse manifest (id -> href)
                        $manifest_items = $opf_xml->xpath( '//opf:manifest/opf:item' );
                        $manifest = array();
                        if ( is_array( $manifest_items ) ) {
                            foreach ( $manifest_items as $item ) {
                                $id = (string) $item['id'];
                                $href = (string) $item['href'];
                                if ( $id && $href ) {
                                    $clean_href = $opf_dir . urldecode( $href );
                                    // Remove anchors if present
                                    $clean_href = explode( '#', $clean_href )[0];
                                    $manifest[ $id ] = $clean_href;
                                }
                            }
                        }
                        
                        // Parse spine (linear refs)
                        $spine_items = $opf_xml->xpath( '//opf:spine/opf:itemref' );
                        if ( is_array( $spine_items ) ) {
                            foreach ( $spine_items as $itemref ) {
                                $idref = (string) $itemref['idref'];
                                $linear = (string) $itemref['linear'];
                                if ( $idref && 'no' !== strtolower( $linear ) && isset( $manifest[ $idref ] ) ) {
                                    $files_to_read[] = $manifest[ $idref ];
                                }
                            }
                        }
                    }
                }
            }
        }

        // Fallback: If spine could not be resolved, read all html/xhtml files sequentially in ZIP physical order
        if ( empty( $files_to_read ) ) {
            for ( $i = 0; $i < $zip->numFiles; $i++ ) {
                $name = $zip->getNameIndex( $i );
                if ( ! $name ) {
                    continue;
                }
                $ext = strtolower( pathinfo( $name, PATHINFO_EXTENSION ) );
                if ( in_array( $ext, array( 'html', 'htm', 'xhtml' ), true ) ) {
                    $files_to_read[] = $name;
                }
            }
        }

        // Extract pages/chunks in the resolved spine order
        foreach ( $files_to_read as $filename ) {
            $html = $zip->getFromName( $filename );
            if ( ! $html ) {
                continue;
            }
            
            $text = self::html_to_text( $html );
            if ( '' !== trim( $text ) ) {
                // Split the section text into ~1500-character chunks to match DOCX/TXT indexing
                $paragraphs = explode( "\n", $text );
                $chunk      = '';

                foreach ( $paragraphs as $para ) {
                    $para = trim( $para );
                    if ( '' === $para ) {
                        continue;
                    }
                    $chunk .= $para . "\n";

                    if ( mb_strlen( $chunk ) >= 1500 ) {
                        $pages[] = array(
                            'volume_idx' => 0,
                            'page_num'   => count( $pages ),
                            'content'    => trim( $chunk ),
                        );
                        $chunk = '';
                    }
                }

                if ( '' !== trim( $chunk ) ) {
                    $pages[] = array(
                        'volume_idx' => 0,
                        'page_num'   => count( $pages ),
                        'content'    => trim( $chunk ),
                    );
                }
            }
        }

        $zip->close();
        return $pages;
    }

    /**
     * Extract text from a PDF.
     * Tries ghostscript first (handles encrypted/compressed PDFs); falls back to
     * pure-PHP regex extraction for environments without gs installed.
     */
    private static function index_pdf( string $file_path ): array {
        if ( self::gs_available() ) {
            $pages = self::index_pdf_via_gs( $file_path );
            if ( ! empty( $pages ) ) {
                return $pages;
            }
        }

        // Try parsing using Smalot PDF Parser library
        $pages = self::index_pdf_via_library( $file_path );
        if ( ! empty( $pages ) ) {
            return $pages;
        }

        return self::index_pdf_regex( $file_path );
    }

    /**
     * Extract text from a PDF using Smalot/PdfParser library.
     */
    private static function index_pdf_via_library( string $file_path ): array {
        $pages = array();
        if ( ! class_exists( 'Smalot\PdfParser\Parser' ) ) {
            return $pages;
        }

        try {
            $parser = new \Smalot\PdfParser\Parser();
            $pdf = $parser->parseFile( $file_path );
            $pdf_pages = $pdf->getPages();

            foreach ( $pdf_pages as $idx => $pdf_page ) {
                $text = $pdf_page->getText();
                $text = trim( $text );
                
                // Normalize spaces and newlines
                $text = html_entity_decode( $text, ENT_QUOTES | ENT_HTML5, 'UTF-8' );
                $text = str_replace( "\xc2\xa0", ' ', $text );
                $text = preg_replace( '/[ \t]+/', ' ', $text );
                $text = preg_replace( '/\n{3,}/', "\n\n", $text );

                if ( mb_strlen( $text ) >= 10 ) {
                    $pages[] = array(
                        'volume_idx' => 0,
                        'page_num'   => $idx,
                        'content'    => $text,
                    );
                }
            }
        } catch ( \Throwable $e ) {
            // Fallback silently on any error
        }

        return $pages;
    }

    /**
     * Check if the 'gs' (GhostScript) binary is available on this system.
     * Result is cached for the duration of the request.
     */
    private static function gs_available(): bool {
        static $available = null;
        if ( null !== $available ) {
            return $available;
        }
        if ( ! function_exists( 'exec' ) ) {
            return $available = false;
        }
        exec( 'which gs 2>/dev/null', $out, $code );
        return $available = ( 0 === $code && ! empty( $out ) );
    }

    /**
     * Extract per-page text from a PDF using GhostScript's txtwrite device.
     * Works on encrypted, compressed, and complex PDF 1.5+ files.
     */
    private static function index_pdf_via_gs( string $file_path ): array {
        $tmp_dir = sys_get_temp_dir() . '/jetreader_idx_' . md5( $file_path );

        if ( ! is_dir( $tmp_dir ) ) {
            wp_mkdir_p( $tmp_dir );
        }

        $output_pattern = $tmp_dir . '/page_%d.txt';
        $cmd = sprintf(
            'gs -dBATCH -dNOPAUSE -dQUIET -sDEVICE=txtwrite -sOutputFile=%s %s 2>/dev/null',
            escapeshellarg( $output_pattern ),
            escapeshellarg( $file_path )
        );

        exec( $cmd, $out, $code );

        if ( 0 !== $code ) {
            self::cleanup_tmp_dir( $tmp_dir );
            return array();
        }

        $pages    = array();
        $page_num = 1;

        while ( file_exists( $tmp_dir . '/page_' . $page_num . '.txt' ) ) {
            $text = (string) file_get_contents( $tmp_dir . '/page_' . $page_num . '.txt' );
            $text = trim( $text );

            if ( mb_strlen( $text ) >= 10 ) {
                $text = preg_replace( '/[ \t]+/', ' ', $text );
                $text = preg_replace( '/\n{3,}/', "\n\n", $text );

                $pages[] = array(
                    'volume_idx' => 0,
                    'page_num'   => $page_num - 1,
                    'content'    => $text,
                );
            }

            $page_num++;
        }

        self::cleanup_tmp_dir( $tmp_dir );
        return $pages;
    }

    /**
     * Remove a temporary directory and its files.
     */
    private static function cleanup_tmp_dir( string $dir ): void {
        global $wp_filesystem;
        if ( empty( $wp_filesystem ) ) {
            require_once ABSPATH . 'wp-admin/includes/file.php';
            WP_Filesystem();
        }

        if ( ! empty( $wp_filesystem ) ) {
            if ( $wp_filesystem->is_dir( $dir ) ) {
                $wp_filesystem->delete( $dir, true );
            }
        } else {
            // phpcs:ignore WordPress.WP.AlternativeFunctions.file_system_operations_rmdir
            if ( is_dir( $dir ) ) {
                foreach ( (array) glob( $dir . '/*' ) as $f ) {
                    // phpcs:ignore WordPress.WP.AlternativeFunctions.unlink_unlink
                    @unlink( $f );
                }
                // phpcs:ignore WordPress.WP.AlternativeFunctions.file_system_operations_rmdir
                @rmdir( $dir );
            }
        }
    }

    /**
     * Pure-PHP PDF text extractor (fallback when ghostscript is unavailable).
     * Handles simple unencrypted PDFs via BT/ET block parsing.
     */
    private static function index_pdf_regex( string $file_path ): array {
        $content = file_get_contents( $file_path );
        if ( ! $content ) {
            return array();
        }

        preg_match_all( '/stream\r?\n(.*?)\r?\nendstream/s', $content, $streams );
        if ( empty( $streams[1] ) ) {
            return array();
        }

        // Count actual PDF pages (via /Count in the Pages dictionary) so we can
        // assign proportional page numbers. Without this, stream index ≠ page number
        // — a 200-page PDF can have 500+ streams (images, fonts, text layers…).
        $total_pdf_pages = 0;
        if ( preg_match( '/\/Type\s*\/Pages[^>]*\/Count\s+(\d+)/s', $content, $cm ) ) {
            $total_pdf_pages = (int) $cm[1];
        } elseif ( preg_match( '/\/Count\s+(\d+)/', $content, $cm ) ) {
            $total_pdf_pages = (int) $cm[1];
        }

        // Collect non-empty text chunks from content streams.
        $texts = array();
        foreach ( $streams[1] as $stream ) {
            $text = self::extract_pdf_stream_text( $stream );
            if ( '' !== trim( $text ) ) {
                $texts[] = $text;
            }
        }

        if ( empty( $texts ) ) {
            return array();
        }

        $total_texts = count( $texts );
        $pages       = array();

        foreach ( $texts as $idx => $text ) {
            // Map stream index proportionally to real PDF page range.
            // Falls back to sequential numbering when page count is unknown.
            $page_num = $total_pdf_pages > 0
                ? (int) round( $idx / max( 1, $total_texts - 1 ) * ( $total_pdf_pages - 1 ) )
                : $idx;

            $pages[] = array(
                'volume_idx' => 0,
                'page_num'   => $page_num,
                'content'    => $text,
            );
        }

        return $pages;
    }

    /**
     * Extract readable text from a raw PDF content stream using PDF operators.
     * Handles BT/ET blocks, Tj, TJ, ' and " operators.
     */
    private static function extract_pdf_stream_text( string $stream ): string {
        // Try to inflate compressed streams.
        $inflated = @gzuncompress( $stream );
        if ( false !== $inflated ) {
            $stream = $inflated;
        }

        $text = '';

        // Collect text from BT…ET blocks.
        if ( preg_match_all( '/BT(.*?)ET/s', $stream, $bt_blocks ) ) {
            foreach ( $bt_blocks[1] as $block ) {
                // Tj  →  (text) Tj
                preg_match_all( '/\(([^)\\\\]*(?:\\\\.[^)\\\\]*)*)\)\s*Tj/s', $block, $tj );
                foreach ( $tj[1] as $t ) {
                    $text .= self::decode_pdf_string( $t ) . ' ';
                }

                // TJ  →  [(text) … ] TJ
                preg_match_all( '/\[([^\]]*)\]\s*TJ/s', $block, $tj_arr );
                foreach ( $tj_arr[1] as $tj_block ) {
                    preg_match_all( '/\(([^)\\\\]*(?:\\\\.[^)\\\\]*)*)\)/s', $tj_block, $parts );
                    foreach ( $parts[1] as $t ) {
                        $text .= self::decode_pdf_string( $t );
                    }
                    $text .= ' ';
                }

                // ' and " operators (move to next line + show text).
                preg_match_all( '/\(([^)\\\\]*(?:\\\\.[^)\\\\]*)*)\)\s*[\'"]/', $block, $prime );
                foreach ( $prime[1] as $t ) {
                    $text .= self::decode_pdf_string( $t ) . "\n";
                }
            }
        }

        return trim( $text );
    }

    /**
     * Decode basic PDF string escapes to readable UTF-8.
     */
    private static function decode_pdf_string( string $s ): string {
        $s = str_replace( array( '\\n', '\\r', '\\t' ), array( "\n", "\r", "\t" ), $s );
        $s = preg_replace( '/\\\\([\\\\()])/', '$1', $s );

        // Handle octal escapes like \040.
        $s = preg_replace_callback( '/\\\\([0-7]{1,3})/', static function ( $m ) {
            return chr( octdec( $m[1] ) );
        }, $s );

        return $s;
    }

    /**
     * Extract text from a legacy DOC (OLE binary) file for search indexing.
     * Scans the binary for UTF-16LE encoded text — no external tools required.
     */
    private static function index_doc( string $file_path ): array {
        $binary = file_get_contents( $file_path );
        if ( ! $binary ) {
            return array();
        }

        // Isolate the WordDocument stream from the OLE2 container to bypass FAT pointers and metadata noise
        $binary = self::extract_word_document_stream( $binary );

        // DOC stores text as UTF-16LE. Scan for valid character runs.
        // Accepted ranges:
        //   U+0020–U+007E  Basic Latin printable
        //   U+00A0–U+024F  Latin Extended (covers Turkish: ğ ş ı ç ö ü İ Ğ Ş etc.)
        //   U+0400–U+04FF  Cyrillic (Russian, Bulgarian, Ukrainian etc. - safe now)
        //   U+0600–U+06FF  Arabic / Persian
        // CR (U+000D) and LF (U+000A) are both treated as paragraph separators.
        // Runs shorter than MIN_RUN chars are discarded (filter random binary noise).
        $MIN_RUN = 8;
        $text    = '';
        $run     = '';
        $len     = strlen( $binary );

        for ( $i = 0; $i < $len - 1; $i += 2 ) {
            $lo = ord( $binary[ $i ] );
            $hi = ord( $binary[ $i + 1 ] );
            $cp = ( $hi << 8 ) | $lo;

            if ( $cp === 0x000D || $cp === 0x000A ) {
                $run .= "\n";
                continue;
            }

            $valid = (
                ( $hi === 0x00 && $lo >= 0x20 && $lo <= 0x7E ) ||  // Basic Latin
                ( $hi === 0x00 && $lo >= 0xA0 ) ||                  // U+00A0–U+00FF (ç ö ü etc.)
                ( $hi === 0x01 ) ||                                   // U+0100–U+01FF (ğ ş ı İ etc.)
                ( $hi === 0x02 && $lo <= 0x4F ) ||                   // U+0200–U+024F
                ( $hi === 0x04 ) ||                                   // Cyrillic (Russian, Bulgarian etc.)
                ( $hi === 0x06 )                                      // Arabic / Persian
            );

            if ( $valid ) {
                $run .= mb_chr( $cp, 'UTF-8' );
            } else {
                if ( mb_strlen( $run ) >= $MIN_RUN ) {
                    $text .= $run;
                }
                $run = '';
            }
        }

        if ( mb_strlen( $run ) >= $MIN_RUN ) {
            $text .= $run;
        }

        $text = preg_replace( '/[ \t]{4,}/', "\n", $text );
        $text = preg_replace( '/\n{3,}/', "\n\n", trim( $text ) );

        if ( '' === trim( $text ) ) {
            return array();
        }

        // Chunk into ~1500-char pages, same as TXT/DOCX indexing.
        $paragraphs = explode( "\n", $text );
        $chunk      = '';
        $page_num   = 0;
        $pages      = array();

        foreach ( $paragraphs as $para ) {
            $para = trim( $para );
            if ( '' === $para ) {
                continue;
            }
            $chunk .= $para . "\n";
            if ( mb_strlen( $chunk ) >= 1500 ) {
                $pages[] = array(
                    'volume_idx' => 0,
                    'page_num'   => $page_num,
                    'content'    => trim( $chunk ),
                );
                $page_num++;
                $chunk = '';
            }
        }

        if ( '' !== trim( $chunk ) ) {
            $pages[] = array(
                'volume_idx' => 0,
                'page_num'   => $page_num,
                'content'    => trim( $chunk ),
            );
        }

        return $pages;
    }

    /**
     * Extract text from a DOCX file.
     */
    private static function index_docx( string $file_path ): array {
        $pages = array();

        if ( ! self::is_safe_zip( $file_path ) ) {
            return $pages;
        }

        $zip = new ZipArchive();

        if ( $zip->open( $file_path ) !== true ) {
            return $pages;
        }

        $document_xml = $zip->getFromName( 'word/document.xml' );
        if ( ! $document_xml ) {
            $zip->close();
            return $pages;
        }

        // Helper to extract clean text from any DOCX XML content
        $extract_xml_text = static function( string $xml ): string {
            // Spacing around block elements (paragraphs, table cells/rows, breaks)
            $xml = preg_replace( '/<\/(w:p|w:tc|w:tr|w:br)>/i', ' $0 ', $xml );
            $text = wp_strip_all_tags( $xml );
            $text = html_entity_decode( $text, ENT_QUOTES | ENT_HTML5, 'UTF-8' );
            $text = str_replace( "\xc2\xa0", ' ', $text );
            $text = preg_replace( '/[ \t]+/', ' ', $text );
            return trim( $text );
        };

        // Preserve paragraph breaks in document body text
        $body_xml = str_replace( '<w:p', "\n<w:p", $document_xml );
        $main_text = $extract_xml_text( $body_xml );

        // Extract extra sections: footnotes, headers, footers
        $extra_texts = array();
        
        $footnotes_xml = $zip->getFromName( 'word/footnotes.xml' );
        if ( $footnotes_xml ) {
            $ft_text = $extract_xml_text( $footnotes_xml );
            if ( '' !== $ft_text ) {
                $extra_texts[] = "\n\n[Footnotes / Dipnotlar]:\n" . $ft_text;
            }
        }

        for ( $h = 1; $h <= 4; $h++ ) {
            $header_xml = $zip->getFromName( "word/header{$h}.xml" );
            if ( $header_xml ) {
                $h_text = $extract_xml_text( $header_xml );
                if ( '' !== $h_text ) {
                    $extra_texts[] = $h_text;
                }
            }
            $footer_xml = $zip->getFromName( "word/footer{$h}.xml" );
            if ( $footer_xml ) {
                $f_text = $extract_xml_text( $footer_xml );
                if ( '' !== $f_text ) {
                    $extra_texts[] = $f_text;
                }
            }
        }

        $zip->close();

        // Append footnotes, headers and footers to the index
        if ( ! empty( $extra_texts ) ) {
            $main_text .= "\n" . implode( "\n", $extra_texts );
        }

        // Split into chunks of ~1500 characters at paragraph boundaries
        $paragraphs = explode( "\n", $main_text );
        $chunk      = '';
        $page_num   = 0;

        foreach ( $paragraphs as $para ) {
            $para = trim( $para );
            if ( '' === $para ) {
                continue;
            }
            $chunk .= $para . "\n";

            if ( mb_strlen( $chunk ) >= 1500 ) {
                $pages[] = array(
                    'volume_idx' => 0,
                    'page_num'   => $page_num,
                    'content'    => trim( $chunk ),
                );
                $page_num++;
                $chunk = '';
            }
        }

        if ( '' !== trim( $chunk ) ) {
            $pages[] = array(
                'volume_idx' => 0,
                'page_num'   => $page_num,
                'content'    => trim( $chunk ),
            );
        }

        return $pages;
    }

    /**
     * Extract text from a TXT file, split into ~1500-char chunks.
     */
    private static function index_txt( string $file_path ): array {
        $content = file_get_contents( $file_path );
        if ( ! $content ) {
            return array();
        }

        // Detect character encoding and convert non-UTF-8 (Turkish, Cyrillic, Western etc.) to UTF-8
        if ( function_exists( 'mb_detect_encoding' ) ) {
            $encoding = mb_detect_encoding( $content, array( 'UTF-8', 'ISO-8859-9', 'Windows-1254', 'Windows-1251', 'ISO-8859-1', 'ASCII' ), true );
            if ( $encoding && 'UTF-8' !== $encoding ) {
                $converted = @mb_convert_encoding( $content, 'UTF-8', $encoding );
                if ( false !== $converted && '' !== $converted ) {
                    $content = $converted;
                }
            }
        }

        $pages    = array();
        $lines    = explode( "\n", $content );
        $chunk    = '';
        $page_num = 0;

        foreach ( $lines as $line ) {
            $chunk .= $line . "\n";
            if ( mb_strlen( $chunk ) >= 1500 ) {
                $pages[] = array(
                    'volume_idx' => 0,
                    'page_num'   => $page_num,
                    'content'    => trim( $chunk ),
                );
                $page_num++;
                $chunk = '';
            }
        }

        if ( '' !== trim( $chunk ) ) {
            $pages[] = array(
                'volume_idx' => 0,
                'page_num'   => $page_num,
                'content'    => trim( $chunk ),
            );
        }

        return $pages;
    }

    /**
     * Strip HTML and return plain text (preserving spaces between block elements).
     */
    private static function html_to_text( string $html ): string {
        // Remove style and script tags + their contents so they are not indexed as plain text
        $html = preg_replace( '/<style[^>]*>[\s\S]*?<\/style>/i', ' ', $html );
        $html = preg_replace( '/<script[^>]*>[\s\S]*?<\/script>/i', ' ', $html );
        
        // Add spacing around block elements before stripping
        $html = preg_replace( '/<\/(p|div|li|td|th|h[1-6]|br)>/i', ' $0 ', $html );
        
        // Strip remaining HTML tags
        $text = wp_strip_all_tags( $html );
        
        // Decode all HTML and XML entities to their actual Unicode characters (handles Turkish, Cyrillic, Arabic, etc.)
        $text = html_entity_decode( $text, ENT_QUOTES | ENT_HTML5, 'UTF-8' );
        
        // Clean up whitespace: replace non-breaking spaces, limit spaces, and merge multiple newlines
        $text = str_replace( "\xc2\xa0", ' ', $text );
        $text = preg_replace( '/[ \t]+/', ' ', $text );
        $text = preg_replace( '/\n{2,}/', "\n", $text );
        
        return trim( $text );
    }

    /**
     * Parse chapters from a file.
     *
     * @param string $file_path Full path to the file.
     * @param string $format    File format extension.
     * @return array Array of chapter data.
     */
    public function parse_chapters( $file_path, $format ) {
        switch ( $format ) {
            case 'epub':
                return $this->parse_epub_chapters( $file_path );
            case 'pdf':
                return $this->parse_pdf_chapters( $file_path );
            case 'txt':
                return $this->parse_txt_chapters( $file_path );
            case 'doc':
            case 'docx':
                return $this->parse_docx_chapters( $file_path );
            default:
                return array();
        }
    }

    /**
     * Parse EPUB chapters using TOC detection.
     */
    private function parse_epub_chapters( $file_path ) {
        $chapters = array();
        $index    = 0;

        if ( ! self::is_safe_zip( $file_path ) ) {
            return $this->parse_generic_chapters( $file_path, 'epub' );
        }

        $zip = new ZipArchive();
        if ( $zip->open( $file_path ) !== true ) {
            return $this->parse_generic_chapters( $file_path, 'epub' );
        }

        // Level 1: Try to get TOC from toc.ncx or nav.xhtml.
        $toc_chapters = $this->extract_epub_toc( $zip );
        if ( ! empty( $toc_chapters ) ) {
            foreach ( $toc_chapters as $toc ) {
                $chapters[] = array(
                    'title'      => $toc['title'],
                    'content'    => $toc['content'] ?? '',
                    'order_index' => $index,
                    'page_start'  => $index,
                    'page_end'    => $index + 1,
                );
                $index++;
            }
            $zip->close();
            return $chapters;
        }

        // Level 2: Fallback - find HTML files and use their titles.
        for ( $i = 0; $i < $zip->numFiles; $i++ ) {
            $filename = $zip->getNameIndex( $i );
            if ( ! $filename ) {
                continue;
            }

            $ext = strtolower( pathinfo( $filename, PATHINFO_EXTENSION ) );
            if ( ! in_array( $ext, array( 'html', 'htm', 'xhtml' ), true ) ) {
                continue;
            }

            $content = $zip->getFromIndex( $i );
            if ( ! $content ) {
                continue;
            }

            // Extract title from <title> tag.
            $title = pathinfo( $filename, PATHINFO_FILENAME );
            if ( preg_match( '/<title[^>]*>(.*?)<\/title>/si', $content, $title_match ) ) {
                $title = trim( wp_strip_all_tags( $title_match[1] ) );
            } elseif ( preg_match( '/<h1[^>]*>(.*?)<\/h1>/si', $content, $h1_match ) ) {
                $title = trim( wp_strip_all_tags( $h1_match[1] ) );
            } elseif ( preg_match( '/<h2[^>]*>(.*?)<\/h2>/si', $content, $h2_match ) ) {
                $title = trim( wp_strip_all_tags( $h2_match[1] ) );
            }

            $chapters[] = array(
                'title'       => $title,
                'content'     => wp_strip_all_tags( $content ),
                'order_index' => $index,
                'page_start'  => $index,
                'page_end'    => $index + 1,
            );
            $index++;
        }

        $zip->close();
        return $chapters;
    }

    /**
     * Extract TOC from EPUB file.
     */
    private function extract_epub_toc( $zip ) {
        $chapters = array();

        // Try NCX.
        $ncx_content = null;
        for ( $i = 0; $i < $zip->numFiles; $i++ ) {
            $filename = $zip->getNameIndex( $i );
            if ( $filename && strpos( strtolower( $filename ), '.ncx' ) !== false ) {
                $ncx_content = $zip->getFromIndex( $i );
                break;
            }
        }

        if ( $ncx_content ) {
            $xml = simplexml_load_string( $ncx_content );
            if ( $xml ) {
                $xml->registerXPathNamespace( 'ncx', 'http://www.daisy.org/z3986/2005/ncx/' );
                $nav_points = $xml->xpath( '//ncx:navPoint' );

                foreach ( $nav_points as $nav_point ) {
                    $title = '';
                    $labels = $nav_point->xpath( './/ncx:text' );
                    if ( ! empty( $labels ) ) {
                        $title = trim( (string) $labels[0] );
                    }

                    if ( ! empty( $title ) ) {
                        $chapters[] = array(
                            'title' => $title,
                        );
                    }
                }
            }
        }

        // Try NAV (EPUB3).
        if ( empty( $chapters ) ) {
            for ( $i = 0; $i < $zip->numFiles; $i++ ) {
                $filename = $zip->getNameIndex( $i );
                if ( $filename && strpos( strtolower( $filename ), 'nav.xhtml' ) !== false ) {
                    $nav_content = $zip->getFromIndex( $i );
                    if ( $nav_content && preg_match_all( '/<a[^>]+href="([^"]+)"[^>]*>(.*?)<\/a>/si', $nav_content, $matches, PREG_SET_ORDER ) ) {
                        foreach ( $matches as $match ) {
                            $title = trim( wp_strip_all_tags( $match[2] ) );
                            if ( ! empty( $title ) ) {
                                $chapters[] = array( 'title' => $title );
                            }
                        }
                    }
                    break;
                }
            }
        }

        return $chapters;
    }

    /**
     * Parse PDF chapters (basic outline extraction).
     */
    private function parse_pdf_chapters( $file_path ) {
        $chapters = array();
        $content  = file_get_contents( $file_path, false, null, 0, 500000 );

        if ( ! $content ) {
            return $chapters;
        }

        // Try to find PDF bookmarks/outline.
        $index = 0;

        // Simple heuristic: look for potential chapter titles.
        // Chapter patterns like "Chapter 1", "Bölüm 1", headings, etc.
        $lines = explode( "\n", $content );
        $chapter_patterns = array(
            '/^Chapter\s+\d+/i',
            '/^Bölüm\s+\d+/i',
            '/^Kısım\s+\d+/i',
            '/^Part\s+\d+/i',
            '/^Section\s+\d+/i',
            '/^\d+\.\s+[A-Z]/',
        );

        foreach ( $lines as $line ) {
            $line = trim( $line );
            if ( empty( $line ) || strlen( $line ) > 200 ) {
                continue;
            }

            foreach ( $chapter_patterns as $pattern ) {
                if ( preg_match( $pattern, $line ) ) {
                    $chapters[] = array(
                        'title'       => $line,
                        'content'     => '',
                        'order_index' => $index,
                        'page_start'  => $index,
                        'page_end'    => $index + 1,
                    );
                    $index++;
                    break;
                }
            }
        }

        // If no chapters detected, create a single chapter for the whole PDF.
        if ( empty( $chapters ) ) {
            $chapters[] = array(
                'title'       => pathinfo( $file_path, PATHINFO_FILENAME ),
                'content'     => '',
                'order_index' => 0,
                'page_start'  => 0,
                'page_end'    => 1,
            );
        }

        return $chapters;
    }

    /**
     * Parse TXT chapters using heading patterns.
     */
    private function parse_txt_chapters( $file_path ) {
        $chapters = array();
        $content  = file_get_contents( $file_path );

        if ( ! $content ) {
            return $chapters;
        }

        $lines    = explode( "\n", $content );
        $index    = 0;
        $current  = null;

        $chapter_patterns = array(
            '/^#{1,3}\s+(.+)/',           // Markdown headers
            '/^Chapter\s+\d+/i',           // English chapters
            '/^Bölüm\s+\d+/i',             // Turkish chapters
            '/^Kısım\s+\d+/i',             // Turkish parts
            '/^Part\s+\d+/i',              // English parts
            '/^Section\s+\d+/i',           // English sections
            '/^\d+\.\s+[A-Z]/',            // Numbered headings
            '/^[A-Z][A-Z\s]{5,}$/',        // ALL CAPS HEADINGS
        );

        foreach ( $lines as $line ) {
            $line = trim( $line );

            if ( empty( $line ) ) {
                continue;
            }

            $is_chapter = false;
            foreach ( $chapter_patterns as $pattern ) {
                if ( preg_match( $pattern, $line, $matches ) ) {
                    $is_chapter = true;

                    // Save previous chapter.
                    if ( $current ) {
                        $chapters[] = $current;
                    }

                    $title = isset( $matches[1] ) ? trim( $matches[1] ) : $line;
                    $current = array(
                        'title'       => $title,
                        'content'     => '',
                        'order_index' => $index,
                        'page_start'  => $index,
                        'page_end'    => $index + 1,
                    );
                    $index++;
                    break;
                }
            }

            if ( ! $is_chapter && $current ) {
                $current['content'] .= $line . "\n";
            }
        }

        // Save last chapter.
        if ( $current ) {
            $chapters[] = $current;
        }

        // If no chapters detected, create a single chapter.
        if ( empty( $chapters ) ) {
            $chapters[] = array(
                'title'       => pathinfo( $file_path, PATHINFO_FILENAME ),
                'content'     => $content,
                'order_index' => 0,
                'page_start'  => 0,
                'page_end'    => 1,
            );
        }

        return $chapters;
    }

    /**
     * Parse DOCX chapters.
     */
    private function parse_docx_chapters( $file_path ) {
        $chapters = array();
        $index    = 0;

        if ( ! self::is_safe_zip( $file_path ) ) {
            return $this->parse_generic_chapters( $file_path, 'docx' );
        }

        $zip = new ZipArchive();
        if ( $zip->open( $file_path ) !== true ) {
            return $this->parse_generic_chapters( $file_path, 'docx' );
        }

        $document_xml = $zip->getFromName( 'word/document.xml' );
        $zip->close();

        if ( ! $document_xml ) {
            return $chapters;
        }

        $xml = simplexml_load_string( $document_xml );
        if ( ! $xml ) {
            return $chapters;
        }

        $xml->registerXPathNamespace( 'w', 'http://schemas.openxmlformats.org/wordprocessingml/2006/main' );
        $paragraphs = $xml->xpath( '//w:p' );

        $current      = null;
        $current_text = '';

        foreach ( $paragraphs as $paragraph ) {
            $text_nodes = $paragraph->xpath( './/w:t' );
            $text = '';
            foreach ( $text_nodes as $t ) {
                $text .= (string) $t;
            }

            if ( empty( $text ) ) {
                continue;
            }

            // Check if this is a heading.
            $is_heading = false;
            $pPr        = $paragraph->xpath( './/w:pPr' );
            if ( $pPr ) {
                $pStyle = $pPr[0]->xpath( './/w:pStyle' );
                if ( $pStyle ) {
                    $style_val = (string) $pStyle[0]['w:val'];
                    if ( preg_match( '/Heading/i', $style_val ) ) {
                        $is_heading = true;
                    }
                }
            }

            if ( $is_heading ) {
                // Save previous chapter.
                if ( $current ) {
                    $current['content'] = trim( $current_text );
                    $chapters[] = $current;
                }

                $current = array(
                    'title'       => trim( $text ),
                    'content'     => '',
                    'order_index' => $index,
                    'page_start'  => $index,
                    'page_end'    => $index + 1,
                );
                $current_text = '';
                $index++;
            } elseif ( $current ) {
                $current_text .= $text . "\n";
            }
        }

        // Save last chapter.
        if ( $current ) {
            $current['content'] = trim( $current_text );
            $chapters[] = $current;
        }

        // If no chapters detected, create a single chapter.
        if ( empty( $chapters ) ) {
            $chapters[] = array(
                'title'       => pathinfo( $file_path, PATHINFO_FILENAME ),
                'content'     => wp_strip_all_tags( $document_xml ),
                'order_index' => 0,
                'page_start'  => 0,
                'page_end'    => 1,
            );
        }

        return $chapters;
    }

    /**
     * Generic fallback chapter parser.
     */
    private function parse_generic_chapters( $file_path, $format ) {
        return array(
            array(
                'title'       => pathinfo( $file_path, PATHINFO_FILENAME ),
                'content'     => '',
                'order_index' => 0,
                'page_start'  => 0,
                'page_end'    => 1,
            )
        );
    }

    /**
     * Extract the WordDocument stream from an OLE2 binary file (de-fragmented heuristic).
     */
    private static function extract_word_document_stream( string $binary ): string {
        $len = strlen( $binary );
        if ( $len < 512 ) {
            return $binary;
        }
        
        // Validate OLE2 magic signature: D0 CF 11 E0 A1 B1 1A E1
        $magic = substr( $binary, 0, 8 );
        if ( $magic !== "\xD0\xCF\x11\xE0\xA1\xB1\x1A\xE1" ) {
            return $binary;
        }

        // Sector size: typically 512 bytes (1 << 9)
        $sec_size_pow = ord( $binary[30] ) | ( ord( $binary[31] ) << 8 );
        $sec_size = 1 << $sec_size_pow;
        if ( $sec_size !== 512 && $sec_size !== 4096 ) {
            $sec_size = 512;
        }

        // First directory sector
        $dir_sector = ord( $binary[48] ) | ( ord( $binary[49] ) << 8 ) | ( ord( $binary[50] ) << 16 ) | ( ord( $binary[51] ) << 24 );

        // Read the directory sector
        $dir_offset = 512 + $dir_sector * $sec_size;
        if ( $dir_offset + 128 > $len ) {
            return $binary;
        }

        // Walk through directory entries
        for ( $offset = $dir_offset; $offset < $dir_offset + $sec_size; $offset += 128 ) {
            if ( $offset + 128 > $len ) {
                break;
            }
            $name_len = ord( $binary[ $offset + 64 ] ) | ( ord( $binary[ $offset + 65 ] ) << 8 );
            if ( $name_len < 2 || $name_len > 64 ) {
                continue;
            }
            
            // Extract entry name and decode from UTF-16LE
            $name_raw = substr( $binary, $offset, $name_len - 2 );
            $name = @mb_convert_encoding( $name_raw, 'UTF-8', 'UTF-16LE' );
            if ( ! $name ) {
                continue;
            }
            $name = trim( preg_replace( '/[^\x20-\x7E]/', '', $name ) ); // keep printable ASCII

            if ( str_contains( strtolower( $name ), 'worddocument' ) ) {
                // Start sector
                $start_sec = ord( $binary[ $offset + 116 ] ) | ( ord( $binary[ $offset + 117 ] ) << 8 ) | ( ord( $binary[ $offset + 118 ] ) << 16 ) | ( ord( $binary[ $offset + 119 ] ) << 24 );
                // Size
                $size = ord( $binary[ $offset + 120 ] ) | ( ord( $binary[ $offset + 121 ] ) << 8 ) | ( ord( $binary[ $offset + 122 ] ) << 16 ) | ( ord( $binary[ $offset + 123 ] ) << 24 );

                // Calculate stream offset (assuming contiguous sectors)
                $stream_offset = 512 + $start_sec * $sec_size;
                if ( $stream_offset + $size <= $len && $size > 0 ) {
                    return substr( $binary, $stream_offset, $size );
                }
            }
        }

        return $binary;
    }
}