// 代码编辑器(CodeEditor / 冲突比较;Markdown 源码模式同)的复制 / 剪切 / 粘贴,对齐 VSCode 编辑器剪贴板:
// - 无选区复制 / 剪切 = 整行(VSCode editor.emptySelectionClipboard 默认开):剪贴板文本带行尾换行(外部粘贴得到完整一行,
//   不再插在行中间);另写一份编辑器元数据(EDITOR_CLIPBOARD_MIME,对应 VSCode 的 `vscode-editor-data`:isFromEmptySelection /
//   multicursorText / mode)。粘贴时看到「整行」标记且光标都无选区 → 整行插到光标所在行上方,光标随原位置下移
//   (VSCode PasteOperation pasteOnNewLine + ReplaceCommandThatPreservesSelection)。元数据走 DataTransfer 自定义类型,
//   Chromium 把它放进系统剪贴板的 Web 自定义数据格式 —— 跨窗口(另一个渲染进程)同样读得到,VSCode 也靠它跨窗口;
//   此前 CodeMirror 只靠模块级 lastLinewiseCopy,只在同一渲染进程有效。
// - 多光标:各段文本(multicursorText)随元数据带上;粘贴时光标数与段数相同 → 逐个分配;否则(非整行)按行数等于光标数
//   拆开分配(VSCode multiCursorPaste 默认 spread:先去掉末尾一个换行)。
// - 剪切整行的删除范围照 VSCode DeleteOperations.cut:非末行删到下一行行首;末行(且不止一行、上一刀没删到本行)连同前一个
//   换行一起删;只有一行 → 删掉该行内容。
// - 复制带语法高亮的 HTML(VSCode editor.copyWithSyntaxHighlighting 默认开;见 copy-html.ts)。
// - 粘贴 / 剪切前后各断开撤销(VSCode 粘贴 / 剪切 shouldPushStackElementBefore / After):紧接着的输入不与它合成一次撤销。
// 外部粘贴(无元数据)只多了撤销断点,插入位置不变。只认 clipboardData 可用的事件(Chromium 总可用),否则交还 CodeMirror 原处理。
// BDD: src/__tests__/editor-clipboard/

import {
  EditorSelection,
  type EditorState,
  type Extension,
  Prec,
  type SelectionRange,
  type TransactionSpec,
} from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { isolateHistory } from '@codemirror/commands';
import { language } from '@codemirror/language';
import { copyHtmlFromView } from './copy-html';

/** 编辑器剪贴板元数据的 MIME 类型(DataTransfer 自定义类型;对应 VSCode 的 `vscode-editor-data`)。 */
export const EDITOR_CLIPBOARD_MIME = 'application/x-continuo-editor';

/** 复制的文本超过此长度不生成 HTML(VSCode generateDataToCopy:sourceText.length < 65536)。 */
export const COPY_HTML_MAX_TEXT = 65536;

/** 编辑器剪贴板元数据(JSON 写在 EDITOR_CLIPBOARD_MIME 下)。 */
export interface EditorClipboardMeta {
  readonly version: 1;
  /** 全部选区为空时的整行复制(VSCode isFromEmptySelection;这里多光标整行复制也算)。 */
  readonly linewise: boolean;
  /** 多段复制时的各段文本(VSCode multicursorText);单段 → null。 */
  readonly multicursorText: readonly string[] | null;
  /** 语言名(VSCode mode);纯文本 → null。 */
  readonly mode: string | null;
}

export interface EditorCopyData {
  readonly text: string;
  readonly meta: EditorClipboardMeta;
  /** 剪切时删除的范围(升序、不重叠)。 */
  readonly cutRanges: readonly { readonly from: number; readonly to: number }[];
  /** 生成 HTML 的范围(只有一个选区才给,VSCode getRichTextToCopy 同:多选区不给 HTML);空选区 = 整行内容(不含换行)。 */
  readonly htmlRange: { readonly from: number; readonly to: number } | null;
}

function outputFilter(state: EditorState, text: string): string {
  for (const filter of state.facet(EditorView.clipboardOutputFilter)) text = filter(text, state);
  return text;
}

