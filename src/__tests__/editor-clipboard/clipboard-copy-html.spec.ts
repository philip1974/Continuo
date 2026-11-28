// @vitest-environment jsdom
// BDD: editor-clipboard —— 复制带语法高亮的 HTML(VSCode copyWithSyntaxHighlighting)。见同目录 README。
import { afterEach, describe, expect, it } from 'vitest';
import { EditorSelection, EditorState, type Extension } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { javascript } from '@codemirror/lang-javascript';
import { tags } from '@lezer/highlight';
import { copyHtml, sanitizeFontFamily, type CopyHtmlOptions } from '../../panels/Editor/copy-html';
import { COPY_HTML_MAX_TEXT, editorClipboard } from '../../panels/Editor/codemirror-clipboard';
import { EDITOR_COPY_WITH_SYNTAX_HIGHLIGHTING } from '../../plugins/settings/core-setting-specs';
import { en } from '@shared/i18n-locales/en';
import { zh } from '@shared/i18n-locales/zh';
import { ko } from '@shared/i18n-locales/ko';

const style = HighlightStyle.define([{ tag: tags.keyword, class: 'kw' }]);
const JS: Extension[] = [javascript(), syntaxHighlighting(style)];

const OPTS: CopyHtmlOptions = {
  frame: { color: 'fg', backgroundColor: 'bg', fontFamily: 'Menlo', fontWeight: 'normal', fontSize: 13, lineHeight: 20 },
  styleFor: (cls) => (cls.split(' ').includes('kw') ? 'color: red;' : ''),
  tabSize: 4,
  useNbsp: false,
};

function st(doc: string, extensions: Extension[] = JS): EditorState {
  return EditorState.create({ doc, extensions });
}

describe('HTML 格式(照 VSCode)', () => {
  it('外层样式 + 每行 div + 高亮 span,未高亮用前景色', () => {
    const s = st('let a = 1;');
    expect(copyHtml(s, 0, s.doc.length, OPTS)).toBe(
      '<div style="color: fg;background-color: bg;font-family: Menlo;font-weight: normal;font-size: 13px;line-height: 20px;white-space: pre;">' +
        '<div><span style="color: red;">let</span><span style="color: fg;"> a = 1;</span></div></div>',
    );
  });

  it('空行 <br>,转义 < > &,Tab 从行首累计展开', () => {
    const s = st('a<b>&c\n\n\tx', []);
    const html = copyHtml(s, 0, s.doc.length, OPTS);
    expect(html).toContain('<div><span style="color: fg;">a&lt;b&gt;&amp;c</span></div><br><div><span style="color: fg;">    x</span></div>');
  });

  it('只取范围内的文字(行中起止)', () => {
    const s = st('let abc = 1;');
    expect(copyHtml(s, 4, 7, OPTS)).toContain('<div><span style="color: fg;">abc</span></div>');
  });

  it('Windows 空格交替 &#160;', () => {
    const s = st('a  b', []);
    expect(copyHtml(s, 0, 4, { ...OPTS, useNbsp: true })).toContain('a &#160;b');
  });

  it('字体族里的双引号换成单引号,含 ; < > 等退回 monospace', () => {
    expect(sanitizeFontFamily('"SF Mono", Menlo')).toBe("'SF Mono', Menlo");
    expect(sanitizeFontFamily('x;}<script>')).toBe('monospace');
  });
});

class FakeDataTransfer {
  readonly data = new Map<string, string>();
  setData(type: string, value: string): void {
    this.data.set(type, value);
  }
  getData(type: string): string {
    return this.data.get(type) ?? '';
  }
  clearData(): void {
    this.data.clear();
  }
}

let view: EditorView | null = null;
afterEach(() => {
  view?.destroy();
  view = null;
});

function copyFrom(doc: string, ranges: [number, number][], extensions: Extension[], highlight = true): FakeDataTransfer {
  view = new EditorView({
    state: EditorState.create({
      doc,
      selection: EditorSelection.create(ranges.map(([a, h]) => EditorSelection.range(a, h))),
      extensions: [EditorState.allowMultipleSelections.of(true), editorClipboard({ copyWithSyntaxHighlighting: () => highlight }), ...extensions],
    }),
    parent: document.body,
  });
  const data = new FakeDataTransfer();
  const e = new Event('copy', { bubbles: true, cancelable: true });
  Object.defineProperty(e, 'clipboardData', { value: data });
  view.contentDOM.dispatchEvent(e);
  return data;
}

describe('何时写 text/html', () => {
  it('单个选区(含无选区整行)写 HTML;整行 HTML 不含换行', () => {
    expect(copyFrom('let a', [[0, 3]], JS).getData('text/html')).toContain('let</span>');
    const line = copyFrom('let a\nb', [[1, 1]], JS).getData('text/html');
    expect(line).toContain('<div><span');
    expect(line).not.toContain('<br>');
  });

  it('多选区 / 纯文本 / 设置关掉 / 超过阈值 → 不写', () => {
    expect(copyFrom('let a', [[0, 1], [2, 3]], JS).getData('text/html')).toBe('');
    expect(copyFrom('plain', [[0, 3]], []).getData('text/html')).toBe('');
    expect(copyFrom('let a', [[0, 3]], JS, false).getData('text/html')).toBe('');
    const big = 'x'.repeat(COPY_HTML_MAX_TEXT);
    expect(copyFrom(big, [[0, big.length]], JS).getData('text/html')).toBe('');
    expect(copyFrom(big, [[0, big.length - 1]], JS).getData('text/html')).not.toBe('');
  });
});

describe('设置项', () => {
  it('editor.copyWithSyntaxHighlighting 默认开,三语', () => {
    expect(EDITOR_COPY_WITH_SYNTAX_HIGHLIGHTING.id).toBe('editor.copyWithSyntaxHighlighting');
    expect(EDITOR_COPY_WITH_SYNTAX_HIGHLIGHTING.default).toBe(true);
    for (const cat of [en, zh, ko] as Record<string, string>[]) {
      expect(cat[EDITOR_COPY_WITH_SYNTAX_HIGHLIGHTING.titleKey!]).toBeTruthy();
      expect(cat[EDITOR_COPY_WITH_SYNTAX_HIGHLIGHTING.descriptionKey!]).toBeTruthy();
    }
  });
});
