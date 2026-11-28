// Ported from microsoft/vscode (MIT, © Microsoft Corporation; see LICENSE-3RD-PARTY.md).
// 复制带语法高亮的 HTML(VSCode editor.copyWithSyntaxHighlighting,默认开):粘贴到文档 / 邮件 / 演示文稿里保留代码配色。
// 格式照 VSCode viewModelImpl.getRichTextToCopy + textToHtmlTokenizer.tokenizeLineToHTML:
//   外层 <div style="color; background-color; font-family; font-weight; font-size; line-height; white-space: pre;">
//   每行 <div><span style="color: …;">…</span>…</div>,空行 <br>;< > & 转义,Tab 按 tab 宽度展开成空格(Windows 用 &#160; 交替,
//   防止被折叠),\0 → &#00;,\r → 零宽空格,行 / 段分隔符与 BOM → U+FFFD。
// 颜色取当前主题:语法色由 HighlightStyle 的类名在编辑器里实际算出的样式(亮 / 暗 / 高对比度 / 强制颜色都跟随),
// 外层前景 / 背景 / 字体取编辑器自身的计算样式。BDD: src/__tests__/editor-clipboard/

import type { EditorState } from '@codemirror/state';
import type { EditorView } from '@codemirror/view';
import { ensureSyntaxTree, highlightingFor, syntaxTree } from '@codemirror/language';
import { highlightTree } from '@lezer/highlight';
import { isWindowsRuntime } from '@/lib/path-cross';

/** 外层 div 的样式(编辑器的前景 / 背景 / 字体)。 */
export interface CopyHtmlFrame {
  readonly color: string;
  readonly backgroundColor: string;
  readonly fontFamily: string;
  readonly fontWeight: string;
  readonly fontSize: number;
  readonly lineHeight: number;
}

export interface CopyHtmlOptions {
  readonly frame: CopyHtmlFrame;
  /** 高亮类名(空格分隔)→ 内联样式(如 `color: #c678dd;font-style: italic;`)。 */
  readonly styleFor: (classes: string) => string;
  readonly tabSize: number;
  /** 空格 / Tab 展开交替用 &#160;(VSCode 在 Windows 上开)。 */
  readonly useNbsp: boolean;
}

/** VSCode strings.isFullWidthCharacter(Tab 展开时按 2 列计)。 */
function isFullWidth(code: number): boolean {
  return (code >= 0x2e80 && code <= 0xd7af) || (code >= 0xf900 && code <= 0xfaff) || (code >= 0xff01 && code <= 0xff5e);
}