/** 当前选区要复制的内容(纯函数)。有非空选区 → 只取非空选区(同 CodeMirror);全部为空 → 各光标所在行(每行带换行,同行只取一次)。 */
export function editorCopyData(state: EditorState): EditorCopyData {
  const ranges = state.selection.ranges;
  const mode = state.facet(language)?.name ?? null;
  const pieces: string[] = [];
  const cutRanges: { from: number; to: number }[] = [];
  const nonEmpty = ranges.filter((r) => !r.empty);
  let linewise = false;
  let htmlRange: { from: number; to: number } | null = null;
  if (nonEmpty.length > 0) {
    for (const r of nonEmpty) {
      pieces.push(outputFilter(state, state.sliceDoc(r.from, r.to)));
      cutRanges.push({ from: r.from, to: r.to });
    }
    if (ranges.length === 1) htmlRange = { from: ranges[0]!.from, to: ranges[0]!.to };
  } else {
    linewise = true;
    const doc = state.doc;
    let lastLine = 0;
    let lastCutEnd = -1;
    for (const r of ranges) {
      const line = doc.lineAt(r.head);
      if (line.number === lastLine) continue;
      lastLine = line.number;
      pieces.push(outputFilter(state, line.text) + state.lineBreak);
      let cut: { from: number; to: number };
      if (line.number < doc.lines) cut = { from: line.from, to: doc.line(line.number + 1).from };
      else if (line.number > 1 && lastCutEnd !== line.from) cut = { from: doc.line(line.number - 1).to, to: line.to };
      else cut = { from: line.from, to: line.to };
      lastCutEnd = cut.to;
      if (cut.to > cut.from) cutRanges.push(cut);
    }
    if (ranges.length === 1) {
      const line = doc.lineAt(ranges[0]!.head);
      htmlRange = { from: line.from, to: line.to };
    }
  }
  // 整行的各段已带换行 → 直接相接(VSCode 再用换行拼接,外部粘贴多出空行;刻意不照搬);其余段间用换行
  const text = linewise ? pieces.join('') : pieces.join(state.lineBreak);
  return {
    text,
    meta: { version: 1, linewise, multicursorText: pieces.length > 1 ? pieces : null, mode },
    cutRanges,
    htmlRange,
  };
}

/** 解析剪贴板里的编辑器元数据;缺失 / 非法 / 版本不符 → null。 */
export function parseEditorClipboardMeta(raw: string): EditorClipboardMeta | null {
  if (raw === '') return null;
  try {
    const v = JSON.parse(raw) as Partial<EditorClipboardMeta> | null;
    if (!v || typeof v !== 'object' || v.version !== 1) return null;
    const multi = Array.isArray(v.multicursorText) && v.multicursorText.every((s) => typeof s === 'string')
      ? v.multicursorText
      : null;
    return {
      version: 1,
      linewise: v.linewise === true,
      multicursorText: multi,
      mode: typeof v.mode === 'string' ? v.mode : null,
    };
  } catch {
    return null;
  }
}

function inputFilter(state: EditorState, text: string): string {
  for (const filter of state.facet(EditorView.clipboardInputFilter)) text = filter(text, state);
  return text;
}

/** 多光标分配(VSCode _distributePasteToCursors):段数 = 光标数 → 逐个;否则非整行时按行拆(先去掉末尾一个换行)。 */
function distribute(text: string, ranges: readonly SelectionRange[], meta: EditorClipboardMeta | null, linewise: boolean): readonly string[] | null {
  if (ranges.length === 1) return null;
  if (meta?.multicursorText && meta.multicursorText.length === ranges.length) return meta.multicursorText;
  if (linewise) return null;
  let t = text;
  if (t.endsWith('\n')) t = t.slice(0, -1);
  if (t.endsWith('\r')) t = t.slice(0, -1);
  const lines = t.split(/\r\n|\r|\n/);
  return lines.length === ranges.length ? lines : null;
}

