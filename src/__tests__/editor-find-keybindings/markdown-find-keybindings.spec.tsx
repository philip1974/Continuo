// @vitest-environment jsdom
// BDD: editor-find-keybindings 第 6 条 —— Markdown 编辑 / 预览(Milkdown,真实 Crepe)里的查找 / 查找下一个·上一个同样经命令注册表
// 分发:改键后旧键失效(交给新绑定的命令,不被吞)、新键生效;查找条里同样生效;代码块里的 CodeMirror 不算。见同目录 README。
// jsdom 平台非 mac(useCommandHotkeys 按 Ctrl 分发)。
import React from 'react';
import { act, cleanup, fireEvent, render, renderHook, screen } from '@testing-library/react';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Crepe as CrepeType } from '@milkdown/crepe';
import { bootCorePlugins, shutdownCorePlugins } from '../../core-plugins';
import { coApp } from '../../plugins/co-app';
import { useCommandHotkeys, winningCommandFor } from '../../plugins/command-palette/useCommandHotkeys';
import { useKeybindingsStore } from '../../plugins/keybindings/keybindings-store';
import { MilkdownEditor } from '../../panels/Editor/MilkdownEditor';
import { clearMarkdownFindSessions } from '../../panels/Editor/markdown-find';
import { isEditorElement, MARKDOWN_EDITOR_ATTR, TEXT_EDITOR_ATTR } from '../../lib/editor-text-focus';
import { t } from '../../i18n';
import { createTab, useEditorStore } from '../../stores/editor.store';

const mocks = vi.hoisted(() => ({ instances: [] as CrepeType[] }));
vi.mock('@milkdown/crepe', async (importOriginal) => {
  const mod = await importOriginal<typeof import('@milkdown/crepe')>();
  class RecordingCrepe extends mod.Crepe {
    constructor(...args: ConstructorParameters<typeof mod.Crepe>) {
      super(...args);
      mocks.instances.push(this);
    }
  }
  return { ...mod, Crepe: RecordingCrepe };
});
vi.mock('../../plugins/settings/values-store', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useSettingValue: <T,>(_id: string, fallback: T) => fallback,
}));
vi.mock('../../lib/co-api', () => ({ coApi: { fs: { readImage: vi.fn() } } }));

const TAB = '/w/a.md';
const DOC = '# Title\n\nalpha one alpha\n\nalpha two\n';

beforeAll(() => bootCorePlugins());
afterAll(() => shutdownCorePlugins());

beforeEach(() => {
  useKeybindingsStore.setState({ overrides: {} });
  useEditorStore.setState({
    tabs: [createTab(TAB, '')],
    activeTabId: TAB,
    groups: [{ id: 'editor', tabIds: [TAB], activeTabId: TAB }],
    activeGroupId: 'editor',
    viewRefs: new Map(),
  });
  Range.prototype.getClientRects ??= () => [] as unknown as DOMRectList;
  Range.prototype.getBoundingClientRect ??= () => new DOMRect();
});
afterEach(() => {
  cleanup();
  mocks.instances.length = 0;
  clearMarkdownFindSessions();
});

async function mount(readonly = false) {
  renderHook(() => useCommandHotkeys(coApp.commands));
  const utils = render(<MilkdownEditor tabId={TAB} fileName={TAB} defaultValue={DOC} readonly={readonly} />);
  for (let i = 0; i < 100; i++) {
    try {
      const view = mocks.instances.at(-1)?.editor.ctx.get<{ state?: unknown }, 'editorView'>('editorView');
      if (view?.state) {
        await act(async () => {
          await new Promise((r) => setTimeout(r, 0));
        });
        const pm = utils.container.querySelector<HTMLElement>('.ProseMirror')!;
        act(() => pm.focus());
        return { ...utils, pm };
      }
    } catch {
      /* 未就绪 */
    }
    await act(async () => {
      await new Promise((r) => setTimeout(r, 10));
    });
  }
  throw new Error('Crepe 未挂载');
}

function press(target: EventTarget, init: KeyboardEventInit): KeyboardEvent {
  const e = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
  act(() => {
    target.dispatchEvent(e);
  });
  return e;
}

const CTRL_F: KeyboardEventInit = { key: 'f', code: 'KeyF', keyCode: 70, ctrlKey: true };
const CTRL_SHIFT_J: KeyboardEventInit = { key: 'J', code: 'KeyJ', keyCode: 74, ctrlKey: true, shiftKey: true };
const CTRL_J: KeyboardEventInit = { key: 'j', code: 'KeyJ', keyCode: 74, ctrlKey: true };
const F3: KeyboardEventInit = { key: 'F3', code: 'F3', keyCode: 114 };

