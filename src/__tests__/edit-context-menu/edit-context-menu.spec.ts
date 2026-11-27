// BDD:可编辑元素原生右键菜单(剪切 / 复制 / 粘贴 / 全选;代码编辑器里为 VSCode 编辑器右键菜单)。见同目录 README。
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { buildFromTemplate, popup, localeRef, sendMenuCommand } = vi.hoisted(() => ({
  buildFromTemplate: vi.fn(),
  popup: vi.fn(),
  localeRef: { current: 'en' as 'en' | 'zh' | 'ko' },
  sendMenuCommand: vi.fn(() => true),
}));

vi.mock('electron', () => ({
  Menu: { buildFromTemplate },
}));

vi.mock('../../../electron/main/lib/menu-command', () => ({ sendMenuCommand }));

vi.mock('../../../electron/main/services/settings.service', () => ({
  getCurrentLocale: () => localeRef.current,
}));

import { installEditContextMenu } from '../../../electron/main/edit-context-menu';
import { getMainT } from '../../../electron/main/i18n';
import { setMenuKeybindings } from '../../../electron/main/menu-keybindings';
import { READ_EDITOR_CONTEXT_MENU_SCRIPT } from '../../../electron/shared/editor-context-menu';
import { MENU_COMMAND_IDS } from '../../../electron/shared/window-channels';

interface Flags {
  canCut: boolean;
  canCopy: boolean;
  canPaste: boolean;
  canSelectAll: boolean;
}

const ALL: Flags = { canCut: true, canCopy: true, canPaste: true, canSelectAll: true };
const NONE: Flags = { canCut: false, canCopy: false, canPaste: false, canSelectAll: false };

function makeWindow() {
  const webContents = new EventEmitter();
  const win = { webContents };
  installEditContextMenu(win as never, getMainT);
  return {
    win,
    rightClick: (params: { isEditable: boolean; selectionText: string; editFlags: Flags }) =>
      webContents.emit('context-menu', { preventDefault: vi.fn() }, params),
  };
}

type Item = { role?: string; type?: string; label?: string; enabled?: boolean };
const lastTemplate = (): Item[] => buildFromTemplate.mock.lastCall![0] as Item[];

beforeEach(() => {
  buildFromTemplate.mockReset();
  popup.mockReset();
  sendMenuCommand.mockClear();
  buildFromTemplate.mockImplementation(() => ({ popup }));
  localeRef.current = 'en';
});

