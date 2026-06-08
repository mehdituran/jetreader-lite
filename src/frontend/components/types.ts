export interface VolumeEntry {
    vol: number;
    file_path: string;
    file_type: string;
    cover_image: string;
    page_count?: number;
}

export interface DisplayItem {
    id: number;
    type: string;
    title: string;
    slug: string;
    description: string;
    cover_image: string;
    file_path: string;
    file_type: string;
    language: string;
    author: string;
    translator?: string;
    publisher: string;
    publication_year: number;
    reading_time: number;
    page_count?: number;
    featured: boolean;
    view_count: number;
    volumes?: VolumeEntry[] | null;
    cpt_url?: string;
    category_ids?: number[];
    created_at: string;
}

export interface DisplayAttrs {
    // filtering
    type: string;
    category: string;
    author: string;
    limit: number;
    orderby: string;
    items: string;
    // visibility
    showImage: boolean;
    showDescription: boolean;
    showType: boolean;
    showAuthor: boolean;
    showFilter: boolean;
    showReadButton: boolean;
    showInfoButton: boolean;
    showTranslator?: boolean;
    showPublisher?: boolean;
    showYear?: boolean;
    showLanguage?: boolean;
    showPageCount?: boolean;
    // dimensions
    width: string;
    height: string;
    title: string;
    // card appearance
    imageSize?: 'small' | 'medium' | 'large' | 'xlarge' | 'xxlarge';
    imageFit?:  'cover' | 'contain' | 'fill';
    cardMinWidth?: number;
    cardRadius?: 'none' | 'small' | 'medium' | 'large' | 'xlarge';
    cardBorder?: 'none' | 'subtle' | 'thick';
    cardShadow?: 'none' | 'subtle' | 'medium' | 'large';
    cardHover?: 'none' | 'lift' | 'zoom' | 'glow' | 'shadow';
    cardAlign?: 'left' | 'center';
    cardLayout?: 'vertical' | 'horizontal';
}

export interface GridAttrs extends DisplayAttrs {
    columns: number;
    columnsTablet: number;
    columnsMobile: number;
}

export interface SliderAttrs extends DisplayAttrs {
    visible: number;
    visibleTablet: number;
    visibleMobile: number;
    rows: number;
    showArrows: boolean;
    showDots: boolean;
    drag: boolean;
    autoplay: boolean;
    autoplaySpeed: number;
    cardWidth?: string;
}