const queryFindInput = () => screen.queryByRole('textbox', { name: t('editor.cm.find') }) as HTMLInputElement | null;
const countText = () => screen.getByRole('status').textContent;

describe('Markdown 编辑 / 预览里查找类按键经注册表分发', () => {
  it('默认键不回退:正文 Ctrl+F 打开查找条并聚焦(事件被拦下);查找框里 F3 跳下一个', async () => {
    const { pm } = await mount();
    expect(press(pm, CTRL_F).defaultPrevented).toBe(true);
    const input = queryFindInput()!;
    expect(document.activeElement).toBe(input);
    act(() => {
      fireEvent.change(input, { target: { value: 'alpha' } });
    });
    expect(countText()).toBe(t('editor.find.match_count', { n: 1, total: '3' }));
    expect(press(input, F3).defaultPrevented).toBe(true);
    expect(countText()).toBe(t('editor.find.match_count', { n: 2, total: '3' }));
  });

  it('复现:把「查找」改到 Ctrl+Shift+J → Ctrl+F 不再打开查找条,Ctrl+Shift+J 打开(编辑模式与预览模式)', async () => {
    useKeybindingsStore.setState({ overrides: { 'actions.find': 'mod+shift+j' } });
    for (const readonly of [false, true]) {
      const { pm, unmount } = await mount(readonly);
      press(pm, CTRL_F);
      expect(queryFindInput(), `readonly=${readonly}`).toBeNull();
      press(pm, CTRL_SHIFT_J);
      expect(document.activeElement, `readonly=${readonly}`).toBe(queryFindInput());
      unmount();
      mocks.instances.length = 0;
      clearMarkdownFindSessions();
    }
  });

  it('Ctrl+F 改绑给别的命令(切换侧栏)→ Markdown 里按 Ctrl+F 交给它,不被查找吞掉', async () => {
    const overrides = { 'actions.find': 'mod+shift+j', 'explorer.toggleSidebar': 'mod+f' };
    useKeybindingsStore.setState({ overrides });
    const { pm } = await mount();
    const e = press(pm, CTRL_F);
    expect(winningCommandFor(e, coApp.commands.getAll(), 'other', overrides)?.id).toBe('explorer.toggleSidebar');
    expect(queryFindInput()).toBeNull();
  });

  it('把查找下一个改到 Ctrl+J → F3 失效(不跳、不拦),Ctrl+J 生效(正文与查找框里)', async () => {
    useKeybindingsStore.setState({ overrides: { 'editor.action.nextMatchFindAction': 'mod+j' } });
    const { pm } = await mount();
    press(pm, CTRL_F);
    const input = queryFindInput()!;
    act(() => {
      fireEvent.change(input, { target: { value: 'alpha' } });
    });
    expect(countText()).toBe(t('editor.find.match_count', { n: 1, total: '3' }));
    expect(press(input, F3).defaultPrevented).toBe(false);
    expect(countText()).toBe(t('editor.find.match_count', { n: 1, total: '3' }));
    press(input, CTRL_J);
    expect(countText()).toBe(t('editor.find.match_count', { n: 2, total: '3' }));
    act(() => pm.focus());
    expect(press(pm, F3).defaultPrevented).toBe(false);
    press(pm, CTRL_J);
    expect(countText()).toBe(t('editor.find.match_count', { n: 3, total: '3' }));
  });
});

describe('editorFocus 判定', () => {
  it('Markdown 编辑器(外层标记)里成立;其中代码块的 CodeMirror 不算;代码编辑器照旧成立', () => {
    const md = document.body.appendChild(document.createElement('div'));
    md.setAttribute(MARKDOWN_EDITOR_ATTR, '');
    const body = md.appendChild(document.createElement('p'));
    const block = md.appendChild(document.createElement('div'));
    block.className = 'cm-editor';
    const blockContent = block.appendChild(document.createElement('div'));
    const code = document.body.appendChild(document.createElement('div'));
    code.className = 'cm-editor';
    code.setAttribute(TEXT_EDITOR_ATTR, '');
    const codeContent = code.appendChild(document.createElement('div'));
    const elsewhere = document.body.appendChild(document.createElement('input'));
    expect(isEditorElement(body)).toBe(true);
    expect(isEditorElement(blockContent)).toBe(false);
    expect(isEditorElement(codeContent)).toBe(true);
    expect(isEditorElement(elsewhere)).toBe(false);
    md.remove();
    code.remove();
    elsewhere.remove();
  });
});
