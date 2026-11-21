// LM-local 微调:加 forwardRef,让 CreateInput / FileRow rename 等需要
// .focus() 的场景能直接拿到 inner <input> 节点。Nous 上游目前是普通函数
// 组件,后续可推回(待协调)。

import './Input.css';
import { forwardRef, type InputHTMLAttributes } from 'react';

export type InputVariant = 'default' | 'mono' | 'dark';
export type InputSize = 'xs' | 'sm' | 'md';

/**
 * Props for a single-line text input.
 *
 * Use for forms such as `<Input placeholder="Filter sessions" />`.
 * `variant` defaults to `default`, `size` defaults to `md`,
 * and all native `input` attributes are forwarded.
 */
export interface InputProps
  extends Omit<InputHTMLAttributes<HTMLInputElement>, 'size'> {
  /** Typography and surface preset. Defaults to `default`. */
  readonly variant?: InputVariant;
  /** Density preset for form or inline usage. Defaults to `md`. */
  readonly size?: InputSize;
}

export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  { variant = 'default', size = 'md', className, ...rest },
  ref,
) {
  return (
    <input
      {...rest}
      ref={ref}
      className={`wm-input${className != null ? ` ${className}` : ''}`}
      data-variant={variant}
      data-size={size}
    />
  );
});
