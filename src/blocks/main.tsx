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

// Order By Options
const orderbyOptions = [
    { label: t( 'displays.orderNewest', __( 'Newest', 'jetreader' ) ), value: 'newest' },
    { label: t( 'displays.orderOldest', __( 'Oldest', 'jetreader' ) ), value: 'oldest' },
    { label: t( 'displays.orderViews', __( 'Most Viewed', 'jetreader' ) ), value: 'views' },
    { label: t( 'displays.orderFeatured', __( 'Featured First', 'jetreader' ) ), value: 'featured' },
    { label: t( 'displays.orderTitle', __( 'Title A→Z', 'jetreader' ) ), value: 'title' },
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

/* ------------------------------------------------------------------ */
/*  Grid Block                                                         */
/* ------------------------------------------------------------------ */

registerBlockType( 'jetreader/grid', {
    title: t( 'displays.gridLayout', __( 'JetReader Grid', 'jetreader' ) ),
    description: t( 'blocks.libraryDesc', __( 'Display library items in a configurable grid.', 'jetreader' ) ),
    category: 'widgets',
    icon: 'grid-view',
    keywords: [ 'grid', 'books', 'jetreader' ],
    supports: {
        align: true,
        spacing: {
            margin: true,
            padding: true,
        },
    },
    attributes: {
        type: { type: 'string', default: '' },
        category: { type: 'string', default: '' },
        author: { type: 'string', default: '' },
        columns: { type: 'number', default: 4 },
        columns_tablet: { type: 'number', default: 2 },
        columns_mobile: { type: 'number', default: 1 },
        limit: { type: 'number', default: 12 },
        orderby: { type: 'string', default: 'newest' },
        items: { type: 'string', default: '' },
        show_filter: { type: 'boolean', default: true },
        show_image: { type: 'boolean', default: true },
        show_description: { type: 'boolean', default: false },
        show_type: { type: 'boolean', default: true },
        show_author: { type: 'boolean', default: true },
        width: { type: 'string', default: '100%' },
        height: { type: 'string', default: 'auto' },
        title: { type: 'string', default: '' },
    },

    edit: ( { attributes, setAttributes }: any ) => {
        const blockProps = useBlockProps();

        return (
            <>
                <InspectorControls>
                    <PanelBody title={ t( 'displays.contentFilter', __( 'Content Filter', 'jetreader' ) ) } initialOpen>
                        <SelectControl
                            label={ t( 'displays.contentType', __( 'Content Type', 'jetreader' ) ) }
                            value={ attributes.type }
                            options={ contentTypeOptions }
                            onChange={ ( value: string ) => setAttributes( { type: value } ) }
                        />
                        <TextControl
                            label={ t( 'displays.filterCategory', __( 'Filter by Category ID', 'jetreader' ) ) }
                            value={ attributes.category }
                            placeholder="e.g. 5"
                            onChange={ ( value: string ) => setAttributes( { category: value } ) }
                        />
                        <TextControl
                            label={ t( 'displays.filterAuthor', __( 'Filter by Author Name', 'jetreader' ) ) }
                            value={ attributes.author }
                            placeholder="e.g. Orhan Pamuk"
                            onChange={ ( value: string ) => setAttributes( { author: value } ) }
                        />
                        <SelectControl
                            label={ t( 'displays.orderBy', __( 'Order By', 'jetreader' ) ) }
                            value={ attributes.orderby }
                            options={ orderbyOptions }
                            onChange={ ( value: string ) => setAttributes( { orderby: value } ) }
                        />
                        <RangeControl
                            label={ t( 'displays.maxItems', __( 'Max Items', 'jetreader' ) ) }
                            value={ attributes.limit }
                            min={ 1 }
                            max={ 100 }
                            onChange={ ( value: number ) => setAttributes( { limit: value } ) }
                        />
                        <TextControl
                            label={ t( 'displays.handpickedLabel', __( 'Handpicked Item IDs', 'jetreader' ) ) }
                            value={ attributes.items }
                            placeholder="e.g. 1,2,3"
                            help={ t( 'displays.handpickedHelp', __( 'Comma-separated list of IDs. Overrides filters above.', 'jetreader' ) ) }
                            onChange={ ( value: string ) => setAttributes( { items: value } ) }
                        />
                        <TextControl
                            label={ t( 'displays.labelSectionTitle', __( 'Section Title', 'jetreader' ) ) }
                            value={ attributes.title }
                            onChange={ ( value: string ) => setAttributes( { title: value } ) }
                        />
                    </PanelBody>

                    <PanelBody title={ t( 'displays.gridLayout', __( 'Grid Layout', 'jetreader' ) ) }>
                        <RangeControl
                            label={ t( 'displays.desktopColumns', __( 'Desktop Columns', 'jetreader' ) ) }
                            value={ attributes.columns }
                            min={ 1 }
                            max={ 6 }
                            onChange={ ( value: number ) => setAttributes( { columns: value } ) }
                        />
                        <RangeControl
                            label={ t( 'displays.tabletColumns', __( 'Tablet Columns', 'jetreader' ) ) }
                            value={ attributes.columns_tablet }
                            min={ 1 }
                            max={ 4 }
                            onChange={ ( value: number ) => setAttributes( { columns_tablet: value } ) }
                        />
                        <RangeControl
                            label={ t( 'displays.mobileColumns', __( 'Mobile Columns', 'jetreader' ) ) }
                            value={ attributes.columns_mobile }
                            min={ 1 }
                            max={ 2 }
                            onChange={ ( value: number ) => setAttributes( { columns_mobile: value } ) }
                        />
                        <ToggleControl
                            label={ t( 'displays.showFilterBar', __( 'Show Filter Bar', 'jetreader' ) ) }
                            checked={ attributes.show_filter }
                            onChange={ ( value: boolean ) => setAttributes( { show_filter: value } ) }
                        />
                    </PanelBody>

                    <PanelBody title={ t( 'displays.cardFields', __( 'Card Fields', 'jetreader' ) ) }>
                        <ToggleControl
                            label={ t( 'displays.showCoverImage', __( 'Show Cover Image', 'jetreader' ) ) }
                            checked={ attributes.show_image }
                            onChange={ ( value: boolean ) => setAttributes( { show_image: value } ) }
                        />
                        <ToggleControl
                            label={ t( 'displays.showDescriptionLabel', __( 'Show Description', 'jetreader' ) ) }
                            checked={ attributes.show_description }
                            onChange={ ( value: boolean ) => setAttributes( { show_description: value } ) }
                        />
                        <ToggleControl
                            label={ t( 'displays.showTypeBadge', __( 'Show Type Badge', 'jetreader' ) ) }
                            checked={ attributes.show_type }
                            onChange={ ( value: boolean ) => setAttributes( { show_type: value } ) }
                        />
                        <ToggleControl
                            label={ t( 'displays.showAuthorName', __( 'Show Author', 'jetreader' ) ) }
                            checked={ attributes.show_author }
                            onChange={ ( value: boolean ) => setAttributes( { show_author: value } ) }
                        />
                    </PanelBody>

                    <PanelBody title={ t( 'displays.dimensions', __( 'Dimensions', 'jetreader' ) ) }>
                        <TextControl
                            label={ t( 'displays.width', __( 'Width', 'jetreader' ) ) }
                            value={ attributes.width }
                            onChange={ ( value: string ) => setAttributes( { width: value } ) }
                        />
                        <TextControl
                            label={ t( 'displays.height', __( 'Height', 'jetreader' ) ) }
                            value={ attributes.height }
                            onChange={ ( value: string ) => setAttributes( { height: value } ) }
                        />
                    </PanelBody>
                </InspectorControls>

                <div { ...blockProps }>
                    <Placeholder
                        icon="grid-view"
                        label={ t( 'displays.gridLayout', __( 'JetReader Grid', 'jetreader' ) ) }
                        instructions={ t( 'blocks.libraryInstructions', __( 'This block displays a grid of library items on the front end. Configure settings in the block panel.', 'jetreader' ) ) }
                    >
                        <p className="jetreader-block-preview-info">
                            📊 { t( 'blocks.gridPreviewInfo', __( 'Grid layout with', 'jetreader' ) ) } { attributes.columns } { t( 'blocks.columns', __( 'columns', 'jetreader' ) ) }.
                            { attributes.title && ` (${attributes.title})` }
                        </p>
                    </Placeholder>
                </div>
            </>
        );
    },

    save: () => {
        return null;
    },
} );

/* ------------------------------------------------------------------ */
/*  Slider Block                                                       */
/* ------------------------------------------------------------------ */

registerBlockType( 'jetreader/slider', {
    title: t( 'displays.sliderLayout', __( 'JetReader Slider', 'jetreader' ) ),
    description: t( 'blocks.libraryDesc', __( 'Display library items in a horizontal draggable slider.', 'jetreader' ) ),
    category: 'widgets',
    icon: 'slides',
    keywords: [ 'slider', 'carousel', 'books', 'jetreader' ],
    supports: {
        align: true,
        spacing: {
            margin: true,
            padding: true,
        },
    },
    attributes: {
        type: { type: 'string', default: '' },
        category: { type: 'string', default: '' },
        author: { type: 'string', default: '' },
        limit: { type: 'number', default: 10 },
        orderby: { type: 'string', default: 'newest' },
        items: { type: 'string', default: '' },
        visible: { type: 'number', default: 4 },
        visible_tablet: { type: 'number', default: 2 },
        visible_mobile: { type: 'number', default: 1 },
        rows: { type: 'number', default: 1 },
        show_arrows: { type: 'boolean', default: true },
        show_dots: { type: 'boolean', default: true },
        drag: { type: 'boolean', default: true },
        autoplay: { type: 'boolean', default: false },
        autoplay_speed: { type: 'number', default: 3000 },
        show_image: { type: 'boolean', default: true },
        show_description: { type: 'boolean', default: false },
        show_type: { type: 'boolean', default: true },
        show_author: { type: 'boolean', default: true },
        width: { type: 'string', default: '100%' },
        height: { type: 'string', default: 'auto' },
        title: { type: 'string', default: '' },
        card_width: { type: 'string', default: '' },
    },

    edit: ( { attributes, setAttributes }: any ) => {
        const blockProps = useBlockProps();

        return (
            <>
                <InspectorControls>
                    <PanelBody title={ t( 'displays.contentFilter', __( 'Content Filter', 'jetreader' ) ) } initialOpen>
                        <SelectControl
                            label={ t( 'displays.contentType', __( 'Content Type', 'jetreader' ) ) }
                            value={ attributes.type }
                            options={ contentTypeOptions }
                            onChange={ ( value: string ) => setAttributes( { type: value } ) }
                        />
                        <TextControl
                            label={ t( 'displays.filterCategory', __( 'Filter by Category ID', 'jetreader' ) ) }
                            value={ attributes.category }
                            placeholder="e.g. 5"
                            onChange={ ( value: string ) => setAttributes( { category: value } ) }
                        />
                        <TextControl
                            label={ t( 'displays.filterAuthor', __( 'Filter by Author Name', 'jetreader' ) ) }
                            value={ attributes.author }
                            placeholder="e.g. Orhan Pamuk"
                            onChange={ ( value: string ) => setAttributes( { author: value } ) }
                        />
                        <SelectControl
                            label={ t( 'displays.orderBy', __( 'Order By', 'jetreader' ) ) }
                            value={ attributes.orderby }
                            options={ orderbyOptions }
                            onChange={ ( value: string ) => setAttributes( { orderby: value } ) }
                        />
                        <RangeControl
                            label={ t( 'displays.maxItems', __( 'Max Items', 'jetreader' ) ) }
                            value={ attributes.limit }
                            min={ 1 }
                            max={ 100 }
                            onChange={ ( value: number ) => setAttributes( { limit: value } ) }
                        />
                        <TextControl
                            label={ t( 'displays.handpickedLabel', __( 'Handpicked Item IDs', 'jetreader' ) ) }
                            value={ attributes.items }
                            placeholder="e.g. 1,2,3"
                            help={ t( 'displays.handpickedHelp', __( 'Comma-separated list of IDs. Overrides filters above.', 'jetreader' ) ) }
                            onChange={ ( value: string ) => setAttributes( { items: value } ) }
                        />
                        <TextControl
                            label={ t( 'displays.labelSectionTitle', __( 'Section Title', 'jetreader' ) ) }
                            value={ attributes.title }
                            onChange={ ( value: string ) => setAttributes( { title: value } ) }
                        />
                    </PanelBody>

                    <PanelBody title={ t( 'displays.sliderLayout', __( 'Slider Settings', 'jetreader' ) ) }>
                        <RangeControl
                            label={ t( 'displays.visibleDesktop', __( 'Visible Items (Desktop)', 'jetreader' ) ) }
                            value={ attributes.visible }
                            min={ 1 }
                            max={ 8 }
                            onChange={ ( value: number ) => setAttributes( { visible: value } ) }
                        />
                        <RangeControl
                            label={ t( 'displays.visibleTablet', __( 'Visible Items (Tablet)', 'jetreader' ) ) }
                            value={ attributes.visible_tablet }
                            min={ 1 }
                            max={ 4 }
                            onChange={ ( value: number ) => setAttributes( { visible_tablet: value } ) }
                        />
                        <RangeControl
                            label={ t( 'displays.visibleMobile', __( 'Visible Items (Mobile)', 'jetreader' ) ) }
                            value={ attributes.visible_mobile }
                            min={ 1 }
                            max={ 2 }
                            onChange={ ( value: number ) => setAttributes( { visible_mobile: value } ) }
                        />
                        <RangeControl
                            label={ t( 'displays.rowsPerSlide', __( 'Rows per Slide', 'jetreader' ) ) }
                            value={ attributes.rows }
                            min={ 1 }
                            max={ 4 }
                            onChange={ ( value: number ) => setAttributes( { rows: value } ) }
                        />
                        <TextControl
                            label={ t( 'displays.cardWidth', __( 'Card Width', 'jetreader' ) ) }
                            value={ attributes.card_width }
                            placeholder="e.g. 200px"
                            help={ t( 'displays.cardWidthHelp', __( 'Fixed width. Leave empty to use Visible Items count.', 'jetreader' ) ) }
                            onChange={ ( value: string ) => setAttributes( { card_width: value } ) }
                        />
                        <ToggleControl
                            label={ t( 'displays.enableMouseDrag', __( 'Enable Mouse Drag', 'jetreader' ) ) }
                            checked={ attributes.drag }
                            onChange={ ( value: boolean ) => setAttributes( { drag: value } ) }
                        />
                        <ToggleControl
                            label={ t( 'displays.autoplay', __( 'Autoplay', 'jetreader' ) ) }
                            checked={ attributes.autoplay }
                            onChange={ ( value: boolean ) => setAttributes( { autoplay: value } ) }
                        />
                        { attributes.autoplay && (
                            <TextControl
                                label={ t( 'displays.autoplaySpeed', __( 'Autoplay Speed (ms)', 'jetreader' ) ) }
                                value={ attributes.autoplay_speed }
                                onChange={ ( value: string ) => setAttributes( { autoplay_speed: parseInt( value, 10 ) || 3000 } ) }
                            />
                        ) }
                        <ToggleControl
                            label={ t( 'displays.showNavigationArrows', __( 'Show Navigation Arrows', 'jetreader' ) ) }
                            checked={ attributes.show_arrows }
                            onChange={ ( value: boolean ) => setAttributes( { show_arrows: value } ) }
                        />
                        <ToggleControl
                            label={ t( 'displays.showDotNavigation', __( 'Show Dot Navigation', 'jetreader' ) ) }
                            checked={ attributes.show_dots }
                            onChange={ ( value: boolean ) => setAttributes( { show_dots: value } ) }
                        />
                    </PanelBody>

                    <PanelBody title={ t( 'displays.cardFields', __( 'Card Fields', 'jetreader' ) ) }>
                        <ToggleControl
                            label={ t( 'displays.showCoverImage', __( 'Show Cover Image', 'jetreader' ) ) }
                            checked={ attributes.show_image }
                            onChange={ ( value: boolean ) => setAttributes( { show_image: value } ) }
                        />
                        <ToggleControl
                            label={ t( 'displays.showDescriptionLabel', __( 'Show Description', 'jetreader' ) ) }
                            checked={ attributes.show_description }
                            onChange={ ( value: boolean ) => setAttributes( { show_description: value } ) }
                        />
                        <ToggleControl
                            label={ t( 'displays.showTypeBadge', __( 'Show Type Badge', 'jetreader' ) ) }
                            checked={ attributes.show_type }
                            onChange={ ( value: boolean ) => setAttributes( { show_type: value } ) }
                        />
                        <ToggleControl
                            label={ t( 'displays.showAuthorName', __( 'Show Author', 'jetreader' ) ) }
                            checked={ attributes.show_author }
                            onChange={ ( value: boolean ) => setAttributes( { show_author: value } ) }
                        />
                    </PanelBody>

                    <PanelBody title={ t( 'displays.dimensions', __( 'Dimensions', 'jetreader' ) ) }>
                        <TextControl
                            label={ t( 'displays.width', __( 'Width', 'jetreader' ) ) }
                            value={ attributes.width }
                            onChange={ ( value: string ) => setAttributes( { width: value } ) }
                        />
                        <TextControl
                            label={ t( 'displays.height', __( 'Height', 'jetreader' ) ) }
                            value={ attributes.height }
                            onChange={ ( value: string ) => setAttributes( { height: value } ) }
                        />
                    </PanelBody>
                </InspectorControls>

                <div { ...blockProps }>
                    <Placeholder
                        icon="slides"
                        label={ t( 'displays.sliderLayout', __( 'JetReader Slider', 'jetreader' ) ) }
                        instructions={ t( 'blocks.libraryInstructions', __( 'This block displays a grid of library items on the front end. Configure settings in the block panel.', 'jetreader' ) ) }
                    >
                        <p className="jetreader-block-preview-info">
                            🎠 { t( 'blocks.sliderLayoutShowing', __( 'Slider layout showing', 'jetreader' ) ) } { attributes.visible } { t( 'blocks.items', __( 'items', 'jetreader' ) ) }.
                            { attributes.title && ` (${attributes.title})` }
                        </p>
                    </Placeholder>
                </div>
            </>
        );
    },

    save: () => {
        return null;
    },
} );