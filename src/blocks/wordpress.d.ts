/**
 * Type declarations for WordPress Gutenberg block editor globals.
 * These modules are provided by WordPress, not npm.
 *
 * @package JetReader
 */

declare module '@wordpress/blocks' {
    export function registerBlockType(
        name: string,
        settings: Record<string, unknown>
    ): void;
}

declare module '@wordpress/block-editor' {
    export function useBlockProps( props?: Record<string, unknown> ): Record<string, unknown>;
    export const InspectorControls: React.FC<{ children: React.ReactNode }>;
}

declare module '@wordpress/components' {
    export const PanelBody: React.FC<{
        title: string;
        initialOpen?: boolean;
        children: React.ReactNode;
    }>;
    export const SelectControl: React.FC<{
        label: string;
        value: string;
        options: Array<{ label: string; value: string }>;
        onChange: ( value: string ) => void;
    }>;
    export const Placeholder: React.FC<{
        icon?: React.ReactNode;
        label: string;
        instructions?: string;
        children?: React.ReactNode;
    }>;
    export const Icon: React.FC<{ icon: unknown }>;
}

declare module '@wordpress/i18n' {
    export function __( text: string, domain?: string ): string;
}

declare module '@wordpress/icons' {
    export const book: unknown;
    export const search: unknown;
    export const starFilled: unknown;
}