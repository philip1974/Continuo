// @vitest-environment jsdom
// 真实 Crepe(不 mock):Markdown 编辑模式的写作按键 —— 选中文字粘贴 URL 成链接、⌘K / Ctrl+K 打开链接框、表格 Tab / ⇧Tab
//(第四十七轮审计 B7 / B9)。见同目录 README.md。
import React from 'react';
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { Crepe } from '@milkdown/crepe';
import { TextSelection } from '@milkdown/kit/prose/state';
import type { EditorView } from '@milkdown/kit/prose/view';
import { markdownWritingKeys, pastedUrl } from '../../panels/Editor/milkdown-writing-keys';
import { configureMarkdownStyle } from '../../panels/Editor/milkdown-markdown-style';
import { MilkdownEditor } from '../../panels/Editor/MilkdownEditor';

const instances = vi.hoisted(() => [] as Crepe[]);

vi.mock('@milkdown/crepe', async (importOriginal) => {
  const mod = await importOriginal<typeof import('@milkdown/crepe')>();
  class RecordingCrepe extends mod.Crepe {
    constructor(...args: ConstructorParameters<typeof mod.Crepe>) {
      super(...args);
      instances.push(this);
    }
  }
  return { ...mod, Crepe: RecordingCrepe };
});

vi.mock('../../plugins/settings/values-store', () => ({
  useSettingValue: <T,>(_id: string, fallback: T) => fallback,
}));

beforeAll(() => {
  // jsdom 没有布局:Crepe 浮层 / 虚拟光标定位要用
  const rect = (): DOMRect => ({ x: 0, y: 0, top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0, toJSON: () => ({}) });
  Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
  Range.prototype.getBoundingClientRect = rect;
});

const editors: Crepe[] = [];

async function open(markdown: string, readonly = false): Promise<{ crepe: Crepe; view: EditorView }> {
  const root = document.createElement('div');
  document.body.appendChild(root);
  const crepe = new Crepe({
    root,
    defaultValue: markdown,
    features: { [Crepe.Feature.ImageBlock]: false, [Crepe.Feature.Latex]: false },
  });
  configureMarkdownStyle(crepe, markdown);
  crepe.editor.use(markdownWritingKeys);
  if (readonly) crepe.setReadonly(true);
  editors.push(crepe);
  await crepe.create();
  return { crepe, view: crepe.editor.ctx.get<EditorView, 'editorView'>('editorView') };
}

afterEach(async () => {
  cleanup();
  instances.length = 0;
  for (const crepe of editors.splice(0)) await crepe.destroy();
  document.body.innerHTML = '';
});

function posOf(view: EditorView, needle: string): number {
  let pos = -1;
  view.state.doc.descendants((node, p) => {
    if (pos < 0 && node.isText && node.text!.includes(needle)) pos = p + node.text!.indexOf(needle);
  });
  if (pos < 0) throw new Error(`找不到 ${needle}`);
  return pos;
}

function select(view: EditorView, from: number, to = from): void {
  view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, from, to)));
}

function selectText(view: EditorView, needle: string): void {
  const from = posOf(view, needle);
  select(view, from, from + needle.length);
}

function press(view: EditorView, init: KeyboardEventInit): KeyboardEvent {
  const e = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
  view.dom.dispatchEvent(e);
  return e;
}

function paste(view: EditorView, text: string): Event {
  const e = new Event('paste', { bubbles: true, cancelable: true }) as Event & { clipboardData: unknown };
  e.clipboardData = { files: [], types: ['text/plain'], getData: (t: string) => (t === 'text/plain' ? text : '') };
  view.dom.dispatchEvent(e);
  return e;
}

function linkEditor(): { shown: boolean; value: string | undefined } {
  const el = document.querySelector('.milkdown-link-edit');
  return { shown: el?.getAttribute('data-show') === 'true', value: el?.querySelector('input')?.value };
}

async function flush(): Promise<void> {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 20));
  });
}

