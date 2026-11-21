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
  /**
   * Continuo-local 微调:可访问名注入。当可见 children 是截断/不唯一文本(如同名目录的
   * basename)时,调用点传完整/可区分的本地化文本作 aria-label(设计层不引 i18n,文本由
   * 调用点注入)。Nous 上游 MenuItem 暂无此 prop。Defaults to no aria-label。
   */
  readonly ariaLabel?: string;
  /** Row label or composed menu content. No default. */
  readonly children: ReactNode;
}

export function MenuItem({
  variant = 'default',
  disabled = false,
  onClick,
  title,
  ariaLabel,
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
      aria-label={ariaLabel}
      // a11y(A31,A29 同族):role="menuitem" 须移出普通 Tab 顺序(menu composite 契约:Tab
      // 进/出整个菜单、方向键在项间移动)。焦点由 useMenuKeyboard 程序管理(initial focus +
      // Arrow/Home/End);tabIndex=-1 不影响 .focus() 编程聚焦。
      tabIndex={-1}
      onClick={onClick}
    >
      <span className="wm-menu-item__content">{children}</span>
    </button>
  );
}
