import type { HTMLAttributes, ReactNode } from 'react';

/**
 * Props for single-line text that is truncated from the **start** (ellipsis on the left).
 *
 * Use for paths and other text whose tail matters most, e.g. a parent directory next to a file name:
 * `<TruncateStart text="/Users/me/projects/app" className="min-w-0 flex-1 text-fg-dim" />`.
 * The full text is the default `title`.
 */
export interface TruncateStartProps extends Omit<HTMLAttributes<HTMLSpanElement>, 'children'> {
  /** The text to show. No default. */
  readonly text: string;
  /**
   * Optional rich rendering of the same characters as `text` (e.g. `<mark>` around search matches). Must not add or
   * reorder characters: `text` stays the default `title`. Defaults to `text`.
   */
  readonly children?: ReactNode;
}

/*
 * 实现:外层 direction:rtl 让溢出落在行首(省略号在左),text-align:left 使未溢出时仍左对齐;文本放进 dir=ltr 的
 * 内层(unicode-bidi:isolate),整段按 ltr 排 —— 否则 `/a/b`、`(x)` 这类开头 / 结尾的中性标点会被 rtl 重排到另一端。
 * 纯 CSS,不测量宽度,随容器伸缩即时生效。
 */
export function TruncateStart({ text, className, title, children, ...rest }: TruncateStartProps) {
  return (
    <span
      {...rest}
      className={`wm-truncate-start${className != null ? ` ${className}` : ''}`}
      title={title ?? text}
    >
      <span dir="ltr">{children ?? text}</span>
    </span>
  );
}
