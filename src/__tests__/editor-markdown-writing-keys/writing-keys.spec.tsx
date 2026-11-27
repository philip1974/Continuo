// @vitest-environment jsdom
// 真实 Crepe(不 mock):Markdown 编辑模式的写作按键 —— 选中文字粘贴 URL 成链接、⌘K / Ctrl+K 打开链接框、表格 Tab / ⇧Tab
//(第四十七轮审计 B7 / B9)。见同目录 README.md。
import React from 'react';
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { Crepe } from '@milkdown/crepe';
import { undo } from '@milkdown/kit/prose/history';
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
    // 原文件没有自动链接:与地址同文的链接裸写(GFM 自动链接文字,同纯文本里打的写法)
    expect(crepe.getMarkdown()).toBe('Go https://a.com now\n');
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

// 第五十二轮审计 A2:在空格前回车拆段 → 新段段首空白去掉(不保存成 `&#x20;tail`)
describe('回车拆段:新段段首空白', () => {
  /** 光标放在 needle 之后按回车(真实按键,经 Milkdown 的段落 / 列表项 / 引用拆分)。 */
  function enterAfter(view: EditorView, needle: string): void {
    select(view, posOf(view, needle) + needle.length);
    press(view, { key: 'Enter' });
  }

  it('段落:空格前回车 → 新段不以空格开头,保存不出现 `&#x20;`;一次撤销回到原样', async () => {
    const md = 'Para with *em* BETA tail\n';
    const { crepe, view } = await open(md);
    enterAfter(view, 'BETA');
    expect(view.state.doc.child(1).textContent).toBe('tail');
    expect(view.state.selection.$from.parentOffset).toBe(0);
    expect(crepe.getMarkdown()).toBe('Para with *em* BETA\n\ntail\n');
    view.dispatch(view.state.tr.insertText('X'));
    expect(crepe.getMarkdown()).toBe('Para with *em* BETA\n\nXtail\n');
    undo(view.state, view.dispatch);
    undo(view.state, view.dispatch);
    expect(crepe.getMarkdown()).toBe(md);
    // 多个空格 / 制表符一并去掉
    const b = await open('a  \t  b\n');
    enterAfter(b.view, 'a');
    expect(b.crepe.getMarkdown()).toBe('a\n\nb\n');
  });

  it('列表项、引用块里拆段同样去掉', async () => {
    const a = await open('- item one two\n');
    enterAfter(a.view, 'one');
    expect(a.crepe.getMarkdown()).toBe('- item one\n- two\n');
    const b = await open('> quote x y\n');
    enterAfter(b.view, 'x');
    expect(b.crepe.getMarkdown()).toBe('> quote x\n>\n> y\n');
  });

  it('空格后回车:前一段段尾空格照旧(Markdown 段尾空白不显示);全角空格不是 Markdown 空白,保留;代码块里不动', async () => {
    const a = await open('Para BETA tail\n');
    enterAfter(a.view, 'BETA ');
    expect(a.view.state.doc.child(1).textContent).toBe('tail');
    const b = await open('中文\u3000后面\n');
    enterAfter(b.view, '中文');
    expect(b.view.state.doc.child(1).textContent).toBe('\u3000后面');
    expect(b.crepe.getMarkdown()).toBe('中文\n\n\u3000后面\n');
    const c = await open('```\nab  cd\n```\n');
    enterAfter(c.view, 'ab');
    expect(c.crepe.getMarkdown()).toBe('```\nab\n  cd\n```\n');
  });
});

// 第五十三轮审计 4:拆点落在行内代码里 → 空格是代码内容,不删;强调 / 链接 / 删除线里的段首空格保存后被 CommonMark 丢弃 → 照删
describe('回车拆段:新段段首是行内代码 / 强调 / 链接', () => {
  function enterAfter(view: EditorView, needle: string): void {
    select(view, posOf(view, needle) + needle.length);
    press(view, { key: 'Enter' });
  }

  it('行内代码里空格前回车 → 代码内容不变(保存 `` ` de` ``,重新打开仍是「 de」)', async () => {
    const a = await open('Para `co de` x\n');
    enterAfter(a.view, 'co');
    expect(a.view.state.doc.child(1).textContent).toBe(' de x');
    const saved = a.crepe.getMarkdown();
    expect(saved).toBe('Para `co`\n\n` de` x\n');
    const b = await open(saved);
    expect(b.view.state.doc.child(1).textContent).toBe(' de x');
    // 强调里套行内代码:同样按代码内容保留
    const c = await open('Para *em `co de`* x\n');
    enterAfter(c.view, 'co');
    expect(c.view.state.doc.child(1).textContent).toBe(' de x');
  });

  it('强调 / 加粗 / 链接 / 删除线里空格前回车 → 段首空格照删(否则保存成段首空格、重新打开就没了)', async () => {
    for (const [md, needle, out] of [
      ['Para *em ph* x\n', 'em', 'Para *em*\n\n*ph* x\n'],
      ['Para **st ro** x\n', 'st', 'Para **st**\n\n**ro** x\n'],
      ['Para [li nk](https://a.com) x\n', 'li', 'Para [li](https://a.com)\n\n[nk](https://a.com) x\n'],
      ['Para ~~de l~~ x\n', 'de', 'Para ~~de~~\n\n~~l~~ x\n'],
    ] as const) {
      const { crepe, view } = await open(md);
      enterAfter(view, needle);
      expect(view.state.doc.child(1).textContent.startsWith(' ')).toBe(false);
      expect(crepe.getMarkdown()).toBe(out);
    }
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