describe('可编辑元素右键 → 原生编辑菜单', () => {
  it('可编辑元素:剪切 / 复制 / 粘贴 / 分隔 / 全选(role 项),弹在该窗口', () => {
    const { win, rightClick } = makeWindow();
    rightClick({ isEditable: true, selectionText: 'abc', editFlags: ALL });

    expect(lastTemplate().map((i) => i.role ?? i.type)).toEqual([
      'cut',
      'copy',
      'paste',
      'separator',
      'selectAll',
    ]);
    expect(lastTemplate().map((i) => i.label).filter(Boolean)).toEqual([
      'Cut',
      'Copy',
      'Paste',
      'Select All',
    ]);
    expect(popup).toHaveBeenCalledWith({ window: win });
  });

  it('可用性跟随 editFlags(如只读编辑器:可复制 / 全选,不可剪切 / 粘贴)', () => {
    const { rightClick } = makeWindow();
    rightClick({
      isEditable: true,
      selectionText: 'x',
      editFlags: { canCut: false, canCopy: true, canPaste: false, canSelectAll: true },
    });
    const enabled = Object.fromEntries(
      lastTemplate()
        .filter((i) => i.role)
        .map((i) => [i.role, i.enabled]),
    );
    expect(enabled).toEqual({ cut: false, copy: true, paste: false, selectAll: true });
    expect(popup).toHaveBeenCalledTimes(1);
  });

  it('可编辑但四项都不可用 → 不弹', () => {
    const { rightClick } = makeWindow();
    rightClick({ isEditable: true, selectionText: '', editFlags: NONE });
    expect(popup).not.toHaveBeenCalled();
  });

  it('非可编辑、有选中文本 → 只给「复制」', () => {
    const { rightClick } = makeWindow();
    rightClick({
      isEditable: false,
      selectionText: 'hello',
      editFlags: { ...NONE, canCopy: true },
    });
    expect(lastTemplate().map((i) => i.role)).toEqual(['copy']);
    expect(popup).toHaveBeenCalledTimes(1);
  });

  it('非可编辑、无选区 → 不弹', () => {
    const { rightClick } = makeWindow();
    rightClick({ isEditable: false, selectionText: '', editFlags: { ...NONE, canCopy: true, canSelectAll: true } });
    expect(buildFromTemplate).not.toHaveBeenCalled();
    expect(popup).not.toHaveBeenCalled();
  });

  it('文案按当前语言(每次右键时取):切到中文 / 韩文后立即生效', () => {
    const { rightClick } = makeWindow();
    localeRef.current = 'zh';
    rightClick({ isEditable: true, selectionText: 'a', editFlags: ALL });
    expect(lastTemplate().map((i) => i.label).filter(Boolean)).toEqual(['剪切', '复制', '粘贴', '全选']);

    localeRef.current = 'ko';
    rightClick({ isEditable: true, selectionText: 'a', editFlags: ALL });
    expect(lastTemplate().map((i) => i.label).filter(Boolean)).toEqual([
      '잘라내기',
      '복사',
      '붙여넣기',
      '모두 선택',
    ]);
  });

  it('main 入口在 browser-window-created(主窗与 popout 子窗统一)为每个窗口挂上', () => {
    const src = readFileSync(
      path.resolve(__dirname, '../../../electron/main/index.ts'),
      'utf8',
    );
    const handler = src.slice(src.indexOf("app.on('browser-window-created'"));
    expect(handler.slice(0, handler.indexOf('\n});'))).toContain(
      'installEditContextMenu(win, getMainT)',
    );
  });
});

// ── 代码编辑器右键:VSCode 编辑器右键菜单(更改所有匹配项 / 格式化文档 / ─ / 剪切 / 复制 / 粘贴 / ─ / 命令面板...)──

