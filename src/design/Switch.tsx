import './Switch.css';
import type { ButtonHTMLAttributes, MouseEvent } from 'react';

/**
 * Props for the shared on/off switch.
 *
 * Use for boolean settings such as `<Switch checked={on} onCheckedChange={setOn} aria-label="Line numbers" />`.
 * Controlled only: `checked` is required and the component keeps no internal state.
 */
export interface SwitchProps
  extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'role' | 'type' | 'onChange'> {
  /** Current on/off state. No default. */
  readonly checked: boolean;
  /** Called with the next state when the switch is activated (click, Space or Enter). */
  readonly onCheckedChange: (next: boolean) => void;
}

/**
 * 原生 `<button role="switch">`:Space / Enter 激活与 Tab 聚焦由浏览器提供(同 Radix Switch 做法),不另写键盘处理。
 * 视觉对齐 MD3 Switch,紧凑尺寸贴合 IDE 设置行。
 */
export function Switch({ checked, onCheckedChange, className, onClick, ...rest }: SwitchProps) {
  return (
    <button
      {...rest}
      type="button"
      role="switch"
      aria-checked={checked}
      data-checked={checked}
      className={`wm-switch${className != null ? ` ${className}` : ''}`}
      onClick={(e: MouseEvent<HTMLButtonElement>) => {
        onClick?.(e);
        if (!e.defaultPrevented) onCheckedChange(!checked);
      }}
    >
      <span className="wm-switch__thumb" aria-hidden="true" />
    </button>
  );
}
