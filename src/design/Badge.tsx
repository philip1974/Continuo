import type { HTMLAttributes } from 'react';

export type BadgeVariant =
  | 'neutral' | 'success' | 'warning' | 'danger' | 'info'
  | 'accent-soft' | 'success-soft' | 'warning-soft' | 'danger-soft';

/** `sm` = pill status badge (default); `xs` = compact rectangular tag for ids / units / inline labels. */
export type BadgeSize = 'sm' | 'xs';

/**
 * Props for a compact semantic status label.
 *
 * Use for short state text such as `<Badge variant="success">Synced</Badge>`.
 * `variant` defaults to `neutral`; all native `span` attributes are forwarded.
 */
export interface BadgeProps extends HTMLAttributes<HTMLSpanElement> {
  /** Semantic color treatment. Defaults to `neutral`. */
  readonly variant?: BadgeVariant;
  /** Shape / density preset. Defaults to `sm` (pill). */
  readonly size?: BadgeSize;
}

export function Badge({
  variant = 'neutral',
  size = 'sm',
  className,
  children,
  ...rest
}: BadgeProps) {
  return (
    <span
      {...rest}
      className={`wm-badge${className != null ? ` ${className}` : ''}`}
      data-variant={variant}
      data-size={size}
    >
      {children}
    </span>
  );
}
