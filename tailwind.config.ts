import type { Config } from 'tailwindcss';

const config: Config = {
    // 'class' strategy: dark: variants only activate when a .dark class is
    // explicitly present in the DOM. This prevents the library UI from
    // switching to dark background when the visitor's OS has dark mode on —
    // the color palette set by the admin should always be respected.
    darkMode: 'class',
    content: [
        './src/**/*.{ts,tsx,js,jsx}',
        './includes/**/*.php',
    ],
    theme: {
        extend: {
            colors: {
                primary: {
                    50: '#eff6ff',
                    100: '#dbeafe',
                    200: '#bfdbfe',
                    300: '#93c5fd',
                    400: '#60a5fa',
                    500: '#3b82f6',
                    600: '#2563eb',
                    700: '#1d4ed8',
                    800: '#1e40af',
                    900: '#1e3a8a',
                },
                reader: {
                    light: '#ffffff',
                    dark: '#1a1a2e',
                    sepia: '#f4ecd8',
                },
            },
            fontFamily: {
                sans: ['Inter', 'system-ui', 'sans-serif'],
                serif: ['Georgia', 'Times New Roman', 'serif'],
                mono: ['JetBrains Mono', 'Consolas', 'monospace'],
            },
        },
    },
    safelist: [
        // containerBg
        'bg-gray-950', 'text-gray-100',
        'bg-[#f4ecd8]', 'text-[#5c4a1e]',
        'bg-white', 'text-gray-900',
        // toolbarBg
        'bg-gray-900/95', 'border-gray-800',
        'bg-amber-100/95', 'border-amber-300',
        'bg-gray-50/95', 'border-gray-200',
        // sidebarBg
        'bg-gray-900', 'bg-amber-50', 'border-amber-200', 'bg-gray-50',
        // controlBtn
        'bg-gray-800', 'border-gray-700', 'text-gray-200', 'hover:bg-gray-700',
        'bg-amber-50', 'border-amber-300', 'text-amber-900', 'hover:bg-amber-100',
        'border-gray-300', 'text-gray-700', 'hover:bg-gray-50',
        // inputCls
        'border-gray-600', 'text-gray-100', 'placeholder-gray-500',
        'placeholder-amber-400',
        'text-gray-800', 'placeholder-gray-400',
        // inline toolbar theme classes
        'bg-blue-700', 'bg-blue-600', 'border-blue-600',
        'bg-gray-700', 'text-gray-300', 'hover:bg-gray-600',
        'bg-amber-100', 'text-amber-800', 'hover:bg-amber-200',
        'bg-gray-200', 'text-gray-600', 'hover:bg-gray-300',
        'bg-amber-700',
    ],
    important: true,
    corePlugins: {
        preflight: false,
    },
    plugins: [],
};

export default config;