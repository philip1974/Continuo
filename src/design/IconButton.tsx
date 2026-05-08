// LM-local 微调:加 forwardRef,让 HeaderActions 的弹层锚点等需要
// .getBoundingClientRect() / .focus() 的场景能直接拿到 inner <button>。
// Nous 上游目前是普通函数组件,后续可推回(待协调)。

import './IconButton.css';
import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react';

export type IconButtonSize = 'xs' | 'sm' | 'md';

/**
 * Props for a square ghost icon button.
 *
 * Use for compact tool actions such as `<IconButton title="Close">x</IconButton>`.
 * `size` defaults to `sm`, and `type` defaults to `button`.
 */
export interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  /** Square size preset. Defaults to `sm` (24px). */
  readonly size?: IconButtonSize;
  /** Single icon node, SVG, or glyph rendered in the center. */
  readonly children: ReactNode;
}

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(
  function IconButton({ size = 'sm', className, children, ...rest }, ref) {
    return (
      <button
        type="button"
        {...rest}
        ref={ref}
        className={`wm-icon-button${className != null ? ` ${className}` : ''}`}
        data-size={size}
      >
        {children}
      </button>
    );
  },
);
