import './Textarea.css';
import type { TextareaHTMLAttributes } from 'react';

export type TextareaVariant = 'default' | 'mono' | 'code';

/**
 * Props for a multi-line text input.
 *
 * Use for prompts or code snippets such as `<Textarea variant="code" />`.
 * `variant` defaults to `default`; all native `textarea` attributes are forwarded.
 */
export interface TextareaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  /** Typography and surface preset. Defaults to `default`. */
  readonly variant?: TextareaVariant;
}

export function Textarea({ variant = 'default', className, ...rest }: TextareaProps) {
  return (
    <textarea
      {...rest}
      className={`wm-textarea${className != null ? ` ${className}` : ''}`}
      data-variant={variant}
    />
  );
}
