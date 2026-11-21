import './Separator.css';
import type { HTMLAttributes } from 'react';

/**
 * Props for a horizontal separator.
 *
 * Use between grouped regions as `<Separator />`.
 * No custom defaults are applied beyond the `wm-separator` class.
 */
export interface SeparatorProps extends HTMLAttributes<HTMLHRElement> {}

export function Separator({ className, ...rest }: SeparatorProps) {
  return <hr {...rest} className={`wm-separator${className != null ? ` ${className}` : ''}`} />;
}
