import './MenuItem.css';
import type { ReactNode } from 'react';

export type MenuItemVariant = 'default' | 'danger';

/**
 * Props for a full-width menu or command-list item.
 *
 * Use inside a menu container such as:
 * `<div role="menu"><MenuItem onClick={openRecent} title={path}>{label}</MenuItem></div>`.
 */
export interface MenuItemProps {
  /** Visual intent for hover and text treatment. Defaults to `default`. */
  readonly variant?: MenuItemVariant;
  /** Prevents interaction and dims the row. Defaults to `false`. */
  readonly disabled?: boolean;
  /** Called when the row is clicked. No default. */
  readonly onClick: () => void;
  /** Tooltip text for full paths or truncated labels. Defaults to no tooltip. */
  readonly title?: string;
  /** Row label or composed menu content. No default. */
  readonly children: ReactNode;
}

export function MenuItem({
  variant = 'default',
  disabled = false,
  onClick,
  title,
  children,
}: MenuItemProps) {
  return (
    <button
      type="button"
      role="menuitem"
      className="wm-menu-item"
      data-variant={variant}
      disabled={disabled}
      title={title}
      onClick={onClick}
    >
      <span className="wm-menu-item__content">{children}</span>
    </button>
  );
}
