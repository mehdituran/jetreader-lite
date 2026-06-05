import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import { copyFileSync, mkdirSync } from 'fs';

// Custom plugin to copy PDF.js worker into dist/js/ during build.
function copyPdfWorker() {
    return {
        name: 'copy-pdf-worker',
        writeBundle() {
            const src  = path.resolve( __dirname, 'node_modules/pdfjs-dist/build/pdf.worker.min.mjs' );
            const dest = path.resolve( __dirname, 'dist/js/pdf.worker.min.mjs' );
            mkdirSync( path.dirname( dest ), { recursive: true } );
            copyFileSync( src, dest );
        },
    };
}

// Custom plugin to strip remote CDN fallback from PDF.js to satisfy WordPress.org requirements.
function stripCdnFallback() {
    return {
        name: 'strip-cdn-fallback',
        renderChunk( code: string ) {
            const cleaned = code.replace( /https:\/\/cdnjs\.cloudflare\.com\/ajax\/libs\/pdf\.js\//g, '/wp-content/plugins/jetreader/dist/js/' );
            return { code: cleaned, map: null };
        },
    };
}

// __JR_LITE__ is injected as a build-time constant.
// true  → Lite bundle (used by build-releases.php for the WP.org submission).
// false → Pro bundle (default).
const isLiteBuild = process.env.JR_LITE === '1';

export default defineConfig( {
    base: '',
    plugins: [ react(), copyPdfWorker(), stripCdnFallback() ],
    define: {
        __JR_LITE__: isLiteBuild,
    },
    resolve: {
        alias: {
            '@': path.resolve( __dirname, 'src' ),
            '@admin': path.resolve( __dirname, 'src/admin' ),
            '@frontend': path.resolve( __dirname, 'src/frontend' ),
            '@reader': path.resolve( __dirname, 'src/reader' ),
            '@blocks': path.resolve( __dirname, 'src/blocks' ),
        },
    },
    build: {
        outDir: 'dist',
        emptyOutDir: true,
        target: 'es2022',
        chunkSizeWarningLimit: 1000,
        cssCodeSplit: false,
        rollupOptions: {
            input: {
                admin: path.resolve( __dirname, 'src/admin/main.tsx' ),
                frontend: path.resolve( __dirname, 'src/frontend/main.tsx' ),
                reader: path.resolve( __dirname, 'src/reader/main.tsx' ),
                blocks: path.resolve( __dirname, 'src/blocks/main.tsx' ),
            },
            output: {
                entryFileNames: 'js/[name].js',
                chunkFileNames: 'js/[name].chunk.js',
                assetFileNames: ( assetInfo ) => {
                    if ( assetInfo.name?.endsWith( '.css' ) ) {
                        return 'css/[name].[ext]';
                    }
                    return 'assets/[name].[ext]';
                },
            },
            // Only @wordpress/* are true externals — they are provided as
            // window.wp.* globals by the block editor. React must be bundled
            // because WordPress does not expose it as a resolvable ESM specifier.
            external: [
                '@wordpress/blocks',
                '@wordpress/block-editor',
                '@wordpress/components',
                '@wordpress/i18n',
                '@wordpress/icons',
            ],
        },
    },
    css: {
        postcss: './postcss.config.js',
    },
} );