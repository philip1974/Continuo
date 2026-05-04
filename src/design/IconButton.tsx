import './IconButton.css';
import type { ButtonHTMLAttributes, ReactNode } from 'react';

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
