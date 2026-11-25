import { Fragment, type ReactNode } from 'react';
import { PICKER_MATCH_CLASS_NAME } from './picker-row';

/**
 * 把 text 里命中的字符包成 <mark>(连续下标合成一段)。indices 是升序的命中下标,按 offset 换算到 text 内
 *(text 是匹配源 [offset, offset + text.length) 那一段,如命令的分类 / 标题、文件的目录 / 文件名);落在段外的忽略。
 * 只换样式,文字内容与顺序不变 —— 行的读屏名称照旧连贯。
 */
export function highlightMatches(text: string, indices: readonly number[] | null, offset = 0): ReactNode {
  if (!indices || indices.length === 0) return text;
  const parts: ReactNode[] = [];
  let pos = 0;
  let i = 0;
  while (i < indices.length) {
    const start = indices[i]! - offset;
    if (start < 0 || start >= text.length) {
      i++;
      continue;
    }
    let end = start + 1;
    while (i + 1 < indices.length && indices[i + 1]! - offset === end && end < text.length) {
      i++;
      end++;
    }
    i++;
    if (start > pos) parts.push(text.slice(pos, start));
    parts.push(
      <mark key={start} className={PICKER_MATCH_CLASS_NAME}>
        {text.slice(start, end)}
      </mark>,
    );
    pos = end;
  }
  if (parts.length === 0) return text;
  if (pos < text.length) parts.push(text.slice(pos));
  return <Fragment>{parts}</Fragment>;
}
