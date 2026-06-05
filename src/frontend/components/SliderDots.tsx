import React from 'react';

interface SliderDotsProps {
    count: number;
    current: number;
    onDotClick: ( index: number ) => void;
}

const SliderDots: React.FC<SliderDotsProps> = ( { count, current, onDotClick } ) => {
    if ( count <= 1 ) return null;

    return (
        <div className="jr-slider-progress flex items-stretch mt-3 gap-px" role="tablist" aria-label="Slides">
            { Array.from( { length: count } ).map( ( _, i ) => (
                <button
                    key={ i }
                    role="tab"
                    aria-selected={ i === current }
                    aria-label={ `Slide ${ i + 1 }` }
                    onClick={ () => onDotClick( i ) }
                    className="jr-slider-bar flex-1 h-[3px] relative overflow-hidden cursor-pointer focus-visible:outline-none"
                >
                    {/* Background track */}
                    <span className="absolute inset-0 bg-gray-200 dark:bg-gray-700" />
                    {/* Active fill */}
                    { i === current && (
                        <span className="absolute inset-0 bg-primary-600 transition-all duration-300" />
                    ) }
                </button>
            ) ) }
        </div>
    );
};

export default SliderDots;
