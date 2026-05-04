import './SegmentedControl.css';

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
}

export function SegmentedControl<T extends string>({
  options,
  value,
  onChange,
  size = 'sm',
  disabled = false,
}: SegmentedControlProps<T>) {
  return (
    <div
      className="wm-segmented"
      role="radiogroup"
      data-size={size}
      data-disabled={disabled}
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
