// @vitest-environment jsdom
// BDD:键盘用户的文件 / 资源管理器入口命令(VSCode explorer.newFile / explorer.newFolder /
// workbench.action.files.openFolder / workbench.view.explorer)。见同目录 README 第 1、2 条。
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { coApp } from '@/plugins/co-app';
import { bootCorePlugins, shutdownCorePlugins } from '@/core-plugins';
import { canonicalHotkey, type Platform } from '@/plugins/command-palette/format-hotkey';
import { PICKER_TOGGLE_HOTKEYS } from '@/plugins/picker/use-picker-toggle-hotkey';
import {
  NEW_FILE_COMMAND_ID,
  NEW_FOLDER_COMMAND_ID,
  OPEN_FOLDER_COMMAND,
  SHOW_EXPLORER_COMMAND,
} from '@/panels/Explorer/explorer-commands';
import { MENU_COMMANDS } from '../../../electron/shared/window-channels';
import { en } from '../../../electron/shared/i18n-locales/en';
import { zh } from '../../../electron/shared/i18n-locales/zh';
import { ko } from '../../../electron/shared/i18n-locales/ko';

beforeEach(() => bootCorePlugins());
afterEach(() => shutdownCorePlugins());

describe('命令注册', () => {
  it.each([
    [NEW_FILE_COMMAND_ID, undefined, 'commands.explorer.category'],
    [NEW_FOLDER_COMMAND_ID, undefined, 'commands.explorer.category'],
    [OPEN_FOLDER_COMMAND.id, 'mod+o', 'commands.file.category'],
    [SHOW_EXPLORER_COMMAND.id, 'mod+shift+e', 'commands.view.category'],
  ])('%s:默认键 %s,三语标题与分类', (id, hotkey, categoryKey) => {
    expect(id).toMatch(/^(explorer\.newFile|explorer\.newFolder|workbench\.action\.files\.openFolder|workbench\.view\.explorer)$/);
    const spec = coApp.commands.get(id);
    expect(spec).toBeDefined();
    expect(spec!.hotkey).toBe(hotkey);
    expect(spec!.categoryKey).toBe(categoryKey);
    for (const catalog of [en, zh, ko] as ReadonlyArray<Record<string, string>>) {
      expect(catalog[spec!.titleKey!]).toBeTruthy();
      expect(catalog[categoryKey]).toBeTruthy();
    }
  });
});

// 写死 accelerator 的应用菜单源码(模板在 app-menu.ts,dock 菜单等在 index.ts)。
const MENU_SOURCES = ['electron/main/app-menu.ts', 'electron/main/index.ts'];

describe('默认键不冲突', () => {
  // Electron 应用菜单里写死的 accelerator(CmdOrCtrl → mod),与 renderer 命令同一按键空间。
  const menuAccelerators = (): string[] => {
    const src = MENU_SOURCES.map((f) => readFileSync(join(process.cwd(), f), 'utf8')).join('\n');
    return Array.from(src.matchAll(/accelerator:\s*'([^']+)'/g), (m) =>
      m[1]!.toLowerCase().replace('cmdorctrl', 'mod'),
    );
  };

  it.each(['mac', 'other'] as Platform[])('%s:⌘O / ⌘⇧E 不与其它命令默认键、picker 保留键、应用菜单快捷键重合', (platform) => {
    const mine = new Set<string>([OPEN_FOLDER_COMMAND.id, SHOW_EXPLORER_COMMAND.id]);
    const others = [
      ...coApp.commands.getAll().filter((c) => !mine.has(c.id) && c.hotkey).map((c) => c.hotkey!),
      ...Object.values(PICKER_TOGGLE_HOTKEYS),
      ...menuAccelerators(),
    ].map((h) => canonicalHotkey(h, platform));
    expect(others.length).toBeGreaterThan(5);
    for (const hotkey of [OPEN_FOLDER_COMMAND.hotkey, SHOW_EXPLORER_COMMAND.hotkey]) {
      expect(others).not.toContain(canonicalHotkey(hotkey, platform));
    }
  });
});

// 应用菜单里「即某条命令」的菜单项(MENU_COMMANDS:文件 → 打开文件夹… ⌘O)与该命令同一动作:accelerator 必须就是命令的
// 默认键(不算冲突),且不得与任何别的命令默认键 / picker 保留键 / 其它菜单快捷键重合。一次按键只执行一次:renderer 全局
// 热键先收到 keydown 并 preventDefault,Electron 不再触发菜单 accelerator;renderer 没处理(如改了键)才由菜单执行。
describe('菜单项即命令:accelerator = 命令默认键,且与其它按键不冲突', () => {
  const literalMenuAccelerators = (): string[] => {
    const src = MENU_SOURCES.map((f) => readFileSync(join(process.cwd(), f), 'utf8')).join('\n');
    return Array.from(src.matchAll(/accelerator:\s*'([^']+)'/g), (m) => m[1]!.toLowerCase().replace('cmdorctrl', 'mod'));
  };

  it.each(['mac', 'other'] as Platform[])('%s', (platform) => {
    const entries = Object.entries(MENU_COMMANDS);
    expect(entries.length).toBeGreaterThan(0);
    for (const [id, accelerator] of entries) {
      const spec = coApp.commands.get(id);
      expect(spec?.hotkey, id).toBeDefined();
      const mine = canonicalHotkey(accelerator.toLowerCase().replace('cmdorctrl', 'mod'), platform);
      expect(mine).toBe(canonicalHotkey(spec!.hotkey!, platform));
      const others = [
        ...coApp.commands.getAll().filter((c) => c.id !== id && c.hotkey).map((c) => c.hotkey!),
        ...Object.values(PICKER_TOGGLE_HOTKEYS),
        ...literalMenuAccelerators(),
      ].map((h) => canonicalHotkey(h, platform));
      expect(others).not.toContain(mine);
    }
  });
});
