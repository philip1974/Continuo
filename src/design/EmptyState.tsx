import type { HTMLAttributes } from 'react';

/**
 * Props for the placeholder shown when a panel or section has no content.
 *
 * Use as `<EmptyState>No debug session</EmptyState>`; it fills the available space and centers its content.
 * All native `div` attributes (e.g. `role="status"`) are forwarded.
 */
export type EmptyStateProps = HTMLAttributes<HTMLDivElement>;

export function EmptyState({ className, children, ...rest }: EmptyStateProps) {
  return (
    <div {...rest} className={`wm-empty-state${className != null ? ` ${className}` : ''}`}>
      {children}
    </div>
  );
}
