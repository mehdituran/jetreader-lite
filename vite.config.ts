import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import { readFileSync, writeFileSync, mkdirSync } from 'fs';

// Custom plugin to copy PDF.js worker into dist/js/ during build and prepend Promise.withResolvers polyfill.
function copyPdfWorker() {
    return {
        name: 'copy-pdf-worker',
        writeBundle() {
            const src  = path.resolve( __dirname, 'node_modules/pdfjs-dist/build/pdf.worker.min.mjs' );
            const dest = path.resolve( __dirname, 'dist/js/pdf.worker.min.mjs' );
            mkdirSync( path.dirname( dest ), { recursive: true } );
            
            const polyfill = `if (typeof Promise.withResolvers === 'undefined') {
    Promise.withResolvers = function () {
        let resolve, reject;
        const promise = new Promise((res, rej) => {
            resolve = res;
            reject = rej;
        });
        return { promise, resolve, reject };
    };
}
`;
            const originalCode = readFileSync( src, 'utf8' );
            writeFileSync( dest, polyfill + originalCode, 'utf8' );
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
// always true for this open source release.
const isLiteBuild = true;

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
        },
    },
    css: {
        postcss: './postcss.config.js',
    },
} );