import './Input.css';
import type { InputHTMLAttributes } from 'react';

export type InputVariant = 'default' | 'mono' | 'dark';

/**
 * Props for a single-line text input.
 *
 * Use for forms such as `<Input placeholder="Filter sessions" />`.
 * `variant` defaults to `default`; all native `input` attributes are forwarded.
 */
export interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  /** Typography and surface preset. Defaults to `default`. */
  readonly variant?: InputVariant;
}

export function Input({ variant = 'default', className, ...rest }: InputProps) {
  return (
    <input
      {...rest}
      className={`wm-input${className != null ? ` ${className}` : ''}`}
      data-variant={variant}
    />
  );
}
