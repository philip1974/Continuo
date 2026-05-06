import './TabNav.css';
import type { MouseEvent, ReactNode } from 'react';

/**
 * Props for a horizontal IDE-style tab strip.
 *
 * Use for editor or terminal tabs such as:
 * `<TabNav><TabNavItem active onSelect={selectTab}>README.md</TabNavItem></TabNav>`.
 */
export interface TabNavProps {
  /** Ordered `TabNavItem` children. No default. */
  readonly children: ReactNode;
  /** Optional host class for layout integration. Defaults to no extra class. */
  readonly className?: string;
}

/**
 * Props for one IDE-style horizontal tab.
 *
 * `onClose` adds a compact close affordance:
 * `<TabNavItem title="README.md" dirty onSelect={select} onClose={close}>README.md</TabNavItem>`.
 */
export interface TabNavItemProps {
  /** Marks the selected tab and shows the primary bottom border. Defaults to `false`. */
  readonly active?: boolean;
  /** Shows a primary dirty indicator dot. Defaults to `false`. */
  readonly dirty?: boolean;
  /** Applies a dimmed treatment for inactive or exited tabs. Defaults to `false`. */
  readonly muted?: boolean;
  /** Prevents selecting or closing this tab. Defaults to `false`. */
  readonly disabled?: boolean;
  /** Tooltip and close-button accessible suffix. Defaults to no tooltip. */
  readonly title?: string;
  /** Called when the tab body is selected. No default. */
  readonly onSelect: () => void;
  /** Called by the optional close affordance. Defaults to no close button. */
  readonly onClose?: () => void;
  /** Tab label or composed tab content. No default. */
  readonly children: ReactNode;
}

export function TabNav({ children, className }: TabNavProps) {
  return (
    <nav className={`wm-tab-nav${className != null ? ` ${className}` : ''}`} role="tablist">
      {children}
    </nav>
  );
}

export function TabNavItem({
  active = false,
  dirty = false,
  muted = false,
  disabled = false,
  title,
  onSelect,
  onClose,
  children,
}: TabNavItemProps) {
  const closeLabel = title != null && title.length > 0 ? `Close ${title}` : 'Close tab';

  const handleClose = (event: MouseEvent<HTMLButtonElement>) => {
    event.stopPropagation();
    onClose?.();
  };

  return (
    <div
      className="wm-tab-nav-item"
      data-active={active}
      data-dirty={dirty}
      data-muted={muted}
      data-disabled={disabled}
      role="presentation"
      title={title}
    >
      <button
        type="button"
        role="tab"
        className="wm-tab-nav-item__select"
        aria-selected={active}
        disabled={disabled}
        onClick={onSelect}
      >
        <span className="wm-tab-nav-item__label">{children}</span>
      </button>
      {dirty ? <span className="wm-tab-nav-item__dirty-dot" aria-hidden="true" /> : null}
      {onClose != null ? (
        <button
          type="button"
          className="wm-tab-nav-item__close"
          aria-label={closeLabel}
          disabled={disabled}
          onClick={handleClose}
        >
          {/* Continuo-local 微调:'x' → '✕'(U+2715 multiplication X)与
           *  EditorHeader 单 tab close button 一致,视觉更对称。Nous 上游保持 'x'. */}
          <span aria-hidden="true">✕</span>
        </button>
      ) : null}
    </div>
  );
}
