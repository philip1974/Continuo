import './NavRailButton.css';
import type { ReactNode } from 'react';

/**
 * Props for a square vertical nav rail icon button.
 *
 * Use in 48px activity bars such as:
 * `<NavRailButton title="Explorer" active onClick={openExplorer}><FilesIcon /></NavRailButton>`.
 */
export interface NavRailButtonProps {
  /** Marks the current rail destination and shows the primary accent bar. Defaults to `false`. */
  readonly active?: boolean;
  /** Prevents interaction and dims the icon. Defaults to `false`. */
  readonly disabled?: boolean;
  /** Tooltip text and accessible name. No default. */
  readonly title: string;
  /** Called when the rail item is clicked. No default. */
  readonly onClick: () => void;
  /** Icon node rendered at the center of the square button. No default. */
  readonly children: ReactNode;
}

export function NavRailButton({
  active = false,
  disabled = false,
  title,
  onClick,
  children,
}: NavRailButtonProps) {
  return (
    <button
      type="button"
      className="wm-nav-rail-button"
      data-active={active}
      aria-pressed={active}
      aria-label={title}
      title={title}
      disabled={disabled}
      onClick={onClick}
    >
      {active ? <span className="wm-nav-rail-button__active-bar" aria-hidden="true" /> : null}
      <span className="wm-nav-rail-button__icon" aria-hidden="true">
        {children}
      </span>
    </button>
  );
}
