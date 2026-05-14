// Continuo-local 微调:加 draggable + onDragStart / onDragEnd props 支撑 terminal
// tab 拖拽分屏(topic-05)。Nous 上游保持纯展示 tab(无 DnD),Continuo 在 terminal
// panel 内嵌 tab 上启用。drag handler 挂在 wrap div(根)而非 select button,避免
// button click/drag 互相干扰。
import './TabNav.css';
import type { DragEvent, MouseEvent, ReactNode } from 'react';

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
  /**
   * Called on double-click on the tab body. Opt-in rename affordance —
   * callers compose their own inline-edit UI in `children` when active.
   * No default; if omitted, double-click is treated as a regular click.
   */
  readonly onRename?: () => void;
  /** Continuo-local(topic-05): 允许该 tab 被拖出。Defaults to `false`. */
  readonly draggable?: boolean;
  /** Continuo-local(topic-05): 拖拽开始时调用,callers 在此 setData(MIME). */
  readonly onDragStart?: (event: DragEvent<HTMLDivElement>) => void;
  readonly onDragEnd?: (event: DragEvent<HTMLDivElement>) => void;
  /** Continuo-local(topic-05): 透传到根 div 的 data-* 属性(BDD 断言/a11y). */
  readonly dataAttrs?: Record<string, string>;
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
  onRename,
  draggable = false,
  onDragStart,
  onDragEnd,
  dataAttrs,
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
      draggable={draggable}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      {...(dataAttrs ?? {})}
    >
      <button
        type="button"
        role="tab"
        className="wm-tab-nav-item__select"
        aria-selected={active}
        disabled={disabled}
        onClick={onSelect}
        onDoubleClick={onRename}
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
