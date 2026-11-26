// @vitest-environment jsdom
// BDD: workspace-search / 1 入口:命令「在文件中查找」⇧⌘F(无默认键冲突)、打开单例 search 面板(主窗落点)、编辑器单行选区带入
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const h = vi.hoisted(() => ({ openOrFocusPanel: vi.fn() }));
vi.mock('@/shell/dock/dock-api-ref', async (orig) => ({
  ...(await orig<typeof import('@/shell/dock/dock-api-ref')>()),
  openOrFocusPanel: h.openOrFocusPanel,
}));

import { bootCorePlugins, shutdownCorePlugins } from '@/core-plugins';
import { coApp } from '@/plugins/co-app';
import { __resetSearchForTest, useSearchStore } from '@/panels/Search/search-store';
import { MENU_COMMANDS } from '../../../electron/shared/window-channels';

const FIND_IN_FILES = 'workbench.action.findInFiles';

beforeEach(() => bootCorePlugins());
afterEach(async () => {
  await shutdownCorePlugins();
  __resetSearchForTest();
  document.body.innerHTML = '';
  vi.clearAllMocks();
});

const cmd = (id: string) => coApp.commands.getAll().find((c) => c.id === id);

describe('命令「在文件中查找」', () => {
  it('注册:默认键 mod+shift+f、三语标题、出现在命令面板(有 title / category)', () => {
    const c = cmd(FIND_IN_FILES)!;
    expect(c).toMatchObject({
      hotkey: 'mod+shift+f',
      titleKey: 'commands.search.find_in_files.title',
      categoryKey: 'commands.search.category',
    });
    expect(c.title.length).toBeGreaterThan(0);
  });

  it('默认键不与其它命令 / 应用菜单冲突', () => {
    const same = coApp.commands.getAll().filter((c) => c.hotkey?.toLowerCase() === 'mod+shift+f');
    expect(same.map((c) => c.id)).toEqual([FIND_IN_FILES]);
    expect(Object.values(MENU_COMMANDS)).not.toContain('CmdOrCtrl+Shift+F');
    const menu = ['index.ts', 'app-menu.ts']
      .map((f) => readFileSync(path.resolve(__dirname, '../../../electron/main', f), 'utf8'))
      .join('\n');
    expect(menu).not.toMatch(/accelerator: '(Shift\+CmdOrCtrl|CmdOrCtrl\+Shift)\+F'/);
  });

  it('执行:打开 / 激活单例 search 面板(不给 position → 主窗落点)并请求聚焦查询框', async () => {
    const before = useSearchStore.getState().focusRequest;
    await cmd(FIND_IN_FILES)!.fn();
    expect(h.openOrFocusPanel).toHaveBeenCalledWith('search', 'search', 'Search', 'panels.search.title');
    expect(useSearchStore.getState().focusRequest).toBe(before + 1);
  });

  function focusEditorWithSelection(text: string, from: number, to: number) {
    const editor = document.createElement('div');
    editor.className = 'cm-editor';
    const content = document.createElement('div');
    content.contentEditable = 'true';
    content.tabIndex = 0; // jsdom 不把 contenteditable 当可聚焦元素
    content.textContent = text;
    editor.append(content);
    document.body.append(editor);
    content.focus();
    const range = document.createRange();
    range.setStart(content.firstChild!, from);
    range.setEnd(content.firstChild!, to);
    const sel = document.getSelection()!;
    sel.removeAllRanges();
    sel.addRange(range);
  }

  it('焦点在编辑器且有单行选区 → 选区文本带入查询框', async () => {
    useSearchStore.getState().setPattern('old');
    focusEditorWithSelection('const hello = 1', 6, 11);
    await cmd(FIND_IN_FILES)!.fn();
    expect(useSearchStore.getState().pattern).toBe('hello');
  });

  it('多行选区 / 无选区 / 焦点不在编辑器 → 保留上次查询', async () => {
    useSearchStore.getState().setPattern('old');
    focusEditorWithSelection('a\nb', 0, 3);
    await cmd(FIND_IN_FILES)!.fn();
    expect(useSearchStore.getState().pattern).toBe('old');
    focusEditorWithSelection('abc', 1, 1);
    await cmd(FIND_IN_FILES)!.fn();
    expect(useSearchStore.getState().pattern).toBe('old');
    const input = document.createElement('input');
    input.value = 'xyz';
    document.body.append(input);
    input.focus();
    input.select();
    await cmd(FIND_IN_FILES)!.fn();
    expect(useSearchStore.getState().pattern).toBe('old');
  });
});

describe('F4 / ⇧F4', () => {
  it('注册下一个 / 上一个搜索结果命令(VSCode search.action.focusNext/PreviousSearchResult)', () => {
    expect(cmd('search.action.focusNextSearchResult')).toMatchObject({ hotkey: 'f4' });
    expect(cmd('search.action.focusPreviousSearchResult')).toMatchObject({ hotkey: 'shift+f4' });
  });
});
