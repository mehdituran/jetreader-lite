=== JetReader – Book Library, EPUB & PDF Reader (Lite) ===
Contributors: mehdituran
Tags: ebook, epub, pdf, reader, library
Requires at least: 6.4
Tested up to: 7.0
Stable tag: 1.1.1
Requires PHP: 8.2
License: GPLv2 or later
License URI: https://www.gnu.org/licenses/gpl-2.0.html

JetReader turns WordPress into a digital library with a fullscreen React document reader and advanced document management.

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
5. Create a new WordPress Page, insert the `[jetreader_library]` shortcode, and publish it.
6. Add your first digital item via **JetReader → Library Items → Add New** or by uploading documents. Your library is now ready!

== Documentation ==

For full documentation, shortcode attributes, and REST API endpoints, please visit the official documentation page:
https://rikny.com

== Source Code & Build Instructions ==

This plugin contains minified/compiled React assets under the `dist/` directory. For build reproducibility and compilation transparency, the distributed package includes the complete, unminified, human-readable source code inside the `src/` directory, as well as the build configuration files (`package.json`, `package-lock.json`, `vite.config.ts`, `tsconfig.json`, `postcss.config.js`, `tailwind.config.ts`). The source code is also publicly accessible and maintained in the following repository:
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
* **Mammoth.js** (BSD 2-Clause License) - https://github.com/mwilliamson/mammoth.js (including Bluebird and JSZip)
* **DOMPurify** (Apache 2.0 / LGPL 2.1) - https://github.com/cure53/DOMPurify
* **fflate** (MIT License) - https://github.com/101arrowz/fflate
* **Keen Slider** (MIT License) - https://keen-slider.io/

=== Localization & Translation ===
JetReader is fully translation-ready: PHP strings use WordPress i18n functions (`__()`, `_e()`, etc.) and the React admin/frontend/reader interfaces use `@wordpress/i18n`, so the plugin follows your site's active language (including per-page languages set by Polylang/WPML) automatically. The translation template is at `languages/jetreader.pot`.

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
No. Frontend assets (JavaScript and CSS bundles) are enqueued dynamically and only load on pages where a JetReader shortcode is present.

= Is JetReader compatible with WooCommerce? =
Yes. JetReader declares compatibility with WooCommerce High-Performance Order Storage (HPOS) so no admin compatibility warnings appear on WooCommerce stores.

= What are Tags used for? =
Tags are a lightweight cross-type taxonomy. Unlike categories (which are content-type specific), a single tag can group books, articles, magazines, and Q&A documents together. This enables flexible filtering and discovery across your entire library.

= How do I add screenshots to a WordPress.org plugin page? =
See the Screenshots section below for the required images and how to place them.

== Screenshots ==

1. Main Library View — The full interactive digital catalog supporting PDF, EPUB, DOCX, DOC, and TXT files with sidebar filters and grid layouts.
2. In-Reader Experience — The seamless fullscreen reader open on a document, demonstrating custom layouts for EPUB/DOCX books and optimized viewports for PDF documents.
3. Universal Document Tools & Annotations — Live text highlighting and annotation options across different document types, from classic TXT files to complex PDFs.
4. Admin — Library Management — Centralized WordPress admin screen showcasing organized type filters, digital format indicators, and auto-generated cover thumbnails.
5. Admin — Document Ingest & Metadata — Form fields for file uploads (PDF, EPUB, DOCX, DOC, TXT) featuring explicit access controls and metadata handling.

== Changelog ==

= 1.1.1 =
* Fixed: activating JetReader Pro while Lite was active could trigger a "Cannot redeclare function" fatal error instead of cleanly handing off to Pro. The shared activation/deactivation functions now load through a separate include file so the Lite/Pro conflict guard can prevent the redeclaration as intended.
* Updated documentation, support, and plugin URIs to https://rikny.com.

= 1.1.0 =
* Localization: replaced the custom `lang/*.json` + `t()` translation system with native WordPress i18n (`__()`, `_e()`, `sprintf()`) across PHP and the React admin/frontend/reader interfaces, so the plugin is now translatable through standard `.po`/`.mo` files and works correctly with Polylang/WPML.
* The plugin's text direction (RTL/LTR) now follows WordPress's own `is_rtl()` instead of a custom per-language setting.
* Removed the unused "Plugin Language" backend setting and the `lang/` directory; admin menu and CPT labels are now translated through core WordPress functions instead of a custom JSON lookup.
* Regenerated `languages/jetreader.pot` to include all translatable strings from both PHP and the React/TypeScript source.

= 1.0.3 =
* Security: file rename endpoint now rejects any new file name that changes the file extension, preventing uploads from being renamed to executable file types.
* Fixed: critical reader page CSS is now registered through `wp_register_style()`/`wp_add_inline_style()` instead of being printed as an inline `<style>` tag.
* Fixed: rate-limit transient keys now use the `jetreader_` prefix instead of the too-short `jr_` prefix to avoid collisions with other plugins.

= 1.0.2 =
* Collapsible Filter Sidebar: added a collapsible Filter Sidebar on desktop layout.
* Modern Arrow Icons: integrated custom `<` and `>` toggle buttons for the sidebar.

= 1.0.1 =
* Custom Q&A layout: displayed as a clean, vertical list instead of standard grid cards.
* Detail modal: hid the left cover image column and adjusted width to 650px for Q&A items.
* Multiple shortcodes: fixed ID conflicts to support displaying multiple library instances on a single page.
* Type parameter mapping: automatically resolves plural shortcode attributes (e.g. books, magazines) to singular ones.

= 1.0.0 =
* Initial stable release of JetReader Lite.
* Added support for EPUB, PDF, TXT, and DOCX files.
* Added modern fullscreen React-based document reader interface.
* Added customizable reading themes (Light, Dark, Sepia, Auto) and font sizes.
* Added persistent user bookmarks, notes, and colored highlights.
* Added deep linking and resume reading features.
* Added SEO optimization, CPT sync, and Schema.org metadata injection.
* Added standalone document metadata search.

== Upgrade Notice ==

= 1.0.0 =
Initial stable release. Thank you for using JetReader!
