import type { ButtonHTMLAttributes, ReactNode, Ref } from 'react';

export type MenuItemVariant = 'default' | 'danger';

/**
 * Props for a full-width menu or command-list item.
 *
 * Use inside a menu container such as:
 * `<div role="menu"><MenuItem onClick={openRecent} title={path}>{label}</MenuItem></div>`.
 *
 * Also works as the `asChild` child of a menu primitive (e.g. Radix `ContextMenu.Item`): `ref` and the remaining
 * button attributes (data-highlighted, key / pointer handlers, aria-*) are forwarded to the underlying button.
 */
export interface MenuItemProps
  extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'type' | 'role' | 'className' | 'children'> {
  /** Visual intent for hover and text treatment. Defaults to `default`. */
  readonly variant?: MenuItemVariant;
  /** Prevents interaction and dims the row. Defaults to `false`. */
  readonly disabled?: boolean;
  /** Called when the row is clicked. Optional when a menu primitive injects its own handler. */
  readonly onClick?: ButtonHTMLAttributes<HTMLButtonElement>['onClick'];
  /** Tooltip text for full paths or truncated labels. Defaults to no tooltip. */
  readonly title?: string;
  /**
   * Continuo-local 微调:可访问名注入。当可见 children 是截断/不唯一文本(如同名目录的
   * basename)时,调用点传完整/可区分的本地化文本作 aria-label(设计层不引 i18n,文本由
   * 调用点注入)。Defaults to no aria-label。
   */
  readonly ariaLabel?: string;
  /** Right-aligned secondary content such as a shortcut (`F2`) or a count; kept outside the truncated label. */
  readonly trailing?: ReactNode;
  /** Forwarded to the underlying button (React 19 ref-as-prop). */
  readonly ref?: Ref<HTMLButtonElement>;
  /** Row label or composed menu content. No default. */
  readonly children: ReactNode;
}

export function MenuItem({
  variant = 'default',
  disabled = false,
  onClick,
  title,
  ariaLabel,
  trailing,
  ref,
  children,
  ...rest
}: MenuItemProps) {
  return (
    <button
      // a11y(A31,A29 同族):role="menuitem" 须移出普通 Tab 顺序(menu composite 契约:Tab
      // 进/出整个菜单、方向键在项间移动)。焦点由 useMenuKeyboard / 菜单原语程序管理(initial focus +
      // Arrow/Home/End);tabIndex=-1 不影响 .focus() 编程聚焦。置于 rest 前,菜单原语可覆盖。
      tabIndex={-1}
      aria-label={ariaLabel}
      {...rest}
      ref={ref}
      type="button"
      role="menuitem"
      className="wm-menu-item"
      data-variant={variant}
      disabled={disabled}
      title={title}
      onClick={onClick}
    >
      <span className="wm-menu-item__content">{children}</span>
      {trailing != null && <span className="wm-menu-item__trailing">{trailing}</span>}
    </button>
  );
}
