import './ScrollArea.css';
import { forwardRef, type HTMLAttributes } from 'react';

/**
 * Props for a flexible scroll container.
 *
 * Use around overflowing content such as `<ScrollArea style={{ maxHeight: 240 }}>...</ScrollArea>`.
 * No custom defaults are applied beyond the `wm-scroll-area` class.
 */
export interface ScrollAreaProps extends HTMLAttributes<HTMLDivElement> {}

export const ScrollArea = forwardRef<HTMLDivElement, ScrollAreaProps>(
  function ScrollArea({ className, children, ...rest }, ref) {
    return (
      <div ref={ref} {...rest} className={`wm-scroll-area${className != null ? ` ${className}` : ''}`}>
        {children}
      </div>
    );
  },
);
