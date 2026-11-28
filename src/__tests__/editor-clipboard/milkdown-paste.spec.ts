// @vitest-environment jsdom
// BDD: editor-clipboard —— Markdown 编辑模式(真实 Crepe)粘贴:撤销断点、代码编辑器来的内容按 Markdown 解析、网页 HTML 的图片 title /
// 代码块语言。见同目录 README。
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { Crepe } from '@milkdown/crepe';
import { undo } from '@milkdown/kit/prose/history';
import { TextSelection } from '@milkdown/kit/prose/state';
import type { EditorView } from '@milkdown/kit/prose/view';
import { markdownWritingKeys } from '../../panels/Editor/milkdown-writing-keys';
import { configureMarkdownStyle } from '../../panels/Editor/milkdown-markdown-style';
import { configureMarkdownMath } from '../../panels/Editor/milkdown-math';
import { codeBlockLanguageFromDom, imagePasteSchema, pasteHistoryBoundary } from '../../panels/Editor/milkdown-paste';
import { EDITOR_CLIPBOARD_MIME } from '../../panels/Editor/codemirror-clipboard';

vi.mock('../../plugins/settings/values-store', () => ({
  useSettingValue: <T,>(_id: string, fallback: T) => fallback,
  getStoredSettingValue: () => undefined,
}));

beforeAll(() => {
  const rect = (): DOMRect => ({ x: 0, y: 0, top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0, toJSON: () => ({}) });
  Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
  Range.prototype.getBoundingClientRect = rect;
});

const editors: Crepe[] = [];

/** 与 MilkdownEditor 相同的相关配置。 */
async function open(markdown: string): Promise<{ crepe: Crepe; view: EditorView }> {
  const root = document.createElement('div');
  document.body.appendChild(root);
  const crepe = new Crepe({ root, defaultValue: markdown, features: { [Crepe.Feature.ImageBlock]: false } });
  configureMarkdownStyle(crepe, markdown);
  configureMarkdownMath(crepe);
  crepe.editor.use(markdownWritingKeys);
  crepe.editor.use(pasteHistoryBoundary);
  crepe.editor.use(imagePasteSchema);
  editors.push(crepe);
  await crepe.create();
  return { crepe, view: crepe.editor.ctx.get<EditorView, 'editorView'>('editorView') };
}

afterEach(async () => {
  for (const crepe of editors.splice(0)) await crepe.destroy();
  document.body.innerHTML = '';
});

function paste(view: EditorView, data: Record<string, string>): void {
  const e = new Event('paste', { bubbles: true, cancelable: true }) as Event & { clipboardData: unknown };
  e.clipboardData = { files: [], types: Object.keys(data), getData: (t: string) => data[t] ?? '' };
  view.dom.dispatchEvent(e);
}

function caretAtEnd(view: EditorView): void {
  view.dispatch(view.state.tr.setSelection(TextSelection.atEnd(view.state.doc)));
}

describe('粘贴前后断开撤销', () => {
  it('输入 → 粘贴 → 紧接着输入:撤销一次只撤掉后面的输入,再撤销撤掉粘贴', async () => {
    const { crepe, view } = await open('x\n');
    caretAtEnd(view);
    view.dispatch(view.state.tr.insertText('a'));
    paste(view, { 'text/plain': 'P' });
    await Promise.resolve();
    view.dispatch(view.state.tr.insertText('b'));
    expect(crepe.getMarkdown().trim()).toBe('xaPb');
    undo(view.state, view.dispatch);
    expect(crepe.getMarkdown().trim()).toBe('xaP');
    undo(view.state, view.dispatch);
    expect(crepe.getMarkdown().trim()).toBe('xa');
  });
});

describe('从代码编辑器复制来的内容', () => {
  it('按纯文本当 Markdown 解析,不用随附的高亮 HTML', async () => {
    const { crepe, view } = await open('');
    caretAtEnd(view);
    paste(view, {
      'text/plain': '# Title\n',
      'text/html': '<div style="white-space: pre;"><div><span># Title</span></div></div>',
      [EDITOR_CLIPBOARD_MIME]: JSON.stringify({ version: 1, linewise: true, multicursorText: null, mode: 'markdown' }),
    });
    expect(crepe.getMarkdown()).toContain('# Title');
    expect(view.state.doc.textContent).not.toContain('#');
  });
});

describe('粘贴网页 HTML', () => {
  it('图片 title 只取 title 属性,不回落到 alt', async () => {
    const { crepe, view } = await open('start\n');
    caretAtEnd(view);
    paste(view, { 'text/html': '<p><img src="a.png" alt="cat"></p>', 'text/plain': '' });
    const md = crepe.getMarkdown();
    expect(md).toContain('![cat](a.png)');
    expect(md).not.toContain('"cat"');
  });

  it('代码块语言取 class="language-*"', async () => {
    const { crepe, view } = await open('');
    caretAtEnd(view);
    paste(view, { 'text/html': '<pre><code class="language-python">x = 1</code></pre>', 'text/plain': 'x = 1' });
    expect(crepe.getMarkdown()).toContain('```python\nx = 1\n```');
  });

  it('语言来源的优先次序与形状校验', () => {
    const pre = (html: string): HTMLElement => {
      const d = document.createElement('div');
      d.innerHTML = html;
      return d.firstElementChild as HTMLElement;
    };
    expect(codeBlockLanguageFromDom(pre('<pre data-language="ts"><code class="language-js"></code></pre>'))).toBe('ts');
    expect(codeBlockLanguageFromDom(pre('<pre data-lang="rust"><code></code></pre>'))).toBe('rust');
    expect(codeBlockLanguageFromDom(pre('<pre><code class="hljs lang-go"></code></pre>'))).toBe('go');
    expect(codeBlockLanguageFromDom(pre('<pre class="language-c++"><code></code></pre>'))).toBe('c++');
    expect(codeBlockLanguageFromDom(pre('<pre data-language="a b"><code></code></pre>'))).toBe('');
    expect(codeBlockLanguageFromDom(pre('<pre><code class="highlight"></code></pre>'))).toBe('');
  });
});
