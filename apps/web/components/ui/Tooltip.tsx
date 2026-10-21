import React from 'react';

interface TooltipProps {
    content: React.ReactNode;
    /**
     * `bottom-start` and `bottom-end` line the tooltip's left or right edge up with the trigger's,
     * for triggers near the left or right of the screen.
     */
    placement?: 'top' | 'right' | 'bottom' | 'left' | 'bottom-start' | 'bottom-end';
    children: React.ReactElement<React.HTMLAttributes<HTMLElement>>;
    delay?: number; // ms
    className?: string;
    /**
     * Position against the nearest positioned ancestor instead of the trigger, so the tooltip can
     * line up with a card's edges rather than a small icon's.
     */
    anchorToParent?: boolean;
}

/**
 * Shows `content` while the trigger is hovered or has keyboard focus, and links the two with
 * aria-describedby. Escape dismisses it, as WCAG 1.4.13 asks of content that appears on hover.
 */
export default function Tooltip({
    content,
    placement = 'top',
    children,
    delay = 150,
    className = '',
    anchorToParent = false,
}: TooltipProps) {
    const [visible, setVisible] = React.useState(false);
    const timeoutRef = React.useRef<number | null>(null);
    const idRef = React.useId();

    const show = () => {
        if (timeoutRef.current) window.clearTimeout(timeoutRef.current);
        timeoutRef.current = window.setTimeout(() => setVisible(true), delay) as unknown as number;
    };

    const hide = () => {
        if (timeoutRef.current) window.clearTimeout(timeoutRef.current);
        setVisible(false);
    };

    React.useEffect(() => {
        return () => {
            if (timeoutRef.current) window.clearTimeout(timeoutRef.current);
        };
    }, []);

    const placementClasses: Record<NonNullable<TooltipProps['placement']>, string> = {
        top: 'bottom-full mb-2 left-1/2 -translate-x-1/2',
        bottom: 'top-full mt-2 left-1/2 -translate-x-1/2',
        left: 'right-full mr-2 top-1/2 -translate-y-1/2',
        right: 'left-full ml-2 top-1/2 -translate-y-1/2',
        'bottom-start': 'top-full mt-2 left-0',
        'bottom-end': 'top-full mt-2 right-0',
    };

    return (
        <span
            className={anchorToParent ? 'inline-block' : 'relative inline-block'}
            onMouseEnter={show}
            onMouseLeave={hide}
            onFocus={show}
            onBlur={hide}
            onKeyDown={(e) => {
                if (e.key === 'Escape') hide();
            }}
        >
            {React.cloneElement(children, { 'aria-describedby': `tooltip-${idRef}` })}

            {visible && (
                <span
                    id={`tooltip-${idRef}`}
                    role="tooltip"
                    className={`pointer-events-none z-50 absolute ${placementClasses[placement]} transform px-3 py-1.5 text-xs rounded-md shadow-lg bg-gray-900 text-white ${className}`}
                >
                    <span className="block">{content}</span>
                </span>
            )}
        </span>
    );
}
