/**
 * JetReader Gutenberg Block Editor Script.
 *
 * Registers block type definitions client-side for the WordPress editor.
 * The actual rendering is done server-side via render_callback in PHP.
 *
 * @package JetReader
 */

// Retrieve WordPress globals from window.wp
const wp = (window as any).wp;
const { registerBlockType } = wp.blocks;
const { InspectorControls, useBlockProps } = wp.blockEditor;
const { PanelBody, SelectControl, Placeholder, ToggleControl, RangeControl, TextControl } = wp.components;
const { __ } = wp.i18n;

// Retrieve translations from global window.jetreaderBlocks
const jetreaderBlocks = (window as any).jetreaderBlocks || {};
const rawTranslations = jetreaderBlocks.translations || {};

/**
 * Resolve a dot-separated translation key.
 */
function resolvePath( obj: any, path: string ): any {
    const parts = path.split( '.' );
    let current = obj;
    for ( const part of parts ) {
        if ( current && typeof current === 'object' && part in current ) {
            current = current[ part ];
        } else {
            return undefined;
        }
    }
    return typeof current === 'string' ? current : undefined;
}

/**
 * Translate helper with fallback to default string.
 */
function t( key: string, fallback: string ): string {
    const resolved = resolvePath( rawTranslations, key );
    return resolved !== undefined ? resolved : fallback;
}

// Content Type Options
const contentTypeOptions = [
    { label: t( 'displays.allTypes', __( 'All Types', 'jetreader' ) ), value: '' },
    { label: t( 'items.typeTabsBooks', __( 'Books', 'jetreader' ) ), value: 'book' },
    { label: t( 'items.typeTabsArticles', __( 'Articles', 'jetreader' ) ), value: 'article' },
    { label: t( 'items.typeTabsMagazines', __( 'Magazines', 'jetreader' ) ), value: 'magazine' },
    { label: t( 'items.typeTabsQA', __( 'Q&A', 'jetreader' ) ), value: 'qa' },
];

/* ------------------------------------------------------------------ */
/*  Library Block                                                      */
/* ------------------------------------------------------------------ */

registerBlockType( 'jetreader/library', {
    title: t( 'blocks.libraryTitle', __( 'JetReader Library', 'jetreader' ) ),
    description: t( 'blocks.libraryDesc', __( 'Display a grid of digital library items with filtering.', 'jetreader' ) ),
    category: 'widgets',
    icon: 'book-alt',
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
            default: '',
        },
        search: {
            type: 'string',
            default: 'title',
        },
    },

    edit: ( { attributes, setAttributes }: any ) => {
        const blockProps = useBlockProps();

        return (
            <>
                <InspectorControls>
                    <PanelBody title={ t( 'blocks.librarySettings', __( 'Library Settings', 'jetreader' ) ) } initialOpen>
                        <SelectControl
                            label={ t( 'blocks.libraryContentType', __( 'Default Content Type', 'jetreader' ) ) }
                            value={ attributes.type }
                            options={ contentTypeOptions }
                            onChange={ ( value: string ) => setAttributes( { type: value } ) }
                        />
                        <SelectControl
                            label={ t( 'displays.searchMode', __( 'Search Mode', 'jetreader' ) ) }
                            value={ attributes.search }
                            options={ [
                                { label: t( 'blocks.searchTitleDesc', __( 'Search Title & Description', 'jetreader' ) ), value: 'title' },
                                { label: t( 'blocks.searchTextSearch', __( 'Full-Text Content Search', 'jetreader' ) ), value: 'content' },
                            ] }
                            onChange={ ( value: string ) => setAttributes( { search: value } ) }
                        />
                    </PanelBody>
                </InspectorControls>

                <div { ...blockProps }>
                    <Placeholder
                        icon="book-alt"
                        label={ t( 'blocks.libraryTitle', __( 'JetReader Library', 'jetreader' ) ) }
                        instructions={ t( 'blocks.libraryInstructions', __( 'This block displays a grid of library items on the front end. Configure settings in the block panel.', 'jetreader' ) ) }
                    >
                        <p className="jetreader-block-preview-info">
                            📚 { t( 'blocks.defaultType', __( 'Default Type', 'jetreader' ) ) }: { attributes.type || t( 'displays.allTypes', __( 'All Types', 'jetreader' ) ) }
                            { ' | ' }
                            🔍 { t( 'blocks.searchMode', __( 'Search Mode', 'jetreader' ) ) }: { attributes.search === 'content' ? t( 'blocks.fullText', __( 'Full-Text', 'jetreader' ) ) : t( 'blocks.titleDesc', __( 'Title & Desc', 'jetreader' ) ) }
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
    title: t( 'blocks.searchTitle', __( 'JetReader Search', 'jetreader' ) ),
    description: t( 'blocks.searchDesc', __( 'A full-text search form for your digital library.', 'jetreader' ) ),
    category: 'widgets',
    icon: 'search',
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
                    icon="search"
                    label={ t( 'blocks.searchTitle', __( 'JetReader Search', 'jetreader' ) ) }
                    instructions={ t( 'blocks.searchInstructions', __( 'A search form for your digital library will appear here on the front end.', 'jetreader' ) ) }
                >
                    <p className="jetreader-block-preview-info">
                        🔍 { t( 'blocks.searchPreview', __( 'Full-text search across all library items.', 'jetreader' ) ) }
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
    title: t( 'blocks.featuredTitle', __( 'JetReader Featured', 'jetreader' ) ),
    description: t( 'blocks.featuredDesc', __( 'Showcase featured items from your library.', 'jetreader' ) ),
    category: 'widgets',
    icon: 'star-filled',
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
                    icon="star-filled"
                    label={ t( 'blocks.featuredTitle', __( 'JetReader Featured', 'jetreader' ) ) }
                    instructions={ t( 'blocks.featuredInstructions', __( 'Featured library items will be displayed here on the front end.', 'jetreader' ) ) }
                >
                    <p className="jetreader-block-preview-info">
                        ⭐ { t( 'blocks.featuredPreview', __( 'Showcases items marked as "Featured".', 'jetreader' ) ) }
                    </p>
                </Placeholder>
            </div>
        );
    },

    save: () => {
        return null;
    },
} );

