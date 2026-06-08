import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery, QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useKeenSlider } from 'keen-slider/react';
import 'keen-slider/keen-slider.min.css';
import { AnimatePresence } from 'framer-motion';
import { I18nProvider, useTranslation } from '../../i18n/I18nContext';
import ItemCard from './ItemCard';
import SliderArrow from './SliderArrow';
import SliderDots from './SliderDots';
import type { DisplayItem, SliderAttrs } from './types';

const API_BASE = ( window as any ).jetreaderSettings?.apiUrl?.replace( /\/$/, '' ) ?? '/wp-json/jetreader/v1';

/* ------------------------------------------------------------------ */
/*  Hooks                                                              */
/* ------------------------------------------------------------------ */

function usePublicSettings() {
    return useQuery<{ download_enabled: boolean }>( {
        queryKey: [ 'jr-public-settings' ],
        queryFn: async () => {
            const res = await fetch( `${ API_BASE }/public/settings` );
            return res.json();
        },
        staleTime: 1000 * 60 * 10,
    } );
}

function useItems( params: Record<string, string | number> ) {
    return useQuery<{ items: DisplayItem[] }>( {
        queryKey: [ 'jr-slider-items', params ],
        queryFn: async () => {
            const url = new URL( `${ API_BASE }/items`, window.location.href );
            Object.entries( params ).forEach( ( [ k, v ] ) => {
                if ( v !== '' && v !== null && v !== undefined ) url.searchParams.set( k, String( v ) );
            } );
            const res = await fetch( url.toString() );
            return res.json();
        },
        staleTime: 1000 * 60 * 3,
    } );
}

function useResponsiveVisible( desktop: number, tablet: number, mobile: number ): number {
    const get = () => {
        const w = window.innerWidth;
        if ( w < 768 )  return mobile;
        if ( w < 1024 ) return tablet;
        return desktop;
    };
    const [ val, setVal ] = useState( get );
    useEffect( () => {
        const ro = new ResizeObserver( () => setVal( get() ) );
        ro.observe( document.documentElement );
        return () => ro.disconnect();
    }, [ desktop, tablet, mobile ] );
    return val;
}

function useContainerWidth( ref: React.RefObject<HTMLElement> ): number {
    const [ width, setWidth ] = useState( 0 );
    useEffect( () => {
        if ( ! ref.current ) return;
        const ro = new ResizeObserver( entries => setWidth( entries[ 0 ].contentRect.width ) );
        ro.observe( ref.current );
        return () => ro.disconnect();
    }, [] );
    return width;
}

/* ------------------------------------------------------------------ */
/*  Skeleton                                                           */
/* ------------------------------------------------------------------ */

const SliderSkeleton: React.FC<{ count: number }> = ( { count } ) => (
    <div className="keen-slider">
        { Array.from( { length: count } ).map( ( _, i ) => (
            <div key={ i } className="keen-slider__slide px-1">
                <div className="jr-card overflow-hidden rounded-xl">
                    <div className="jr-skeleton h-44 w-full" />
                    <div className="p-3 space-y-2">
                        <div className="jr-skeleton h-3.5 w-3/4 rounded" />
                        <div className="jr-skeleton h-3 w-1/2 rounded" />
                    </div>
                </div>
            </div>
        ) ) }
    </div>
);

/* ------------------------------------------------------------------ */
/*  DisplaySlider (inner)                                              */
/* ------------------------------------------------------------------ */

