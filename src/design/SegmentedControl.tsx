import './SegmentedControl.css';
import type { KeyboardEvent } from 'react';

export type SegmentedControlSize = 'sm' | 'md';

/**
 * A compact mutually exclusive string-literal option.
 *
 * Use with `SegmentedControl` options such as `{ id: 'preview', label: 'Preview' }`.
 */
export interface SegmentedControlOption<T extends string> {
  /** Stable option id returned by `onChange`. No default. */
  readonly id: T;
  /** Visible option label. No default. */
  readonly label: string;
}

/**
 * Props for a compact mutually exclusive segmented control.
 *
 * Use for mode switching such as:
 * `<SegmentedControl options={modes} value={mode} onChange={setMode} />`.
 */
export interface SegmentedControlProps<T extends string> {
  /** Ordered options. No default. */
  readonly options: readonly SegmentedControlOption<T>[];
  /** Currently selected option id. No default. */
  readonly value: T;
  /** Called with the selected option id. No default. */
  readonly onChange: (id: T) => void;
  /** Density preset. Defaults to `sm`. */
  readonly size?: SegmentedControlSize;
  /** Prevents interaction and dims every segment. Defaults to `false`. */
  readonly disabled?: boolean;
  // Continuo-local 微调(a11y):radiogroup 须有可访问名(否则 AT 只读「radiogroup」不知
  // 在选什么)。允许调用方传 aria-labelledby 指向可见标签 或 aria-label 直接命名。通用增强,
  // 应推回 Nous。
  /** Id of an element labelling this radiogroup (a11y). Optional. */
  readonly ariaLabelledby?: string;
  /** Accessible name when no visible label element exists (a11y). Optional. */
  readonly ariaLabel?: string;
}

export function SegmentedControl<T extends string>({
  options,
  value,
  onChange,
  size = 'sm',
  disabled = false,
  ariaLabelledby,
  ariaLabel,
}: SegmentedControlProps<T>) {
  // Continuo-local 微调(a11y A24,A23 同族):role="radiogroup" 须配 WAI-ARIA radio 键盘模型。
  // radio group 是「自动激活」—— 方向键同时移焦并切换选中(配合 roving tabindex:仅选中项在
  // Tab 顺序内)。Home/End 跳首尾,左右/上下循环。Nous 上游纯展示无此模型,通用增强应推回。
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (disabled) return;
    const { key } = e;
    if (
      key !== 'ArrowRight' &&
      key !== 'ArrowDown' &&
      key !== 'ArrowLeft' &&
      key !== 'ArrowUp' &&
      key !== 'Home' &&
      key !== 'End'
    )
      return;
    if (options.length === 0) return;
    const cur = options.findIndex((o) => o.id === value);
    let next: number;
    if (key === 'Home') next = 0;
    else if (key === 'End') next = options.length - 1;
    else if (key === 'ArrowRight' || key === 'ArrowDown')
      next = cur < 0 ? 0 : (cur + 1) % options.length;
    else next = cur <= 0 ? options.length - 1 : cur - 1; // ArrowLeft/ArrowUp
    const target = options[next];
    if (target == null) return;
    e.preventDefault();
    onChange(target.id);
    // 焦点跟随选中项(radio group 自动激活语义)
    const radios = e.currentTarget.querySelectorAll<HTMLButtonElement>(
      '[role="radio"]',
    );
    radios[next]?.focus();
  };

  return (
    <div
      className="wm-segmented"
      role="radiogroup"
      aria-labelledby={ariaLabelledby}
      aria-label={ariaLabel}
      data-size={size}
      data-disabled={disabled}
      onKeyDown={onKeyDown}
    >
      {options.map((option) => {
        const active = option.id === value;
        return (
          <button
            key={option.id}
            type="button"
            role="radio"
            className="wm-segmented-option"
            data-active={active}
            aria-checked={active}
            // a11y(A24):roving tabindex —— 仅选中项在 Tab 顺序内(0),其余 -1,组内方向键导航。
            tabIndex={active ? 0 : -1}
            disabled={disabled}
            onClick={() => {
              onChange(option.id);
            }}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}
