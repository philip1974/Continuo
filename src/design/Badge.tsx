import './Badge.css';
import type { HTMLAttributes } from 'react';

export type BadgeVariant =
  | 'neutral' | 'success' | 'warning' | 'danger' | 'info'
  | 'success-soft' | 'warning-soft' | 'danger-soft';

/**
 * Props for a compact semantic status label.
 *
 * Use for short state text such as `<Badge variant="success">Synced</Badge>`.
 * `variant` defaults to `neutral`; all native `span` attributes are forwarded.
 */
export interface BadgeProps extends HTMLAttributes<HTMLSpanElement> {
  /** Semantic color treatment. Defaults to `neutral`. */
  readonly variant?: BadgeVariant;
}

export function Badge({ variant = 'neutral', className, children, ...rest }: BadgeProps) {
  return (
    <span
      {...rest}
      className={`wm-badge${className != null ? ` ${className}` : ''}`}
      data-variant={variant}
    >
      {children}
    </span>
  );
}