const DisplaySliderInner: React.FC<SliderAttrs> = ( attrs ) => {
    const { t, direction } = useTranslation();
    const perView      = useResponsiveVisible( attrs.visible, attrs.visibleTablet, attrs.visibleMobile );
    const trackRef     = useRef<HTMLDivElement>( null );
    const trackWidth   = useContainerWidth( trackRef );
    const cardMinWidth = attrs.cardMinWidth ?? 160;

    // Clamp perView: cardMinWidth alt sınır, visible üst sınır.
    const effectivePerView = trackWidth > 0
        ? Math.max( 1, Math.min( perView, Math.floor( trackWidth / cardMinWidth ) ) )
        : perView;

    const rows      = Math.max( 1, attrs.rows );
    const perSlide  = effectivePerView * rows;
    const cardWidth = attrs.cardWidth ?? '';
    const isAutoW   = !! cardWidth && cardWidth !== 'auto';

    const apiParams = useMemo( () => {
        const p: Record<string, string | number> = {
            per_page: attrs.limit,
            orderby:  attrs.orderby,
        };
        if ( attrs.type )       p.type        = attrs.type;
        if ( attrs.category )   p.category_id = attrs.category;
        if ( attrs.author )     p.author      = attrs.author;
        if ( attrs.items )      p.include_ids = attrs.items;
        if ( ! attrs.showImage ) p.fields = 'id,type,title,slug,description,file_path,file_type,language,author,publisher,publication_year,reading_time,page_count,featured,view_count,volumes,category_ids,cpt_url,created_at,updated_at';
        return p;
    }, [ attrs ] );

    const { data, isLoading }      = useItems( apiParams );
    const { data: publicSettings } = usePublicSettings();
    const downloadEnabled = publicSettings?.download_enabled === true;
    const showPageCount = ( publicSettings as any )?.show_card_page_count !== false && attrs.showPageCount !== false;
    const allItems = data?.items ?? [];

    // Group items into slide chunks for rows>1 mode.
    const slides: DisplayItem[][] = useMemo( () => {
        if ( rows === 1 ) return allItems.map( item => [ item ] );
        const result: DisplayItem[][] = [];
        for ( let i = 0; i < allItems.length; i += perSlide ) {
            result.push( allItems.slice( i, i + perSlide ) );
        }
        return result;
    }, [ allItems, rows, perSlide ] );

    const [ currentSlide, setCurrentSlide ] = useState( 0 );
    const [ loaded, setLoaded ]             = useState( false );
    const [ paused, setPaused ]             = useState( false );
    const autoplayTimer                     = useRef<ReturnType<typeof setInterval>>();

    const [ sliderRef, instanceRef ] = useKeenSlider<HTMLDivElement>(
        {
            initial: 0,
            rtl:     direction === 'rtl',
            loop:    slides.length > ( rows === 1 ? effectivePerView : 1 ),
            drag:    attrs.drag,
            slides:  isAutoW
                ? { perView: 'auto', spacing: 16 }
                : rows === 1
                    ? { perView: effectivePerView, spacing: 16 }
                    : { perView: 1, spacing: 0 },
            created() { setLoaded( true ); },
        },
        [
            // Resize adapter.
            ( slider ) => {
                let t: ReturnType<typeof setTimeout>;
                const h = () => { clearTimeout( t ); t = setTimeout( () => slider.update(), 250 ); };
                window.addEventListener( 'resize', h );
                slider.on( 'destroyed', () => window.removeEventListener( 'resize', h ) );
            },
        ]
    );

    // Sync current slide index via imperative on() — survives update() calls unlike options callbacks.
    useEffect( () => {
        if ( ! loaded || ! instanceRef.current ) return;
        const slider = instanceRef.current;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const sync = ( s: any ) => {
            const rel = s?.track?.details?.rel;
            if ( typeof rel === 'number' ) setCurrentSlide( rel );
        };
        slider.on( 'slideChanged', sync );
        slider.on( 'animationEnded', sync );
        return () => {
            slider.on( 'slideChanged', sync, true );
            slider.on( 'animationEnded', sync, true );
        };
    }, [ loaded ] );

    // Re-configure slider when effectivePerView changes due to container resize.
    useEffect( () => {
        if ( ! loaded || ! instanceRef.current ) return;
        instanceRef.current.update( {
            rtl: direction === 'rtl',
            loop: slides.length > ( rows === 1 ? effectivePerView : 1 ),
            slides: isAutoW
                ? { perView: 'auto', spacing: 16 }
                : rows === 1
                    ? { perView: effectivePerView, spacing: 16 }
                    : { perView: 1, spacing: 0 },
        } );
    }, [ effectivePerView, loaded, rows, isAutoW, slides.length, direction ] );

    // Autoplay with hover-pause support.
    useEffect( () => {
        if ( ! attrs.autoplay || ! instanceRef.current ) return;
        clearInterval( autoplayTimer.current );
        if ( ! paused ) {
            autoplayTimer.current = setInterval( () => {
                instanceRef.current?.next();
            }, attrs.autoplaySpeed );
        }
        return () => clearInterval( autoplayTimer.current );
    }, [ attrs.autoplay, attrs.autoplaySpeed, instanceRef, slides.length, paused ] );

    // Page-based dots: one dot per group of effectivePerView slides.
    const totalDots = rows === 1
        ? Math.ceil( slides.length / effectivePerView )
        : slides.length;

    // Map keen-slider rel index → page dot (floor division, modulo for loop wrap).
    const currentDot = totalDots > 0
        ? Math.floor( currentSlide / ( rows === 1 ? effectivePerView : 1 ) ) % totalDots
        : 0;

    const slideStyle = isAutoW ? { width: cardWidth, minWidth: cardWidth } : {};

    if ( isLoading ) return <SliderSkeleton count={ effectivePerView } />;

    if ( allItems.length === 0 ) {
        return (
            <div className="text-center py-12 text-gray-400 dark:text-gray-600">
                <p className="text-4xl mb-2">📭</p>
                <p className="text-sm">{ t( 'display.noItems' ) }</p>
            </div>
        );
    }

    const isLooped = slides.length > ( rows === 1 ? effectivePerView : 1 );

    return (
        <div
            dir={ direction }
            className="jr-slider-display"
            onMouseEnter={ () => setPaused( true ) }
            onMouseLeave={ () => setPaused( false ) }
        >
            { attrs.title && (
                <div className="jr-display-title-row flex items-center justify-between mb-5">
                    <h2 className="jr-display-title text-xl font-bold text-gray-900 dark:text-white tracking-tight">
                        { attrs.title }
                    </h2>
                    { loaded && slides.length > 1 && (
                        <span className="text-xs text-gray-400 dark:text-gray-500 tabular-nums select-none">
                            { currentDot + 1 } / { totalDots }
                        </span>
                    ) }
                </div>
            ) }

            {/* Track wrapper — gives arrows room to breathe */}
            <div className="jr-slider-track relative px-6" ref={ trackRef }>
                { attrs.showArrows && loaded && (
                    <SliderArrow
                        direction="left"
                        onClick={ () => instanceRef.current?.prev() }
                        disabled={ ! isLooped && currentSlide === 0 }
                    />
                ) }

                <div ref={ sliderRef } className="keen-slider rounded-xl">
                    { rows === 1
                        ? allItems.map( ( item ) => (
                            <div key={ item.id } className="keen-slider__slide" style={ slideStyle }>
                                <div className="px-1.5 h-full">
                                    <ItemCard
                                        item={ item }
                                        showImage={ attrs.showImage }
                                        showDescription={ attrs.showDescription }
                                        showType={ attrs.showType }
                                        showAuthor={ attrs.showAuthor }
                                        showReadButton={ attrs.showReadButton }
                                        showInfoButton={ attrs.showInfoButton }
                                        showDownloadButton={ downloadEnabled }
                                        showTranslator={ attrs.showTranslator }
                                        showPublisher={ attrs.showPublisher }
                                        showYear={ attrs.showYear }
                                        showLanguage={ attrs.showLanguage }
                                        showPageCount={ showPageCount }
                                        imageSize={ attrs.imageSize }
                                        imageFit={ attrs.imageFit }
                                        cardRadius={ attrs.cardRadius }
                                        cardBorder={ attrs.cardBorder }
                                        cardShadow={ attrs.cardShadow }
                                        cardHover={ attrs.cardHover }
                                        cardAlign={ attrs.cardAlign }
                                        cardLayout={ attrs.cardLayout }
                                        compact
                                    />
                                </div>
                            </div>
                        ) )
                        : slides.map( ( group, gi ) => (
                            <div key={ gi } className="keen-slider__slide" style={ slideStyle }>
                                <div
                                    className="px-1.5"
                                    style={ {
                                        display: 'grid',
                                        gridTemplateColumns: `repeat(${ effectivePerView }, minmax(0,1fr))`,
                                        gridTemplateRows:    `repeat(${ rows }, auto)`,
                                        gap: '1rem',
                                    } }
                                >
                                    <AnimatePresence>
                                        { group.map( item => (
                                            <ItemCard
                                                key={ item.id }
                                                item={ item }
                                                showImage={ attrs.showImage }
                                                showDescription={ attrs.showDescription }
                                                showType={ attrs.showType }
                                                showAuthor={ attrs.showAuthor }
                                                showReadButton={ attrs.showReadButton }
                                                showInfoButton={ attrs.showInfoButton }
                                                showTranslator={ attrs.showTranslator }
                                                showPublisher={ attrs.showPublisher }
                                                showYear={ attrs.showYear }
                                                showLanguage={ attrs.showLanguage }
                                                showPageCount={ showPageCount }
                                                imageSize={ attrs.imageSize }
                                                imageFit={ attrs.imageFit }
                                                cardRadius={ attrs.cardRadius }
                                                cardBorder={ attrs.cardBorder }
                                                cardShadow={ attrs.cardShadow }
                                                cardHover={ attrs.cardHover }
                                                cardAlign={ attrs.cardAlign }
                                                cardLayout={ attrs.cardLayout }
                                                compact
                                            />
                                        ) ) }
                                    </AnimatePresence>
                                </div>
                            </div>
                        ) )
                    }
                </div>

                { attrs.showArrows && loaded && (
                    <SliderArrow
                        direction="right"
                        onClick={ () => instanceRef.current?.next() }
                        disabled={ ! isLooped && currentSlide >= slides.length - effectivePerView }
                    />
                ) }
            </div>

            { attrs.showDots && loaded && totalDots > 1 && (
                <div className="px-6">
                    <SliderDots
                        count={ totalDots }
                        current={ currentDot }
                        onDotClick={ ( i ) => instanceRef.current?.moveToIdx( i * ( rows === 1 ? effectivePerView : 1 ) ) }
                    />
                </div>
            ) }
        </div>
    );
};

/* ------------------------------------------------------------------ */
/*  Exported wrapper                                                   */
/* ------------------------------------------------------------------ */

const qc = new QueryClient( { defaultOptions: { queries: { staleTime: 1000 * 60 * 3, retry: 1 } } } );

const DisplaySlider: React.FC<SliderAttrs> = ( attrs ) => (
    <QueryClientProvider client={ qc }>
        <I18nProvider>
            <DisplaySliderInner { ...attrs } />
        </I18nProvider>
    </QueryClientProvider>
);

export default DisplaySlider;