/** 字体族里的双引号换成单引号(写进 style="…");含 : ; \ / < > 的退回 monospace(VSCode 同理退回默认字体)。 */
export function sanitizeFontFamily(family: string): string {
  if (family.trim() === '' || /[:;\\/<>]/.test(family)) return 'monospace';
  return family.replace(/"/g, "'");
}

/** 一行 [start, end) 的 HTML(VSCode tokenizeLineToHTML);segments 是本行内按位置排好的 [from, to, style](行内偏移)。 */
function lineHtml(text: string, start: number, end: number, segments: readonly (readonly [number, number, string])[], opts: CopyHtmlOptions): string {
  let out = '<div>';
  let width = 0;
  let prevIsSpace = true;
  let char = 0;
  for (const [segFrom, segTo, style] of segments) {
    let part = '';
    for (; char < segTo && char < end; char++) {
      const code = text.charCodeAt(char);
      const isTab = code === 9;
      width += isFullWidth(code) ? 2 : isTab ? 0 : 1;
      if (char < start) {
        if (isTab) {
          const r = width % opts.tabSize;
          width += r === 0 ? opts.tabSize : opts.tabSize - r;
        }
        continue;
      }
      switch (code) {
        case 9: {
          const r = width % opts.tabSize;
          const n = r === 0 ? opts.tabSize : opts.tabSize - r;
          width += n;
          for (let k = 0; k < n; k++) {
            if (opts.useNbsp && prevIsSpace) {
              part += '&#160;';
              prevIsSpace = false;
            } else {
              part += ' ';
              prevIsSpace = true;
            }
          }
          break;
        }
        case 60:
          part += '&lt;';
          prevIsSpace = false;
          break;
        case 62:
          part += '&gt;';
          prevIsSpace = false;
          break;
        case 38:
          part += '&amp;';
          prevIsSpace = false;
          break;
        case 0:
          part += '&#00;';
          prevIsSpace = false;
          break;
        case 0xfeff:
        case 0x2028:
        case 0x2029:
        case 0x85:
          part += '�';
          prevIsSpace = false;
          break;
        case 13:
          part += '&#8203';
          prevIsSpace = false;
          break;
        case 32:
          if (opts.useNbsp && prevIsSpace) {
            part += '&#160;';
            prevIsSpace = false;
          } else {
            part += ' ';
            prevIsSpace = true;
          }
          break;
        default:
          part += String.fromCharCode(code);
          prevIsSpace = false;
      }
    }
    if (segTo <= start || segFrom >= end) continue;
    out += `<span style="${style}">${part}</span>`;
  }
  return out + '</div>';
}

/**
 * [from, to) 的高亮 HTML(纯函数,样式由 opts 注入)。from === to 不会出现(调用方对空选区传整行)。
 * 未高亮的文字用外层前景色(VSCode 每个 token 都带颜色)。
 */
export function copyHtml(state: EditorState, from: number, to: number, opts: CopyHtmlOptions): string {
  const tree = ensureSyntaxTree(state, to, 100) ?? syntaxTree(state);
  const marks: [number, number, string][] = [];
  highlightTree(tree, { style: (tags) => highlightingFor(state, tags) }, (f, t, classes) => marks.push([f, t, classes]), from, to);
  const defaultStyle = `color: ${opts.frame.color};`;
  const doc = state.doc;
  const first = doc.lineAt(from).number;
  const last = doc.lineAt(to).number;
  let body = '';
  let m = 0;
  for (let n = first; n <= last; n++) {
    const line = doc.line(n);
    if (line.length === 0) {
      body += '<br>';
      continue;
    }
    const start = n === first ? from - line.from : 0;
    const end = n === last ? to - line.from : line.length;
    // 本行的分段:高亮区间之间的空隙用默认色,整行从 0 起分段(Tab 宽度要从行首累计)
    const segments: [number, number, string][] = [];
    let pos = 0;
    while (m < marks.length && marks[m]![1] <= line.from) m++;
    for (let k = m; k < marks.length && marks[k]![0] < line.to; k++) {
      const [mf, mt, cls] = marks[k]!;
      const a = Math.max(mf, line.from) - line.from;
      const b = Math.min(mt, line.to) - line.from;
      if (a > pos) segments.push([pos, a, defaultStyle]);
      segments.push([a, b, opts.styleFor(cls) || defaultStyle]);
      pos = b;
    }
    if (pos < line.length) segments.push([pos, line.length, defaultStyle]);
    body += lineHtml(line.text, start, end, segments, opts);
  }
  const f = opts.frame;
  return (
    `<div style="color: ${f.color};background-color: ${f.backgroundColor};font-family: ${f.fontFamily};` +
    `font-weight: ${f.fontWeight};font-size: ${f.fontSize}px;line-height: ${f.lineHeight}px;white-space: pre;">` +
    body +
    '</div>'
  );
}

/** 计算样式 → 内联样式(VSCode getInlineStyle:color + 斜体 / 粗体 / 下划线 / 删除线)。 */
function inlineStyleOf(cs: CSSStyleDeclaration): string {
  let s = `color: ${cs.color};`;
  if (cs.fontStyle === 'italic' || cs.fontStyle.startsWith('oblique')) s += 'font-style: italic;';
  const weight = Number.parseInt(cs.fontWeight, 10);
  if (cs.fontWeight === 'bold' || weight >= 600) s += 'font-weight: bold;';
  const deco = [cs.textDecorationLine.includes('underline') ? 'underline' : '', cs.textDecorationLine.includes('line-through') ? 'line-through' : '']
    .filter(Boolean)
    .join(' ');
  if (deco) s += `text-decoration: ${deco};`;
  return s;
}

/** 按编辑器当前主题生成 [from, to) 的 HTML:类名样式在编辑器里放一个探针元素实测(每次复制缓存一份)。 */
export function copyHtmlFromView(view: EditorView, from: number, to: number): string {
  const win = view.dom.ownerDocument.defaultView;
  if (!win) return '';
  const rootStyle = win.getComputedStyle(view.dom);
  const contentStyle = win.getComputedStyle(view.contentDOM);
  const fontSize = Number.parseFloat(contentStyle.fontSize);
  const frame: CopyHtmlFrame = {
    color: contentStyle.color || rootStyle.color,
    backgroundColor: rootStyle.backgroundColor,
    fontFamily: sanitizeFontFamily(contentStyle.fontFamily),
    fontWeight: contentStyle.fontWeight || 'normal',
    fontSize: Number.isFinite(fontSize) ? fontSize : 13,
    lineHeight: Math.round(view.defaultLineHeight),
  };
  const cache = new Map<string, string>();
  // 探针放在 .cm-editor 下(不进 .cm-content:那里的 DOM 变化会被 CodeMirror 当成输入读回);用完即移除
  const probe = view.dom.ownerDocument.createElement('span');
  probe.setAttribute('aria-hidden', 'true');
  probe.style.position = 'absolute';
  probe.style.visibility = 'hidden';
  view.dom.appendChild(probe);
  try {
    return copyHtml(view.state, from, to, {
      frame,
      styleFor: (classes) => {
        let s = cache.get(classes);
        if (s === undefined) {
          probe.className = classes;
          s = inlineStyleOf(win.getComputedStyle(probe));
          cache.set(classes, s);
        }
        return s;
      },
      tabSize: view.state.tabSize,
      useNbsp: isWindowsRuntime(),
    });
  } finally {
    probe.remove();
  }
}
