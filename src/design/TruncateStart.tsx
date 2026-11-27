import type { HTMLAttributes, ReactNode } from 'react';

/**
 * Props for single-line text that is truncated from the **start** (ellipsis on the left).
 *
 * Use for paths and other text whose tail matters most, e.g. a parent directory next to a file name:
 * `<TruncateStart text="/Users/me/projects/app" className="min-w-0 flex-1 text-fg-dim" />`.
 * The full text is the default `title`. Tabs in `text` are expanded to spaces (8-column tab stops).
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
 * 双向算法 L1 规则会把「行尾的空白」与「Tab(段分隔符)」的层级重置为段落层级(这里是 rtl),isolate 也挡不住:
 * - 行尾空白:内层末尾由 CSS 生成一个 LRM(强 ltr 字符,见 TruncateStart.css),空白不再处在行尾;
 * - Tab:text 中的 Tab 按 8 列制表位(CSS tab-size 缺省值)展开成空格,否则 Tab 两侧的文字会被 rtl 对调。
 *   children 由调用方渲染,其中的 Tab 须调用方自行展开。
 */
export function TruncateStart({ text, className, title, children, ...rest }: TruncateStartProps) {
  return (
    <span
      {...rest}
      className={`wm-truncate-start${className != null ? ` ${className}` : ''}`}
      title={title ?? text}
    >
      <span dir="ltr">{children ?? expandTabs(text)}</span>
    </span>
  );
}

const TAB_SIZE = 8;

/** Tab 按 8 列制表位展开为空格(列从 text 开头算;无 Tab 原样返回)。 */
function expandTabs(text: string): string {
  if (!text.includes('\t')) return text;
  let out = '';
  let column = 0;
  for (const ch of text) {
    if (ch === '\t') {
      const n = TAB_SIZE - (column % TAB_SIZE);
      out += ' '.repeat(n);
      column += n;
    } else {
      out += ch;
      column += 1;
    }
  }
  return out;
}