describe('代码编辑器右键 → VSCode 编辑器右键菜单项', () => {
  type CmdItem = Item & { id?: string; accelerator?: string; registerAccelerator?: boolean; click?: () => void };
  const editorTemplate = (): CmdItem[] => buildFromTemplate.mock.lastCall![0] as CmdItem[];
  const shape = () => editorTemplate().map((i) => i.id ?? i.role ?? i.type);

  function editorWindow(mark: unknown | Error) {
    const webContents = new EventEmitter();
    const win = { webContents, isDestroyed: () => false };
    installEditContextMenu(win as never, getMainT);
    const executeJavaScript = vi.fn(async () => {
      if (mark instanceof Error) throw mark;
      return mark;
    });
    return {
      win,
      executeJavaScript,
      rightClick: (params: { isEditable: boolean; selectionText: string; editFlags: Flags }) =>
        webContents.emit('context-menu', { preventDefault: vi.fn() }, { ...params, frame: { executeJavaScript } }),
    };
  }

  it('标记 code:更改所有匹配项 / ─ / 剪切 / 复制 / 粘贴 / ─ / 命令面板...(没有全选),弹在该窗口', async () => {
    const { win, rightClick, executeJavaScript } = editorWindow('code');
    rightClick({ isEditable: true, selectionText: '', editFlags: { ...ALL, canCut: false, canCopy: false } });
    await vi.waitFor(() => expect(popup).toHaveBeenCalledWith({ window: win }));
    expect(executeJavaScript).toHaveBeenCalledWith(READ_EDITOR_CONTEXT_MENU_SCRIPT);
    expect(shape()).toEqual([
      'editor.action.changeAll',
      'separator',
      'cut',
      'copy',
      'paste',
      'separator',
      'workbench.action.showCommands',
    ]);
    expect(editorTemplate().map((i) => i.label).filter(Boolean)).toEqual([
      'Change All Occurrences',
      'Cut',
      'Copy',
      'Paste',
      'Command Palette...',
    ]);
    const enabled = Object.fromEntries(editorTemplate().filter((i) => i.role).map((i) => [i.role, i.enabled]));
    expect(enabled).toEqual({ cut: false, copy: false, paste: true });
  });

  it('标记 code-format(有格式化程序:JSON)→ 更改所有匹配项之后是格式化文档', async () => {
    const { rightClick } = editorWindow('code-format');
    rightClick({ isEditable: true, selectionText: 'a', editFlags: ALL });
    await vi.waitFor(() => expect(popup).toHaveBeenCalled());
    expect(shape().slice(0, 3)).toEqual(['editor.action.changeAll', 'editor.action.formatDocument', 'separator']);
  });

  it('点击编辑器项 → 菜单命令发给该窗口(popout 子窗由 sendMenuCommand 转给其主窗)', async () => {
    const { win, rightClick } = editorWindow('code-format');
    rightClick({ isEditable: true, selectionText: 'a', editFlags: ALL });
    await vi.waitFor(() => expect(popup).toHaveBeenCalled());
    for (const id of ['editor.action.changeAll', 'editor.action.formatDocument', 'workbench.action.showCommands']) {
      editorTemplate().find((i) => i.id === id)!.click!();
      expect(sendMenuCommand).toHaveBeenLastCalledWith(win, id);
    }
  });

  it('键位显示同应用菜单(renderer 推送的生效键位,只作显示)', async () => {
    setMenuKeybindings({ 'editor.action.changeAll': 'meta+f2', 'workbench.action.showCommands': 'meta+shift+p' });
    try {
      const { rightClick } = editorWindow('code');
      rightClick({ isEditable: true, selectionText: '', editFlags: ALL });
      await vi.waitFor(() => expect(popup).toHaveBeenCalled());
      const change = editorTemplate().find((i) => i.id === 'editor.action.changeAll')!;
      expect(change.accelerator).toMatch(/F2$/);
      expect(change.registerAccelerator).toBe(false);
      expect(editorTemplate().find((i) => i.id === 'workbench.action.showCommands')!.accelerator).toMatch(/P$/);
    } finally {
      setMenuKeybindings({});
    }
  });

  it('三语文案照抄 VSCode', async () => {
    const { rightClick } = editorWindow('code-format');
    localeRef.current = 'zh';
    rightClick({ isEditable: true, selectionText: '', editFlags: ALL });
    await vi.waitFor(() => expect(popup).toHaveBeenCalledTimes(1));
    expect(editorTemplate().map((i) => i.label).filter(Boolean)).toEqual(['更改所有匹配项', '格式化文档', '剪切', '复制', '粘贴', '命令面板...']);
    localeRef.current = 'ko';
    rightClick({ isEditable: true, selectionText: '', editFlags: ALL });
    await vi.waitFor(() => expect(popup).toHaveBeenCalledTimes(2));
    expect(editorTemplate().map((i) => i.label).filter(Boolean)).toEqual([
      '모든 항목 변경',
      '문서 서식',
      '잘라내기',
      '복사',
      '붙여넣기',
      '명령 팔레트...',
    ]);
  });

  it('无标记 / 读取失败 → 普通编辑菜单(含全选)', async () => {
    for (const mark of [null, 'bogus', new Error('frame gone')]) {
      popup.mockClear();
      const { rightClick } = editorWindow(mark);
      rightClick({ isEditable: true, selectionText: '', editFlags: ALL });
      await vi.waitFor(() => expect(popup).toHaveBeenCalledTimes(1));
      expect(lastTemplate().map((i) => i.role ?? i.type)).toEqual(['cut', 'copy', 'paste', 'separator', 'selectAll']);
    }
  });

  it('两个编辑器命令登记为菜单命令(renderer 只执行登记过的 id)', () => {
    expect(MENU_COMMAND_IDS).toEqual(expect.arrayContaining(['editor.action.changeAll', 'editor.action.formatDocument', 'workbench.action.showCommands']));
  });
});
