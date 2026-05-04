import './Spinner.css';
import type { HTMLAttributes } from 'react';

export type SpinnerSize = 'sm' | 'md' | 'lg';

/**
 * Props for an indeterminate loading spinner.
 *
 * Use inline as `<Spinner size="sm" />` or inside buttons and panels.
 * `size` defaults to `md`; the component sets `role="status"` and `aria-label="Loading"`.
 */
export interface SpinnerProps extends HTMLAttributes<HTMLDivElement> {
  /** Diameter preset. Defaults to `md`. */
  readonly size?: SpinnerSize;
}

export function Spinner({ size = 'md', className, ...rest }: SpinnerProps) {
  return (
    <div
      role="status"
      aria-label="Loading"
      {...rest}
      className={`wm-spinner${className != null ? ` ${className}` : ''}`}
      data-size={size}
    />
  );
}