describe('选中文字后粘贴 URL', () => {
  it('给选区加链接,选中的文字保留', async () => {
    const { crepe, view } = await open('See the documentation please\n');
    selectText(view, 'documentation');
    paste(view, '  https://example.com/docs\n');
    expect(crepe.getMarkdown()).toBe('See the [documentation](https://example.com/docs) please\n');
  });

  it('粘贴后光标在链接末尾,接着输入的文字不替换链接文字、也不并进链接(第四十八轮审计 A6)', async () => {
    const { crepe, view } = await open('See the documentation please\n');
    selectText(view, 'documentation');
    paste(view, 'https://example.com/docs');
    expect(view.state.selection.empty).toBe(true);
    view.dispatch(view.state.tr.insertText('X'));
    expect(crepe.getMarkdown()).toBe('See the [documentation](https://example.com/docs)X please\n');
  });

  it('没有选区、粘贴的不是单个 URL、或在行内代码里 → 照常粘贴(替换选区 / 插入文字)', async () => {
    const { crepe, view } = await open('See the documentation please and `code here`\n');
    selectText(view, 'documentation');
    paste(view, 'not a url');
    expect(crepe.getMarkdown()).toContain('See the not a url please');
    selectText(view, 'code');
    paste(view, 'https://example.com');
    expect(crepe.getMarkdown()).not.toContain('](https://example.com)');
  });

  it('识别规则:http(s) / ftp / file 地址与 mailto,中间不得有空白', () => {
    expect(pastedUrl('https://example.com/a?b=1#c')).toBe('https://example.com/a?b=1#c');
    expect(pastedUrl(' mailto:me@example.com ')).toBe('mailto:me@example.com');
    expect(pastedUrl('file:///tmp/a.md')).toBe('file:///tmp/a.md');
    expect(pastedUrl('https://a.com b')).toBeNull();
    expect(pastedUrl('example.com')).toBeNull();
    expect(pastedUrl('javascript:alert(1)')).toBeNull();
  });

  it('只读预览里不处理', async () => {
    const { crepe, view } = await open('See the documentation please\n', true);
    selectText(view, 'documentation');
    paste(view, 'https://example.com/docs');
    expect(crepe.getMarkdown()).toBe('See the documentation please\n');
  });
});

describe('⌘K / Ctrl+K 打开链接框', () => {
  it('有选区 → 链接框打开,确认后选区成链接;按键不再交给全局快捷键', async () => {
    const { crepe, view } = await open('See the documentation please\n');
    selectText(view, 'documentation');
    // jsdom 的 navigator.platform 非 mac:Mod = Ctrl(mac 上是 ⌘,由 e2e 覆盖)
    press(view, { key: 'k', ctrlKey: true });
    await flush();
    expect(linkEditor().shown).toBe(true);
    expect(linkEditor().value).toBe('');
    const input = document.querySelector<HTMLInputElement>('.milkdown-link-edit input')!;
    await act(async () => {
      input.value = 'https://example.com/docs';
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });
    expect(crepe.getMarkdown()).toBe('See the [documentation](https://example.com/docs) please\n');
    // 确认后光标收到链接末尾:接着输入不替换链接文字、不并进链接(第四十八轮审计 A6)
    expect(view.state.selection.empty).toBe(true);
    view.dispatch(view.state.tr.insertText('X'));
    expect(crepe.getMarkdown()).toBe('See the [documentation](https://example.com/docs)X please\n');
  });

  it('没有选区 → 确认后插入地址作链接文字,接着输入的文字不并进链接', async () => {
    const { crepe, view } = await open('Go now\n');
    select(view, posOf(view, 'now'));
    press(view, { key: 'k', ctrlKey: true });
    await flush();
    const input = document.querySelector<HTMLInputElement>('.milkdown-link-edit input')!;
    await act(async () => {
      input.value = 'https://a.com';
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });
    view.dispatch(view.state.tr.insertText(' '));
    expect(crepe.getMarkdown()).toBe('Go <https://a.com> now\n');
  });

  it('光标在已有链接里 → 编辑该链接(框里是原地址,范围是整个链接)', async () => {
    const { view } = await open('Go [home page](https://a.com) now\n');
    select(view, posOf(view, 'home') + 2);
    press(view, { key: 'k', ctrlKey: true });
    await flush();
    expect(linkEditor()).toEqual({ shown: true, value: 'https://a.com' });
    expect(view.state.selection.from).toBe(posOf(view, 'home page'));
    expect(view.state.selection.to).toBe(posOf(view, 'home page') + 'home page'.length);
  });

  it('按键被编辑器处理(preventDefault);只读预览里不处理', async () => {
    const a = await open('text\n');
    select(a.view, 2);
    expect(press(a.view, { key: 'k', ctrlKey: true }).defaultPrevented).toBe(true);
    const b = await open('text\n', true);
    select(b.view, 2);
    expect(press(b.view, { key: 'k', ctrlKey: true }).defaultPrevented).toBe(false);
  });
});

