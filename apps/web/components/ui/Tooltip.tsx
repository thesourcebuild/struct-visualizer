import React from 'react';

interface TooltipProps {
    content: React.ReactNode;
    placement?: 'top' | 'right' | 'bottom' | 'left';
    children: React.ReactElement<React.HTMLAttributes<HTMLElement>>;
    delay?: number; // ms
    className?: string;
}

export default function Tooltip({
    content,
    placement = 'top',
    children,
    delay = 150,
    className = '',
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

    const placementClasses: Record<string, string> = {
        top: 'bottom-full mb-2 left-1/2 -translate-x-1/2',
        bottom: 'top-full mt-2 left-1/2 -translate-x-1/2',
        left: 'right-full mr-2 top-1/2 -translate-y-1/2',
        right: 'left-full ml-2 top-1/2 -translate-y-1/2',
    };

    return (
        <span
            className="relative inline-block"
            onMouseEnter={show}
            onMouseLeave={hide}
            onFocus={show}
            onBlur={hide}
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
