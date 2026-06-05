/**
 * JetReader Gutenberg Block Editor Script.
 *
 * Registers block type definitions client-side for the WordPress editor.
 * The actual rendering is done server-side via render_callback in PHP.
 *
 * @package JetReader
 */

import { registerBlockType } from '@wordpress/blocks';
import {
    InspectorControls,
    useBlockProps,
} from '@wordpress/block-editor';
import {
    PanelBody,
    SelectControl,
    Placeholder,
    Icon,
} from '@wordpress/components';
import { __ } from '@wordpress/i18n';
import { book as bookIcon, search as searchIcon, starFilled as starIcon } from '@wordpress/icons';

/* ------------------------------------------------------------------ */
/*  Library Block                                                      */
/* ------------------------------------------------------------------ */

registerBlockType( 'jetreader/library', {
    title: __( 'JetReader Library', 'jetreader' ),
    description: __( 'Display a grid of digital library items with filtering.', 'jetreader' ),
    category: 'widgets',
    icon: <Icon icon={ bookIcon } />,
    keywords: [ 'library', 'books', 'jetreader' ],
    supports: {
        align: true,
        spacing: {
            margin: true,
            padding: true,
        },
    },
    attributes: {
        type: {
            type: 'string',
            default: 'books',
        },
    },

    edit: ( { attributes, setAttributes }: { attributes: { type: string }; setAttributes: ( attrs: { type: string } ) => void } ) => {
        const blockProps = useBlockProps();

        return (
            <>
                <InspectorControls>
                    <PanelBody title={ __( 'Library Settings', 'jetreader' ) } initialOpen>
                        <SelectControl
                            label={ __( 'Content Type', 'jetreader' ) }
                            value={ attributes.type }
                            options={ [
                                { label: __( 'Books', 'jetreader' ), value: 'books' },
                                { label: __( 'Articles', 'jetreader' ), value: 'articles' },
                                { label: __( 'Magazines', 'jetreader' ), value: 'magazines' },
                                { label: __( 'Q&A', 'jetreader' ), value: 'qa' },
                            ] }
                            onChange={ ( value ) => setAttributes( { type: value } ) }
                        />
                    </PanelBody>
                </InspectorControls>

                <div { ...blockProps }>
                    <Placeholder
                        icon={ <Icon icon={ bookIcon } /> }
                        label={ __( 'JetReader Library', 'jetreader' ) }
                        instructions={ __( 'This block displays a grid of library items on the front end. Configure the type in the block settings panel.', 'jetreader' ) }
                    >
                        <p className="jetreader-block-preview-info">
                            📚 { __( 'Showing', 'jetreader' ) }: { attributes.type }
                        </p>
                    </Placeholder>
                </div>
            </>
        );
    },

    save: () => {
        // Dynamic block — rendered via PHP.
        return null;
    },
} );

/* ------------------------------------------------------------------ */
/*  Search Block                                                       */
/* ------------------------------------------------------------------ */

registerBlockType( 'jetreader/search', {
    title: __( 'JetReader Search', 'jetreader' ),
    description: __( 'A full-text search form for your digital library.', 'jetreader' ),
    category: 'widgets',
    icon: <Icon icon={ searchIcon } />,
    keywords: [ 'search', 'library', 'jetreader' ],
    supports: {
        align: true,
        spacing: {
            margin: true,
            padding: true,
        },
    },

    edit: () => {
        const blockProps = useBlockProps();

        return (
            <div { ...blockProps }>
                <Placeholder
                    icon={ <Icon icon={ searchIcon } /> }
                    label={ __( 'JetReader Search', 'jetreader' ) }
                    instructions={ __( 'A search form for your digital library will appear here on the front end.', 'jetreader' ) }
                >
                    <p className="jetreader-block-preview-info">
                        🔍 { __( 'Full-text search across all library items.', 'jetreader' ) }
                    </p>
                </Placeholder>
            </div>
        );
    },

    save: () => {
        return null;
    },
} );

/* ------------------------------------------------------------------ */
/*  Featured Block                                                     */
/* ------------------------------------------------------------------ */

registerBlockType( 'jetreader/featured', {
    title: __( 'JetReader Featured', 'jetreader' ),
    description: __( 'Showcase featured items from your library.', 'jetreader' ),
    category: 'widgets',
    icon: <Icon icon={ starIcon } />,
    keywords: [ 'featured', 'books', 'jetreader' ],
    supports: {
        align: true,
        spacing: {
            margin: true,
            padding: true,
        },
    },

    edit: () => {
        const blockProps = useBlockProps();

        return (
            <div { ...blockProps }>
                <Placeholder
                    icon={ <Icon icon={ starIcon } /> }
                    label={ __( 'JetReader Featured', 'jetreader' ) }
                    instructions={ __( 'Featured library items will be displayed here on the front end.', 'jetreader' ) }
                >
                    <p className="jetreader-block-preview-info">
                        ⭐ { __( 'Showcases items marked as "Featured".', 'jetreader' ) }
                    </p>
                </Placeholder>
            </div>
        );
    },

    save: () => {
        return null;
    },
} );