const TABLE = '| a | b |\n| - | - |\n| c | d |\n';

describe('表格里 Tab / ⇧Tab', () => {
  it('最后一格 Tab → 末尾加一行并进入其首格(不在格内插空格)', async () => {
    const { crepe, view } = await open(TABLE);
    select(view, posOf(view, 'd') + 1);
    expect(press(view, { key: 'Tab' }).defaultPrevented).toBe(true);
    view.dispatch(view.state.tr.insertText('X'));
    expect(crepe.getMarkdown()).toBe('| a | b |\n| - | - |\n| c | d |\n| X |   |\n');
  });

  it('其余格 Tab → 下一格(选中格内文字);⇧Tab → 上一格;首格 ⇧Tab 不动', async () => {
    const { crepe, view } = await open(TABLE);
    select(view, posOf(view, 'a') + 1);
    press(view, { key: 'Tab' });
    view.dispatch(view.state.tr.insertText('1'));
    press(view, { key: 'Tab', shiftKey: true });
    view.dispatch(view.state.tr.insertText('2'));
    const before = view.state.selection.from;
    expect(press(view, { key: 'Tab', shiftKey: true }).defaultPrevented).toBe(true);
    expect(view.state.selection.from).toBe(before);
    expect(crepe.getMarkdown()).toBe('| 2 | 1 |\n| - | - |\n| c | d |\n');
  });

  it('表格外的 Tab 照旧交给缩进 / 列表', async () => {
    const { crepe, view } = await open('- one\n- two\n');
    select(view, posOf(view, 'two'));
    press(view, { key: 'Tab' });
    expect(crepe.getMarkdown()).toBe('- one\n  - two\n');
  });
});

describe('MilkdownEditor 接上了写作按键', () => {
  async function waitMounted(): Promise<Crepe> {
    for (let i = 0; i < 100; i++) {
      const crepe = instances.at(-1);
      try {
        if (crepe && crepe.editor.ctx.get<{ state?: unknown }, 'editorView'>('editorView').state) {
          await flush();
          return crepe;
        }
      } catch {
        /* 尚未就绪 */
      }
      await flush();
    }
    throw new Error('Crepe 未挂载');
  }

  it('表格末格 Tab 加行、选中文字粘贴 URL 成链接', async () => {
    render(<MilkdownEditor tabId="/t.md" defaultValue={`${TABLE}\nSee docs here\n`} />);
    const crepe = await waitMounted();
    const view = crepe.editor.ctx.get<EditorView, 'editorView'>('editorView');
    select(view, posOf(view, 'd') + 1);
    press(view, { key: 'Tab' });
    selectText(view, 'docs');
    paste(view, 'https://example.com');
    expect(crepe.getMarkdown()).toBe('| a | b |\n| - | - |\n| c | d |\n|   |   |\n\nSee [docs](https://example.com) here\n');
  });
});
