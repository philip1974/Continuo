// @vitest-environment jsdom
// BDD: editor-unicode-highlight / 编辑器(代码与 Markdown 源码)把双向控制 / 不可见字符显示出来,同形字加框
// (VSCode editor.renderControlCharacters + editor.unicodeHighlight.invisibleCharacters / ambiguousCharacters)。
import { afterEach, describe, expect, it } from 'vitest';
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { javascript } from '@codemirror/lang-javascript';
import { markdown } from '@codemirror/lang-markdown';
import type { Extension } from '@codemirror/state';
import { codeEditorBasicSetup } from '../../panels/Editor/codemirror-basic-setup';
import {
  ambiguousCharacters,
  shouldHighlightAmbiguous,
} from '../../panels/Editor/codemirror-unicode-highlight';
import { t } from '../../i18n';

let view: EditorView | null = null;
afterEach(() => {
  view?.destroy();
  view = null;
});

function mount(doc: string, lang: Extension = javascript()): HTMLElement {
  const parent = document.createElement('div');
  document.body.appendChild(parent);
  view = new EditorView({ state: EditorState.create({ doc, extensions: [codeEditorBasicSetup, lang] }), parent });
  return view.contentDOM;
}

const specialTitles = (root: HTMLElement) => [...root.querySelectorAll('.cm-specialChar')].map((e) => e.getAttribute('title'));

describe('双向控制 / 不可见字符显示为占位符(悬停给出码位)', () => {
  it.each([
    ['U+202A LRE', '‪'],
    ['U+202B RLE', '‫'],
    ['U+202C PDF', '‬'],
    ['U+2068 FSI', '⁨'],
    ['U+202E RLO(CodeMirror 原有)', '‮'],
    ['U+2060 WORD JOINER', '⁠'],
    ['U+2061 函数应用', '⁡'],
    ['U+3164 韩文填充符', 'ㅤ'],
    ['U+2800 盲文空白', '⠀'],
    ['U+E0041 tag 字符', '\u{e0041}'],
  ])('%s', (_name, ch) => {
    const root = mount(`const a = "x${ch}y";`);
    expect(specialTitles(root)).toHaveLength(1);
    expect(root.textContent).not.toContain(ch);
  });

  it('Markdown 源码同样显示', () => {
    const root = mount('# 标题‪\n\n正文⁨', markdown());
    expect(specialTitles(root)).toHaveLength(2);
  });

  it('ZWJ emoji、变体选择符、全角空格、不换行空格不替换(刻意:替换会破坏正常文字显示)', () => {
    const root = mount('const s = "👨‍👩 ❤️ 中　文 a b";');
    expect(specialTitles(root)).toEqual([]);
  });
});

describe('同形字加框', () => {
  const boxes = (root: HTMLElement) => [...root.querySelectorAll('.cm-ambiguousChar')].map((e) => e.textContent);

  it('混在 ASCII 标识符里的西里尔字母 / 全角字母加框,悬停说明易混的 ASCII 字符', () => {
    const root = mount('const pаssword = "Ａdmin";'); // а = U+0430,Ａ = U+FF21
    expect(boxes(root)).toEqual(['а', 'Ａ']);
    expect(root.querySelector('.cm-ambiguousChar')!.getAttribute('title')).toBe(
      t('panels.editor.unicode.ambiguous', { char: 'U+0430 "а"', ascii: 'U+0061 "a"' }),
    );
  });

  it('整个词都是外文(含明显非 ASCII 字符)时不标:中文里的全角标点、整段西里尔文', () => {
    const root = mount('// 中文（说明）\nconst s = "Привет мир";');
    expect(boxes(root)).toEqual([]);
  });

  it('Markdown / 纯文本不标(VSCode [markdown] / [plaintext] 默认关闭)', () => {
    expect(boxes(mount('pаssword', markdown()))).toEqual([]);
    expect(boxes(mount('pаssword', []))).toEqual([]);
  });

  it('词规则(VSCode CodePointHighlighter)', () => {
    const map = ambiguousCharacters('en');
    expect(shouldHighlightAmbiguous('pаss', 1, map)).toBe(true);
    expect(shouldHighlightAmbiguous('Привет', 1, map)).toBe(false);
    expect(shouldHighlightAmbiguous('а', 0, map)).toBe(true); // 单个同形字(无明显外文)照标
  });
});
