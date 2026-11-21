import './NavRailButton.css';
import type { ReactNode } from 'react';

/**
 * Props for a square vertical nav rail icon button.
 *
 * Use in 48px activity bars such as:
 * `<NavRailButton title="Explorer" active onClick={openExplorer}><FilesIcon /></NavRailButton>`.
 */
export interface NavRailButtonProps {
  /**
   * Toggle/destination state. When provided, the button exposes `aria-pressed` and shows the
   * accent bar while active. **Omit for non-toggle action buttons** (ribbon/command) so they are
   * announced as plain buttons, not "unpressed toggle buttons". No default (undefined = not a toggle).
   */
  readonly active?: boolean;
  /** Prevents interaction and dims the icon. Defaults to `false`. */
  readonly disabled?: boolean;
  /** Tooltip text and accessible name. No default. */
  readonly title: string;
  /** Called when the rail item is clicked. No default. */
  readonly onClick: () => void;
  /**
   * a11y(A34):id of an element that supplements the button's description (e.g. an update-count
   * badge), wired via `aria-describedby` so AT reads it when the button is focused. Optional.
   */
  readonly describedById?: string;
  /** Icon node rendered at the center of the square button. No default. */
  readonly children: ReactNode;
}

export function NavRailButton({
  active,
  disabled = false,
  title,
  onClick,
  describedById,
  children,
}: NavRailButtonProps) {
  return (
    <button
      type="button"
      className="wm-nav-rail-button"
      data-active={active ?? false}
      // a11y(A32):只有调用点明确传 active(真实 toggle/destination)才暴露 aria-pressed;
      // 非 toggle 的 ribbon/命令按钮不传 → 不渲染 aria-pressed,避免被 AT 读成「未按下的切换按钮」。
      aria-pressed={active === undefined ? undefined : active}
      aria-label={title}
      aria-describedby={describedById}
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
