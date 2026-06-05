import React from 'react';
import { useTranslation } from '../../i18n/I18nContext';

interface SliderArrowProps {
    direction: 'left' | 'right';
    onClick: () => void;
    disabled?: boolean;
}

const SliderArrow: React.FC<SliderArrowProps> = ( { direction, onClick, disabled = false } ) => {
    const { direction: uiDirection } = useTranslation();
    const isRtl = uiDirection === 'rtl';

    // In RTL, we swap the physical positioning:
    // - Logical Prev ('left') arrow is physical left in LTR, physical right in RTL.
    // - Logical Next ('right') arrow is physical right in LTR, physical left in RTL.
    const isPhysicalLeft = ( direction === 'left' && ! isRtl ) || ( direction === 'right' && isRtl );
    const positionClass = isPhysicalLeft ? '-left-5' : '-right-5';

    // Chevron direction points left (<) for physical left button, points right (>) for physical right button.
    const pointsLeft = isPhysicalLeft;

    return (
        <button
            onClick={ onClick }
            disabled={ disabled }
            aria-label={ direction === 'left' ? 'Previous' : 'Next' }
            className={ `
                jr-slider-arrow
                absolute top-1/2 -translate-y-1/2 z-10
                ${ positionClass }
                w-10 h-10 flex items-center justify-center
                rounded-full
                bg-white/95 dark:bg-gray-900/95
                backdrop-blur-sm
                shadow-md border border-gray-200/80 dark:border-gray-700/80
                text-gray-600 dark:text-gray-300
                hover:bg-primary-600 hover:border-primary-600 hover:text-white hover:shadow-xl hover:scale-110
                disabled:opacity-0 disabled:pointer-events-none
                transition-all duration-200 ease-out
                focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 focus-visible:ring-offset-2
            ` }
        >
            { pointsLeft ? (
                <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none"
                    stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"
                    className="w-4 h-4">
                    <polyline points="15 18 9 12 15 6" />
                </svg>
            ) : (
                <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none"
                    stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"
                    className="w-4 h-4">
                    <polyline points="9 6 15 12 9 18" />
                </svg>
            ) }
        </button>
    );
};

export default SliderArrow;

