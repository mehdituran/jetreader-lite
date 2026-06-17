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
            $xml = simplexml_load_string( $ncx_content, 'SimpleXMLElement', LIBXML_NONET );
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

        $xml = simplexml_load_string( $document_xml, 'SimpleXMLElement', LIBXML_NONET );
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
}