import type { ButtonHTMLAttributes, Ref } from 'react';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'outlined';
export type ButtonSize = 'sm' | 'md' | 'lg';

/**
 * Props for the shared design button.
 *
 * Use for actions such as `<Button variant="primary">Run</Button>`.
 * `variant` defaults to `primary`, `size` defaults to `md`, and `type` defaults to `button`.
 */
export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  /** Visual priority and semantic intent. Defaults to `primary`. */
  readonly variant?: ButtonVariant;
  /** Density preset. Defaults to `md`. */
  readonly size?: ButtonSize;
  /** Forwarded to the native `<button>` (React 19 ref-as-prop), e.g. as a dropdown menu trigger. */
  readonly ref?: Ref<HTMLButtonElement>;
}

export function Button({
  variant = 'primary',
  size = 'md',
  className,
  children,
  ...rest
}: ButtonProps) {
  return (
    <button
      type="button"
      {...rest}
      className={`wm-button${className != null ? ` ${className}` : ''}`}
      data-variant={variant}
      data-size={size}
    >
      {children}
    </button>
  );
}
