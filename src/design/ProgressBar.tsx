import { useEffect, useState, type HTMLAttributes } from 'react';

/**
 * `active` 持续为 true 满 `delayMs` 后才变 true;`active` 变 false 立即 false(VSCode withProgress 的 `delay`:
 * 很快结束的操作不闪出进度提示)。`delayMs <= 0` → 与 `active` 同步。
 */
export function useDelayedActive(active: boolean, delayMs: number): boolean {
  const [elapsed, setElapsed] = useState(false);
  useEffect(() => {
    if (!active || delayMs <= 0) {
      setElapsed(false);
      return;
    }
    const handle = setTimeout(() => setElapsed(true), delayMs);
    return () => {
      clearTimeout(handle);
      setElapsed(false);
    };
  }, [active, delayMs]);
  return active && (delayMs <= 0 || elapsed);
}

/**
 * Props for an indeterminate, thin (2px) progress bar shown at the top of a view while it is busy.
 *
 * Use as `<ProgressBar active={busy} delayMs={300} aria-label="…" className="absolute inset-x-0 top-0" />`.
 * Renders nothing until `active` has stayed true for `delayMs` (default 0); hides immediately when `active` turns false.
 * Renders `role="progressbar"` without `aria-valuenow` (indeterminate); pass an `aria-label`.
 */
export interface ProgressBarProps extends HTMLAttributes<HTMLDivElement> {
  /** Whether the work is in progress. */
  readonly active: boolean;
  /** Delay before the bar appears, in ms (anti-flicker). Defaults to `0`. */
  readonly delayMs?: number;
}

export function ProgressBar({ active, delayMs = 0, className, ...rest }: ProgressBarProps) {
  const shown = useDelayedActive(active, delayMs);
  if (!shown) return null;
  return (
    <div role="progressbar" {...rest} className={`wm-progress${className != null ? ` ${className}` : ''}`}>
      <div className="wm-progress-bit" />
    </div>
  );
}
