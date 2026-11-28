// @vitest-environment jsdom
// 另存为 / 新建无标题文件的命令、默认键、菜单项、终端让键(行为见同目录 README)。
// 被测:panels/Editor/editor-commands.ts、electron/main/app-menu.ts、electron/shared/window-channels.ts、panels/Terminal/terminal-hotkeys.ts。
import { describe, expect, it, vi } from 'vitest';
import type { MenuItemConstructorOptions } from 'electron';

const mocks = vi.hoisted(() => ({ sendMenuCommand: vi.fn(() => true) }));
vi.mock('electron', () => ({ app: { name: 'Continuo' }, BrowserWindow: class {} }));
vi.mock('../../../electron/main/lib/menu-command', () => ({ sendMenuCommand: mocks.sendMenuCommand }));

import { appMenuTemplate } from '../../../electron/main/app-menu';
import { MENU_COMMAND_IDS } from '../../../electron/shared/window-channels';
import { editorCommandSpecs, NEW_UNTITLED_FILE_COMMAND, SAVE_AS_COMMAND } from '../../panels/Editor/editor-commands';
import {
  WORKBENCH_NEW_UNTITLED_FILE_COMMAND,
  WORKBENCH_SAVE_AS_COMMAND,
  terminalYieldedCommandId,
} from '../../panels/Terminal/terminal-hotkeys';
import type { CommandSpec } from '../../plugins/registries/CommandRegistry';

type Item = MenuItemConstructorOptions;

describe('命令与默认键(对齐 VSCode)', () => {
  it.each(['mac', 'other'] as const)('%s:另存为 = mod+shift+s,新建无标题文本文件 = mod+n,带三语标题', (platform) => {
    const specs = editorCommandSpecs(platform);
    expect(specs.find((c) => c.id === 'workbench.action.files.saveAs')).toMatchObject({
      hotkey: 'mod+shift+s',
      titleKey: 'commands.file.save_as.title',
      categoryKey: 'commands.file.category',
    });
    expect(specs.find((c) => c.id === 'workbench.action.files.newUntitledFile')).toMatchObject({
      hotkey: 'mod+n',
      titleKey: 'commands.file.new_untitled.title',
    });
  });

  it('终端侧约定的命令常量与编辑器命令一致', () => {
    expect(WORKBENCH_SAVE_AS_COMMAND).toEqual(SAVE_AS_COMMAND);
    expect(WORKBENCH_NEW_UNTITLED_FILE_COMMAND).toEqual(NEW_UNTITLED_FILE_COMMAND);
  });
});

describe('文件菜单', () => {
  const t = (key: string): string => key;
  const actions = { newWindow: vi.fn(), openFolderInNewWindow: vi.fn(), reloadWindow: vi.fn(), openHelpLink: vi.fn(), showAbout: vi.fn() };
  const fileMenu = (): Item[] => {
    const m = appMenuTemplate(t as never, actions, true, () => undefined).find((x) => x.label === 'menu.file.label');
    return m!.submenu as Item[];
  };

  it('首项「新建文本文件」;保存 / 另存为… / 全部保存 同组;点击发对应命令', () => {
    const items = fileMenu();
    expect(items[0]).toMatchObject({ id: 'workbench.action.files.newUntitledFile', label: 'menu.file.new_text_file' });
    expect(items[1]?.label).toBe('menu.file.new_window');
    const i = items.findIndex((x) => x.id === 'workbench.action.files.save');
    expect(items.slice(i, i + 3).map((x) => x.id)).toEqual([
      'workbench.action.files.save',
      'workbench.action.files.saveAs',
      'workbench.action.files.saveAll',
    ]);
    items[i + 1]!.click!(items[i + 1] as never, {} as never, {} as never);
    expect(mocks.sendMenuCommand).toHaveBeenLastCalledWith({}, 'workbench.action.files.saveAs', false);
  });

  it('三个命令都在菜单命令白名单里(renderer 只执行白名单内的 id)', () => {
    for (const id of ['workbench.action.files.newUntitledFile', 'workbench.action.files.save', 'workbench.action.files.saveAs']) {
      expect(MENU_COMMAND_IDS).toContain(id);
    }
  });
});

describe('终端获焦时', () => {
  const registry = { getAll: (): readonly CommandSpec[] => [] };
  const key = (init: KeyboardEventInit) => new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });

  it('mac:⇧⌘S / ⌘N 让出给工作台', () => {
    expect(terminalYieldedCommandId(key({ key: 'S', metaKey: true, shiftKey: true }), 'mac', {}, registry)).toBe(
      'workbench.action.files.saveAs',
    );
    expect(terminalYieldedCommandId(key({ key: 'n', metaKey: true }), 'mac', {}, registry)).toBe(
      'workbench.action.files.newUntitledFile',
    );
  });

  it('Win / Linux:Ctrl+N / Ctrl+Shift+S 不带 Meta → 照常进 shell', () => {
    expect(terminalYieldedCommandId(key({ key: 'n', ctrlKey: true }), 'other', {}, registry)).toBeNull();
    expect(terminalYieldedCommandId(key({ key: 'S', ctrlKey: true, shiftKey: true }), 'other', {}, registry)).toBeNull();
  });
});
