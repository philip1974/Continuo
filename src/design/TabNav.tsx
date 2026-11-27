// Continuo-local 微调:加 draggable + onDragStart / onDragEnd props 支撑 terminal
// tab 拖拽分屏(topic-05),在 terminal panel 内嵌 tab 上启用。drag handler 挂在根 div(即 role=tab 元素)上。
import { useId } from 'react';
import type { DragEvent, KeyboardEvent, MouseEvent, ReactNode } from 'react';
import { handleTablistArrowKeys } from './roving-tablist';

/** pointerdown / mousedown 的默认动作是把焦点移到被按下的元素(或其可聚焦祖先 tab)上;关闭按钮不需要焦点(键盘走 tab 上的 Delete)。 */
function preventFocusSteal(event: { preventDefault: () => void }): void {
  event.preventDefault();
}

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
  /**
   * The strip belongs to a pane that is not the active one (e.g. an inactive editor group): the active tab keeps its
   * selected background but drops the accent underline and uses muted text (VSCode `tab.unfocusedActive*`). Defaults to `false`.
   */
  readonly unfocused?: boolean;
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
  /** Called when the tab body is selected (mouse or keyboard). No default. */
  readonly onSelect: () => void;
  /**
   * Called after `onSelect` only when the tab was selected by a **mouse** click (not by Enter / Space, whose
   * synthesized click has `detail === 0`). Callers use it to move focus back into the tab's content
   * (VSCode: clicking an editor tab focuses that editor) so typing — e.g. Backspace — never lands on the
   * tab. Keyboard selection keeps focus on the tab (tablist model). Defaults to none.
   */
  readonly onMouseSelect?: () => void;
  /**
   * Called by the optional close affordance, by a middle-click on the tab, and by Delete on the focused tab
   * (Backspace is deliberately ignored so a stray backspace never closes a tab). Defaults to no close button
   * (and no middle-click close).
   */
  readonly onClose?: () => void;
  /**
   * Called on double-click on the tab body. Opt-in rename affordance —
   * callers compose their own inline-edit UI in `children` when active.
   * No default; if omitted, double-click is treated as a regular click.
   */
  readonly onRename?: () => void;
  /**
   * Called on double-click on the tab body when `onRename` is not given (e.g. editor tabs: keep a preview
   * editor open). No default; if omitted, double-click is treated as a regular click.
   */
  readonly onDoubleClick?: () => void;
  /** Continuo-local(topic-05): 允许该 tab 被拖出。Defaults to `false`. */
  readonly draggable?: boolean;
  /** Continuo-local(topic-05): 拖拽开始时调用,callers 在此 setData(MIME). */
  readonly onDragStart?: (event: DragEvent<HTMLDivElement>) => void;
  readonly onDragEnd?: (event: DragEvent<HTMLDivElement>) => void;
  /** Continuo-local(topic-05): 透传到根 div 的 data-* 属性(BDD 断言/a11y). */
  readonly dataAttrs?: Record<string, string>;
  /**
   * Accessible name of the tab, replacing the name taken from `children` (e.g. VSCode computeEditorAriaLabel, which
   * appends `, preview` for a preview editor). Caller supplies the localized text (design layer has no i18n).
   * Defaults to the label content.
   */
  readonly ariaLabel?: string;
  /**
   * Decoration shown after the label (e.g. a git status letter). Unlike `children` it never truncates: when the
   * label is too long the label is ellipsized and this stays visible (VSCode tab decoration badges). Not part of the
   * tab's accessible name. Defaults to none.
   */
  readonly trailing?: ReactNode;
  /** Tab label or composed tab content. No default. */
  readonly children: ReactNode;
}

