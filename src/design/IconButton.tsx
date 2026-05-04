// LM-local design 扩展:正方形 icon-only 按钮(Nous shell-ui 暂无对应组件,
// 后续通用化后可推回上游)。
// 用于 panel header / tab 内联 icon / 工具栏小图标等场景。
// 与 Button 区别:无内边距(只靠 width/height)、无圆角差异、ghost only。

import './IconButton.css';
import type { ButtonHTMLAttributes, ReactNode } from 'react';

export type IconButtonSize = 'xs' | 'sm' | 'md';

/**
 * Props for a square ghost icon button.
 *
 * Use for compact tool/action buttons such as
 * `<IconButton size="sm" title="关闭"><CloseIcon /></IconButton>`.
 * `size` defaults to `sm`. The `title` doubles as tooltip.
 */
export interface IconButtonProps
  extends ButtonHTMLAttributes<HTMLButtonElement> {
  /** Square size preset. Defaults to `sm` (24px). */
  readonly size?: IconButtonSize;
  /** Single icon node (svg / glyph / character). */
  readonly children: ReactNode;
}

export function IconButton({
  size = 'sm',
  className,
  children,
  ...rest
}: IconButtonProps) {
  return (
    <button
      type="button"
      {...rest}
      className={`wm-icon-button${className != null ? ` ${className}` : ''}`}
      data-size={size}
    >
      {children}
    </button>
  );
}