/** 粘贴的事务(纯函数):整行标记 + 光标都无选区 → 插到各光标所在行上方;多光标按段分配;其余替换选区。前后断开撤销。 */
export function editorPasteTransaction(state: EditorState, rawText: string, meta: EditorClipboardMeta | null): TransactionSpec {
  const text = inputFilter(state, rawText);
  const ranges = state.selection.ranges;
  const linewise = meta?.linewise === true && ranges.every((r) => r.empty);
  const pieces = distribute(text, ranges, meta, linewise);
  let spec: TransactionSpec;
  if (linewise) {
    let index = 0;
    let lastLine = -1;
    spec = state.changeByRange((range) => {
      const i = index++;
      const line = state.doc.lineAt(range.head);
      if (line.from === lastLine) return { range };
      lastLine = line.from;
      let insert = pieces ? pieces[i]! : text;
      if (!/(\r\n|\r|\n)$/.test(insert)) insert += state.lineBreak;
      const len = state.toText(insert).length;
      return { changes: { from: line.from, insert }, range: EditorSelection.cursor(range.head + len) };
    });
  } else if (pieces) {
    let index = 0;
    spec = state.changeByRange((range) => {
      const insert = pieces[index++]!;
      return {
        changes: { from: range.from, to: range.to, insert },
        range: EditorSelection.cursor(range.from + state.toText(insert).length),
      };
    });
  } else {
    spec = state.replaceSelection(text);
  }
  return { ...spec, userEvent: 'input.paste', scrollIntoView: true, annotations: isolateHistory.of('full') };
}

export interface EditorClipboardOptions {
  /** 复制时是否带语法高亮 HTML(设置 editor.copyWithSyntaxHighlighting;每次复制时读)。 */
  readonly copyWithSyntaxHighlighting: () => boolean;
}

function onCopy(view: EditorView, event: ClipboardEvent, opts: EditorClipboardOptions): boolean {
  const data = event.clipboardData;
  if (!data) return false;
  const copy = editorCopyData(view.state);
  if (copy.text === '' && !copy.meta.linewise) return false;
  const html =
    copy.htmlRange && copy.meta.mode !== null && copy.text.length < COPY_HTML_MAX_TEXT && opts.copyWithSyntaxHighlighting()
      ? copyHtmlFromView(view, copy.htmlRange.from, copy.htmlRange.to)
      : null;
  data.clearData();
  data.setData('text/plain', copy.text);
  if (html !== null) data.setData('text/html', html);
  data.setData(EDITOR_CLIPBOARD_MIME, JSON.stringify(copy.meta));
  if (event.type === 'cut' && !view.state.readOnly && copy.cutRanges.length > 0) {
    view.dispatch({
      changes: copy.cutRanges,
      scrollIntoView: true,
      userEvent: 'delete.cut',
      annotations: isolateHistory.of('full'),
    });
  }
  return true;
}

function onPaste(view: EditorView, event: ClipboardEvent): boolean {
  const data = event.clipboardData;
  if (!data || view.state.readOnly) return false;
  const text = data.getData('text/plain') || data.getData('text/uri-list');
  if (text === '') return false; // 只有文件 / 图片等:交给后面的处理(Markdown 粘贴图片)与 CodeMirror
  view.dispatch(editorPasteTransaction(view.state, text, parseEditorClipboardMeta(data.getData(EDITOR_CLIPBOARD_MIME))));
  return true;
}

/**
 * 复制 / 剪切 / 粘贴处理(Prec.lowest:排在其它扩展的粘贴处理之后 —— 如 Markdown 粘贴图片;仍先于 CodeMirror 内建处理)。
 * 不判断 DOM 选区是否在本编辑器内:CodeMirror 内建处理那一判断是为嵌在 ProseMirror 里的情形,CodeEditor 不嵌套。
 */
export function editorClipboard(opts: EditorClipboardOptions): Extension {
  return Prec.lowest(
    EditorView.domEventHandlers({
      copy: (event, view) => onCopy(view, event, opts),
      cut: (event, view) => onCopy(view, event, opts),
      paste: (event, view) => onPaste(view, event),
    }),
  );
}
