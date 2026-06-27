// Continuo-local 微调:加 draggable + onDragStart / onDragEnd props 支撑 terminal
// tab 拖拽分屏(topic-05)。Nous 上游保持纯展示 tab(无 DnD),Continuo 在 terminal
// panel 内嵌 tab 上启用。drag handler 挂在 wrap div(根)而非 select button,避免
// button click/drag 互相干扰。
import './TabNav.css';
import { useId } from 'react';
import type { DragEvent, KeyboardEvent, MouseEvent, ReactNode } from 'react';
import { handleTablistArrowKeys } from './roving-tablist';

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
  /**
   * a11y(A107):role="tablist" 的可访问名。Caller 传本地化组名(如「编辑器标签」),否则 AT
   * 进入 tablist 只听到泛化"tab list"。design 层无 i18n,文本由调用点注入。Defaults to none.
   */
  readonly ariaLabel?: string;
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
  /**
   * a11y(A35):localized text for the unsaved/dirty state (e.g. "Unsaved changes"). When provided
   * and `dirty`, it is associated with the tab via `aria-describedby` so AT announces unsaved state
   * (the visual dot alone is `aria-hidden`). Caller supplies the i18n text (design layer has no i18n).
   */
  readonly dirtyLabel?: string;
  /**
   * a11y(A106):icon-only 关闭按钮的可访问名。Caller 传本地化文本(含 title),design 层无 i18n
   * 依赖;未提供时回退英文默认 `Close {title}` / `Close tab`(同 dirtyLabel 模式)。
   */
  readonly closeLabel?: string;
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

export function TabNav({ children, className, ariaLabel }: TabNavProps) {
  // Continuo-local 微调(a11y A23/A28):role="tablist" 须配 WAI-ARIA 键盘模型 —— 方向键在 tab
  // 间移动焦点(配合 TabNavItem 的 roving tabindex:仅 active tab 在 Tab 顺序内)。手动激活:
  // 方向键只移焦点,Enter/Space 由原生 button 触发 onSelect。逻辑抽到共享 roving-tablist.ts
  // (与 design Tabs 单一来源)。Nous 上游纯展示 tab 无此模型,通用增强应推回。
  return (
    <nav
      className={`wm-tab-nav${className != null ? ` ${className}` : ''}`}
      role="tablist"
      // a11y(A107):caller 注入的本地化组名(design 层无 i18n)。
      aria-label={ariaLabel}
      onKeyDown={handleTablistArrowKeys}
    >
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
  dirtyLabel,
  closeLabel: closeLabelProp,
  draggable = false,
  onDragStart,
  onDragEnd,
  dataAttrs,
  children,
}: TabNavItemProps) {
  // a11y(A106):优先用 caller 注入的本地化 closeLabel;未提供回退英文默认(design 层无 i18n)。
  const closeLabel =
    closeLabelProp != null && closeLabelProp.length > 0
      ? closeLabelProp
      : title != null && title.length > 0
        ? `Close ${title}`
        : 'Close tab';
  const dirtyDescId = useId();
  const showDirtyDesc = dirty && dirtyLabel != null && dirtyLabel.length > 0;

  const handleClose = (event: MouseEvent<HTMLButtonElement>) => {
    event.stopPropagation();
    onClose?.();
  };

  // a11y(A29):close 按钮被移出 Tab 顺序(见下 tabIndex=-1),改由 tab 聚焦时 Delete/Backspace
  // 触发关闭,保持「一次 Tab 进出 tablist、方向键在 tab 间移动」的键盘模型不被额外 tab stop 破坏。
  const handleSelectKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (
      onClose != null &&
      !disabled &&
      (event.key === 'Delete' || event.key === 'Backspace')
    ) {
      event.preventDefault();
      onClose();
    }
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
      {...dataAttrs}
    >
      <button
        type="button"
        role="tab"
        className="wm-tab-nav-item__select"
        aria-selected={active}
        // a11y(A23):roving tabindex —— 仅 active tab 在 Tab 顺序内(0),其余 -1,由 tablist
        // 方向键导航;键盘用户一次 Tab 进/出整个 tablist,不再逐个穿过所有 tab。
        tabIndex={active ? 0 : -1}
        disabled={disabled}
        // a11y(A35):dirty 且调用方提供 dirtyLabel 时,经 aria-describedby 关联未保存状态文本。
        aria-describedby={showDirtyDesc ? dirtyDescId : undefined}
        onClick={onSelect}
        onDoubleClick={onRename}
        onKeyDown={handleSelectKeyDown}
      >
        <span className="wm-tab-nav-item__label">{children}</span>
      </button>
      {dirty ? (
        <span
          className="wm-tab-nav-item__dirty-dot"
          // 视觉圆点对 AT 隐藏;未保存状态改由 aria-describedby 指向的本地化文本承载(若提供)。
          id={showDirtyDesc ? dirtyDescId : undefined}
          aria-label={showDirtyDesc ? dirtyLabel : undefined}
          aria-hidden={showDirtyDesc ? undefined : true}
        />
      ) : null}
      {onClose != null ? (
        <button
          type="button"
          className="wm-tab-nav-item__close"
          aria-label={closeLabel}
          disabled={disabled}
          // a11y(A29):移出 Tab 顺序,避免 tablist 内混入非 tab 的额外 tab stop(鼠标仍可点;
          // 键盘经聚焦 tab 后 Delete/Backspace 关闭)。
          tabIndex={-1}
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