export function TabNav({ children, className, ariaLabel, unfocused = false }: TabNavProps) {
  // Continuo-local 微调(a11y A23/A28):role="tablist" 须配 WAI-ARIA 键盘模型 —— 方向键在 tab
  // 间移动焦点(配合 TabNavItem 的 roving tabindex:仅 active tab 在 Tab 顺序内)。手动激活:
  // 方向键只移焦点,Enter/Space 由 TabNavItem 触发 onSelect。逻辑抽到共享 roving-tablist.ts
  // (与 design Tabs 单一来源)。
  return (
    <nav
      className={`wm-tab-nav${className != null ? ` ${className}` : ''}`}
      role="tablist"
      // a11y(A107):caller 注入的本地化组名(design 层无 i18n)。
      aria-label={ariaLabel}
      data-unfocused={unfocused ? 'true' : undefined}
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
  onMouseSelect,
  onClose,
  onRename,
  onDoubleClick,
  dirtyLabel,
  closeLabel: closeLabelProp,
  draggable = false,
  onDragStart,
  onDragEnd,
  dataAttrs,
  ariaLabel,
  trailing,
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
  const labelId = useId();
  const hasAriaLabel = ariaLabel != null && ariaLabel.length > 0;
  const showDirtyDesc = dirty && dirtyLabel != null && dirtyLabel.length > 0;
  const closable = onClose != null && !disabled;

  const handleClose = (event: MouseEvent<HTMLSpanElement>) => {
    event.stopPropagation();
    if (closable) onClose();
  };

  // tab 元素自身承担按钮语义(不再是原生 button):Enter / Space 选中(焦点留在 tab,不回调 onMouseSelect);
  // a11y(A29):Delete 关闭(关闭控件不在 Tab 顺序)。不认 Backspace:焦点停在 tab 上时用户常以为还在编辑器里打字,
  // 退格即误关 tab(同 dock tab SharedTab;VSCode tab 上也无退格关闭)。只处理 tab 自身的按键:children 里的
  // 控件(如调用方组合的重命名输入框)冒泡上来的空格 / Delete 不截走。
  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.target !== event.currentTarget || disabled) return;
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      onSelect();
    } else if (event.key === 'Delete' && closable) {
      event.preventDefault();
      onClose();
    }
  };

  // 鼠标点击(主键)选中并回调 onMouseSelect(调用方把焦点交回内容,VSCode:点编辑器 tab 即聚焦编辑器)。
  const handleClick = (event: MouseEvent<HTMLDivElement>) => {
    if (disabled) return;
    onSelect();
    if (event.detail !== 0 && event.button === 0) onMouseSelect?.();
  };
  // 中键单击关闭(VSCode / 浏览器 tab 惯例;与 dock tab SharedTab 一致)。走同一个 onClose —— 未保存 tab 的
  // 确认流程由调用方的 onClose 负责,中键与点 × 等价。按下时 preventDefault 阻止中键默认的自动滚动(auto-scroll)。
  const handleMouseDown = (event: MouseEvent<HTMLDivElement>) => {
    if (event.button === 1 && closable) event.preventDefault();
  };
  const handleAuxClick = (event: MouseEvent<HTMLDivElement>) => {
    if (event.button !== 1 || !closable) return;
    event.preventDefault();
    event.stopPropagation();
    onClose();
  };

  // a11y(axe aria-required-children / nested-interactive):tablist 的子元素只能是 tab,故 tab 元素就是这个根 div
  // (VSCode multiEditorTabsControl 同:div[role=tab] 内含标题与关闭动作)。tab 的子元素按 ARIA 是 presentational,
  // 不能再有可聚焦控件 → 关闭用不可聚焦的 span[role=button](鼠标点击;键盘 / 读屏走 tab 上的 Delete 或 ⌘W)。
  // 名称经 aria-labelledby 只取标题,不混入关闭按钮的名称。
  return (
    <div
      className="wm-tab-nav-item"
      role="tab"
      aria-selected={active}
      aria-disabled={disabled || undefined}
      aria-label={hasAriaLabel ? ariaLabel : undefined}
      aria-labelledby={hasAriaLabel ? undefined : labelId}
      // a11y(A35):dirty 且调用方提供 dirtyLabel 时,经 aria-describedby 关联未保存状态文本。
      aria-describedby={showDirtyDesc ? dirtyDescId : undefined}
      // a11y(A23):roving tabindex —— 仅 active tab 在 Tab 顺序内(0),其余 -1,由 tablist
      // 方向键导航;键盘用户一次 Tab 进/出整个 tablist,不再逐个穿过所有 tab。
      tabIndex={active ? 0 : -1}
      data-active={active}
      data-dirty={dirty}
      data-muted={muted}
      data-disabled={disabled}
      title={title}
      draggable={draggable}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onClick={handleClick}
      onDoubleClick={disabled ? undefined : (onRename ?? onDoubleClick)}
      onKeyDown={handleKeyDown}
      onMouseDown={handleMouseDown}
      onAuxClick={handleAuxClick}
      {...dataAttrs}
    >
      <span className="wm-tab-nav-item__select">
        <span className="wm-tab-nav-item__label" id={labelId}>
          {children}
        </span>
        {trailing != null ? <span className="wm-tab-nav-item__trailing">{trailing}</span> : null}
      </span>
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
        // 不用 design Button / 原生 button:tab 内不能有可聚焦控件(见上);只作鼠标点击目标。
        <span
          role="button"
          className="wm-tab-nav-item__close"
          aria-label={closeLabel}
          aria-disabled={disabled || undefined}
          // 按下不抢焦点:点背景 tab 的 × 时焦点留在原处(如活动编辑器),不落到所在的 tab 上(VSCode 同)。
          onPointerDown={preventFocusSteal}
          onMouseDown={preventFocusSteal}
          onClick={handleClose}
        >
          {/* Continuo-local 微调:'x' → '✕'(U+2715 multiplication X)视觉更对称。 */}
          <span aria-hidden="true">✕</span>
        </span>
      ) : null}
    </div>
  );
}
