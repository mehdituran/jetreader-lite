=== JetReader – Book Library, EPUB & PDF Reader (Lite) ===
Contributors: mehdituran
Tags: ebook, epub, pdf, reader, library
Requires at least: 6.4
Tested up to: 7.0
Stable tag: 1.0.0
Requires PHP: 8.2
License: GPLv2 or later
License URI: https://www.gnu.org/licenses/gpl-2.0.html

JetReader turns WordPress into a digital library with a fullscreen React document reader, visual shortcode builders, and advanced metadata management.

== Description ==

JetReader turns WordPress into a digital library with a fullscreen React document reader. Upload, manage, and display books, articles, magazines, and Q&A documents. It automatically maps documents to SEO-friendly Custom Post Types, making them fully searchable and XML sitemap compatible.

=== Document Support ===
* **EPUB** — Paginated layout, customizable fonts, and outline navigation.
* **PDF** — High-performance rendering, zoom, and dual/single page view.
* **TXT** — Auto-styled text with font resizing and auto-scroll.
* **DOCX** — Client-side parsing and rendering of Word files with formatting.

=== Features ===
* **Fullscreen View** — Clean template without site headers/footers for maximum focus.
* **Themes** — Toggle between Light, Dark, Sepia, and Auto modes.
* **In-doc Search** — Find terms directly inside the document with page-jump.
* **Resume Reading** — Remembers the user's reading progress.
* **Deep Linking** — Direct URLs (e.g., `#page=12`) to open at a specific page.

== Installation ==

1. Upload the `jetreader` folder to the `/wp-content/plugins/` directory, or install directly via **Plugins → Add New → Upload Plugin**.
2. Activate the plugin through the **Plugins** menu.
3. Upon activation, the plugin will automatically create custom database tables and register the default CPT rewrite rules.
4. Go to **JetReader → Settings** to set your default language, reader options, library card layout, and color palettes.
5. Create a new WordPress Page, insert the `[jetreader_library]` shortcode (or insert the JetReader Library Gutenberg Block), and publish it.
6. Add your first digital item via **JetReader → Library Items → Add New** or by uploading documents. Your library is now ready!

== Documentation ==

For full documentation, shortcode attributes, REST API endpoints, and Gutenberg block settings, please visit the official documentation page:
https://wplector.com

== Source Code & Build Instructions ==

This plugin contains minified/compiled React assets under the `dist/` directory. The complete, unminified, human-readable source code is included inside the `src/` directory of the plugin, and is also publicly accessible and maintained in the following repository:
https://github.com/mehdituran/jetreader-lite

=== Build Tools & Steps ===
To build the compiled assets from the source code:
1. Ensure Node.js (v18+) is installed.
2. Clone the repository and navigate to the project directory.
3. Install dependencies by running:
   `npm install`
4. Build the production assets using the Vite builder:
   `npm run build`
5. The generated compiled files will be output to the `dist/` directory.

=== Third-Party Libraries ===
The compiled assets bundle the following third-party libraries:
* **React & React DOM** (MIT License) - https://react.dev/
* **TanStack React Query** (MIT License) - https://tanstack.com/query/
* **Framer Motion** (MIT License) - https://www.framer.com/motion/
* **Epub.js** (BSD 3-Clause License) - https://github.com/futurepress/epub.js/
* **Mozilla PDF.js** (Apache 2.0 License) - https://mozilla.github.io/pdf.js/

== Frequently Asked Questions ==

= Which file formats are supported? =
JetReader supports EPUB, PDF, TXT, and DOCX files. Files can be uploaded directly or linked via external URLs.

= Can visitors bookmark or highlight without registering? =
No. Since bookmarks and annotations are saved in your database for a persistent cross-device experience, users must be logged into a WordPress account. Public reading does not require an account.

= Can I disable text copying? =
Yes. Go to **JetReader → Settings** and toggle the "Copy Enabled" permission. This disables text selection, right-click, and copy hotkeys inside the reader interface.

= How does search work in the Lite version? =
JetReader allows visitors to search through uploaded documents in the library by their titles. For document-internal content search, the reader parses and searches document text directly in the visitor's browser (client-side), without requiring any server-side database indexing.

= Will JetReader slow down my WordPress site? =
No. Frontend assets (JavaScript and CSS bundles) are enqueued dynamically and only load on pages where a JetReader shortcode or block is present.

= Is JetReader compatible with WooCommerce? =
Yes. JetReader declares compatibility with WooCommerce High-Performance Order Storage (HPOS) so no admin compatibility warnings appear on WooCommerce stores.

= What are Tags used for? =
Tags are a lightweight cross-type taxonomy. Unlike categories (which are content-type specific), a single tag can group books, articles, magazines, and Q&A documents together. This enables flexible filtering and discovery across your entire library.

= How do I add screenshots to a WordPress.org plugin page? =
See the Screenshots section below for the required images and how to place them.

== Screenshots ==

1. Main Library View — The full interactive catalog with sidebar filters, content-type tabs, and card grid.
2. In-Reader Experience — The fullscreen React reader open on an EPUB document, showing the toolbar, reading themes toggle, and chapter navigation panel.
3. Annotations & Highlights — A page with colored text highlights and an open annotation note panel.
4. Admin — Library Items — The admin item list showing type tabs, cover thumbnails, and action buttons.
5. Admin — Add / Edit Item — The document form with metadata fields, tag selector, volume uploader, and visibility controls.

== Changelog ==

= 1.0.0 =
* Initial stable release of JetReader.
* Added support for EPUB, PDF, TXT, and DOCX files.
* Added modern fullscreen React-based document reader interface.
* Added customizable reading themes (Light, Dark, Sepia, Auto) and font sizes.
* Added persistent user bookmarks, notes, and colored highlights.
* Added deep linking and resume reading features.
* Added responsive grid and slider visual builders with shortcode generator.
* Added native Gutenberg Blocks and Elementor Widgets.
* Added SEO optimization, CPT sync, and Schema.org metadata injection.
* Added standalone full-text content search widget.
* Added CSV, Excel, and JSON bulk import and export tools.

== Upgrade Notice ==

= 1.0.0 =
Initial stable release. Thank you for using JetReader!
