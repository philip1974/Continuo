// 代码编辑器(含 Markdown 源码模式)的缩进参考线与光标处单词的其它出现处高亮(对齐 VSCode)。
//
// - 缩进参考线(VSCode editor.guides.indentation 默认开、editor.guides.highlightActiveIndentation 默认开):每一级缩进画一条
//   1px 竖线,光标所在块的那一条高亮。级数按文档缩进(indentUnit / tabSize,打开时按内容推断,见 editor-indentation)计算,
//   tab 按 tabSize 折算列;空行延续上下文的缩进(VSCode 同)。实现用 @replit/codemirror-indentation-markers(只为可见行生成
//   行装饰,大文件不随行数变慢)。颜色取 --md-indent-guide / --md-indent-guide-active(VSCode editorIndentGuide.background1 /
//   activeBackground1)。竖线落在该级缩进列的左边缘(VSCode indentGuides:left = 缩进列 × 空格宽):库按「行左 2px + 0.5ch」起画,
//   CodeMirror 行左内边距是 6px,这里把起点改成 6px − 0.5ch,与字号无关地对齐到列边缘。
// - 光标处单词的其它出现处(VSCode editor.occurrencesHighlight 默认 singleFile;无语言服务时 wordHighlighter 用
//   TextualDocumentHighlightProvider 兜底:光标处单词,区分大小写、全词匹配,含光标处那一个):CodeMirror
//   highlightSelectionMatches 的 highlightWordAroundCursor —— 同样区分大小写、按单词边界匹配,只扫可见范围,多光标时不高亮。
//   与 basicSetup 里已有的「有选区时高亮相同文本」是同一个插件(配置按「或」合并),这里只是打开无选区时的单词高亮。
// BDD: src/__tests__/editor-indent-guides/、src/__tests__/editor-occurrences-highlight/

import type { Extension } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { highlightSelectionMatches } from '@codemirror/search';
import { indentationMarkers } from '@replit/codemirror-indentation-markers';

const GUIDE = 'var(--md-indent-guide)';
const ACTIVE_GUIDE = 'var(--md-indent-guide-active)';

/** 缩进参考线(含当前块高亮)。 */
export const indentGuides: Extension = [
  indentationMarkers({
    highlightActiveBlock: true,
    markerType: 'fullScope',
    thickness: 1,
    colors: { light: GUIDE, dark: GUIDE, activeLight: ACTIVE_GUIDE, activeDark: ACTIVE_GUIDE },
  }),
  EditorView.theme({ '.cm-indent-markers::before': { left: 'calc(6px - 0.5ch)' } }),
];

/** 无选区时高亮光标处单词的其它出现处。 */
export const wordOccurrencesHighlight: Extension = highlightSelectionMatches({ highlightWordAroundCursor: true });

export interface EditorGuidesOptions {
  /** editor.guides.indentation */
  readonly indentation: boolean;
  /** editor.occurrencesHighlight ≠ off */
  readonly occurrences: boolean;
}

/** 按设置组合(Compartment 里热切)。 */
export function editorGuides(opts: EditorGuidesOptions): Extension {
  return [opts.indentation ? indentGuides : [], opts.occurrences ? wordOccurrencesHighlight : []];
}
