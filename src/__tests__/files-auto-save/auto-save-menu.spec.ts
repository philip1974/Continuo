// BDD: files-auto-save 第 3 / 4 条 —— 文件菜单「自动保存」勾选项(勾选 = files.autoSave ≠ off,点击 = toggleAutoSave 命令)、
// renderer 推送勾选状态;关窗计数按每个 tab 的生效模式。见同目录 README。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MenuItemConstructorOptions } from 'electron';

const mocks = vi.hoisted(() => ({
  sendMenuCommand: vi.fn(() => true),
  FakeBrowserWindow: class FakeBrowserWindow {},
}));

vi.mock('electron', () => ({
  app: { name: 'Continuo' },
  BrowserWindow: mocks.FakeBrowserWindow,
}));
vi.mock('../../../electron/main/lib/menu-command', () => ({ sendMenuCommand: mocks.sendMenuCommand }));

import { appMenuTemplate, type AppMenuActions } from '../../../electron/main/app-menu';
import { menuCheckedOf, setMenuChecked } from '../../../electron/main/menu-checked';
import { MENU_CHECKBOX_IDS, MENU_COMMAND_IDS, WINDOW_CHANNELS } from '../../../electron/shared/window-channels';
import { menuCheckedState } from '@/shell/menu-commands';
import { countDirtyForClose } from '@/shell/dock/dirty-close';
import { DEFAULT_AUTO_SAVE_SETTINGS } from '@/panels/Editor/auto-save-config';
import { claimAutoSave, releaseAutoSave } from '@/panels/Editor/autosave-failures';
import { en } from '@shared/i18n-locales/en';
import { zh } from '@shared/i18n-locales/zh';
import { ko } from '@shared/i18n-locales/ko';

type Item = MenuItemConstructorOptions;
const t = (key: string): string => key;
const actions: AppMenuActions = { newWindow: vi.fn(), openFolderInNewWindow: vi.fn(), reloadWindow: vi.fn(), openHelpLink: vi.fn(), showAbout: vi.fn() };
const ID = 'workbench.action.toggleAutoSave';

function fileMenu(isMac: boolean, checked?: (id: string) => boolean): Item[] {
  const items = appMenuTemplate(t as never, actions, isMac, () => undefined, checked as never);
  const file = items.find((m) => m.label === 'menu.file.label');
  return file!.submenu as Item[];
}

beforeEach(() => {
  vi.clearAllMocks();
  setMenuChecked({});
});

describe('文件 → 自动保存', () => {
  it('位于「全部保存」之后、以分隔线隔开的勾选项,点击执行 toggleAutoSave 命令', () => {
    for (const isMac of [true, false]) {
      const file = fileMenu(isMac);
      const i = file.findIndex((m) => m.id === ID);
      expect(file[i - 1]?.type).toBe('separator');
      expect(file[i - 2]?.id).toBe('workbench.action.files.saveAll');
      expect(file[i]).toMatchObject({ type: 'checkbox', label: 'menu.file.auto_save', checked: false });
      file[i]!.click!(file[i] as never, {} as never, {} as never);
      expect(mocks.sendMenuCommand).toHaveBeenCalledWith({}, ID, false);
    }
  });

  it('勾选状态取 renderer 推送的值', () => {
    expect(setMenuChecked({ [ID]: true })).toBe(true);
    expect(menuCheckedOf(ID)).toBe(true);
    expect(fileMenu(true).find((m) => m.id === ID)?.checked).toBe(true);
    // 无变化 → 不重建
    expect(setMenuChecked({ [ID]: true })).toBe(false);
    expect(setMenuChecked({ [ID]: false })).toBe(true);
    expect(fileMenu(true).find((m) => m.id === ID)?.checked).toBe(false);
  });

  it('推送只认登记的勾选项 id,非布尔值忽略', () => {
    expect(setMenuChecked({ 'workbench.action.files.save': true, [ID]: 'yes' } as never)).toBe(false);
    expect(menuCheckedOf(ID)).toBe(false);
  });

  it('勾选项是菜单命令;推送通道已登记', () => {
    expect(MENU_CHECKBOX_IDS).toContain(ID);
    expect(MENU_COMMAND_IDS).toContain(ID);
    expect(WINDOW_CHANNELS.SET_MENU_CHECKED).toBe('window:set-menu-checked');
  });

  it('renderer 计算的勾选状态:files.autoSave ≠ off 即勾选', () => {
    expect(menuCheckedState('off')).toEqual({ [ID]: false });
    for (const m of ['afterDelay', 'onFocusChange', 'onWindowChange'] as const) {
      expect(menuCheckedState(m)).toEqual({ [ID]: true });
    }
  });

  it('三语标签', () => {
    expect(en['menu.file.auto_save']).toBe('Auto Save');
    expect(zh['menu.file.auto_save']).toBe('自动保存');
    expect(ko['menu.file.auto_save']).toBe('자동 저장');
  });
});

describe('关窗计数按生效模式', () => {
  const owner = {};
  afterEach(() => releaseAutoSave(owner));
  const tab = (filePath: string) => ({ id: filePath, filePath, dirty: true });

  it('默认设置:活动脏 .ts 计入确认', () => {
    claimAutoSave('/w/a.ts', owner, async () => undefined);
    expect(countDirtyForClose([tab('/w/a.ts')], DEFAULT_AUTO_SAVE_SETTINGS).dirty).toBe(1);
  });

  it('afterDelay / onFocusChange / onWindowChange:活动脏 .ts 由关窗 flush 落盘,不计入', () => {
    claimAutoSave('/w/a.ts', owner, async () => undefined);
    for (const mode of ['afterDelay', 'onFocusChange', 'onWindowChange'] as const) {
      expect(countDirtyForClose([tab('/w/a.ts')], { ...DEFAULT_AUTO_SAVE_SETTINGS, mode })).toMatchObject({
        dirty: 0,
        pendingAutoSave: ['/w/a.ts#0'],
      });
    }
  });

  it('无标题文件始终计入', () => {
    claimAutoSave('untitled:Untitled-1', owner, async () => undefined);
    const s = { ...DEFAULT_AUTO_SAVE_SETTINGS, mode: 'afterDelay' as const };
    expect(countDirtyForClose([tab('untitled:Untitled-1')], s).dirty).toBe(1);
  });
});
