// @vitest-environment jsdom
// BDD: window-zoom —— renderer 侧:设置项 window.zoomLevel、放大 / 缩小 / 重置缩放命令改设置值(VSCode BaseZoomAction 取整 /
// 越界不动)、默认键(含附加键,终端带 ⌘ 让出、popout 子窗分发)、设置值 → main 的桥、命令面板可搜。见同目录 README 1、4、5、7。
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  setZoomLevel: vi.fn(async (_level: number) => ({ ok: true as const, data: undefined }) as const),
  notifyFailure: vi.fn(),
  notifyThrownError: vi.fn(),
}));
vi.mock('@/lib/co-api', () => ({ coApi: { window: { setZoomLevel: h.setZoomLevel } } }));
vi.mock('@/notifications/notify-thrown-error', () => ({
  notifyFailure: h.notifyFailure,
  notifyThrownError: h.notifyThrownError,
}));

import { WINDOW_ZOOM_LEVEL } from '@/plugins/settings/core-setting-specs';
import { ZoomLevelFromSettings } from '@/plugins/settings/ZoomLevelFromSettings';
import { getStoredSettingValue, useSettingsValuesStore } from '@/plugins/settings/values-store';
import { coApp } from '@/plugins/co-app';
import { windowCommandSpecs } from '@/shell/window-commands';
import type { CommandSpec } from '@/plugins/registries/CommandRegistry';
import { buildDisplayCommands, searchDisplayCommands } from '@/plugins/command-palette/CommandPalette';
import { isPopoutHotkeyCommand, winningCommandFor } from '@/plugins/command-palette/useCommandHotkeys';
import { terminalYieldedCommandId } from '@/panels/Terminal/terminal-hotkeys';
import { en } from '../../../electron/shared/i18n-locales/en';
import { zh } from '../../../electron/shared/i18n-locales/zh';
import { ko } from '../../../electron/shared/i18n-locales/ko';

const ZOOM_IN = 'workbench.action.zoomIn';
const ZOOM_OUT = 'workbench.action.zoomOut';
const ZOOM_RESET = 'workbench.action.zoomReset';
const ZOOM_IDS = [ZOOM_IN, ZOOM_OUT, ZOOM_RESET];

let specs: CommandSpec[] = [];
const spec = (id: string): CommandSpec => specs.find((c) => c.id === id)!;
const run = async (id: string): Promise<void> => {
  await spec(id).fn();
};
const level = (): unknown => getStoredSettingValue(WINDOW_ZOOM_LEVEL.id);
const setLevel = (v: number): void => useSettingsValuesStore.setState({ values: { [WINDOW_ZOOM_LEVEL.id]: v } });
const key = (init: KeyboardEventInit): KeyboardEvent => new KeyboardEvent('keydown', { bubbles: true, ...init });

beforeAll(() => {
  coApp.settingItems.register(WINDOW_ZOOM_LEVEL);
  specs = windowCommandSpecs();
});
beforeEach(() => {
  vi.clearAllMocks();
  useSettingsValuesStore.setState({ values: {} });
});
afterEach(() => cleanup());

describe('设置项 window.zoomLevel', () => {
  it('通用 tab 的数字项:默认 0,范围 -8..8(VSCode MIN_ZOOM_LEVEL / MAX_ZOOM_LEVEL)', () => {
    expect(WINDOW_ZOOM_LEVEL).toMatchObject({
      id: 'window.zoomLevel',
      category: 'general',
      type: 'number',
      default: 0,
      min: -8,
      max: 8,
    });
  });

  it('标题与说明三语齐全;中文标题含「缩放」(设置页可搜)', () => {
    for (const catalog of [en, zh, ko] as Array<Record<string, string>>) {
      expect(catalog[WINDOW_ZOOM_LEVEL.titleKey!]).toEqual(expect.any(String));
      expect(catalog[WINDOW_ZOOM_LEVEL.descriptionKey!]).toEqual(expect.any(String));
    }
    expect((zh as Record<string, string>)[WINDOW_ZOOM_LEVEL.titleKey!]).toContain('缩放');
  });

  it('由内置「通用」插件注册;应用根挂载桥', () => {
    const plugin = readFileSync(join(process.cwd(), 'src/core-plugins/GeneralTabPlugin.ts'), 'utf8');
    expect(plugin).toContain('this.addSettingItem(WINDOW_ZOOM_LEVEL)');
    const app = readFileSync(join(process.cwd(), 'src/shell/App.tsx'), 'utf8');
    expect(app).toContain('<ZoomLevelFromSettings />');
  });
});

describe('放大 / 缩小 / 重置缩放命令改设置值', () => {
  it('放大 / 缩小每次 ±1 级', async () => {
    await run(ZOOM_IN);
    await run(ZOOM_IN);
    expect(level()).toBe(2);
    await run(ZOOM_OUT);
    expect(level()).toBe(1);
  });

  it('小数级别先 ±1 再取整(VSCode Math.round)', async () => {
    setLevel(1.5);
    await run(ZOOM_IN);
    expect(level()).toBe(3);
    setLevel(1.4);
    await run(ZOOM_OUT);
    expect(level()).toBe(0);
  });

  it('越过 [-8, 8] 不动', async () => {
    setLevel(8);
    await run(ZOOM_IN);
    expect(level()).toBe(8);
    setLevel(-8);
    await run(ZOOM_OUT);
    expect(level()).toBe(-8);
  });

  it('重置 = 删掉设置覆盖(回到默认 0,同设置页「恢复默认」)', async () => {
    setLevel(3);
    await run(ZOOM_RESET);
    expect(level()).toBeUndefined();
  });

  it('分类「查看」,三语标题;中文标题都含「缩放」,英文别名含 Zoom', () => {
    for (const id of ZOOM_IDS) {
      const c = spec(id);
      expect(c.categoryKey).toBe('commands.view.category');
      expect((zh as Record<string, string>)[c.titleKey!], id).toContain('缩放');
      expect((en as Record<string, string>)[c.titleKey!], id).toMatch(/Zoom/);
      expect((ko as Record<string, string>)[c.titleKey!], id).toEqual(expect.any(String));
    }
  });
});

describe('默认键(VSCode windowActions keybinding)', () => {
  it('主键 ⌘= / ⌘- / ⌘0,附加 ⇧⌘= / ⌘Numpad+、⇧⌘- / ⌘Numpad-、⌘Numpad0', () => {
    expect(spec(ZOOM_IN)).toMatchObject({ hotkey: 'mod+=', secondaryHotkeys: ['mod+shift+=', 'mod+numpad_add'] });
    expect(spec(ZOOM_OUT)).toMatchObject({ hotkey: 'mod+-', secondaryHotkeys: ['mod+shift+-', 'mod+numpad_subtract'] });
    expect(spec(ZOOM_RESET)).toMatchObject({ hotkey: 'mod+0', secondaryHotkeys: ['mod+numpad0'] });
  });

  it.each([
    ['⌘=(US 键盘)', { key: '=', code: 'Equal', metaKey: true }, ZOOM_IN],
    ['⇧⌘=(e.key 为 +)', { key: '+', code: 'Equal', metaKey: true, shiftKey: true }, ZOOM_IN],
    ['⌘ 小键盘 +', { key: '+', code: 'NumpadAdd', metaKey: true }, ZOOM_IN],
    ['⌘-', { key: '-', code: 'Minus', metaKey: true }, ZOOM_OUT],
    ['⇧⌘-', { key: '_', code: 'Minus', metaKey: true, shiftKey: true }, ZOOM_OUT],
    ['⌘ 小键盘 -', { key: '-', code: 'NumpadSubtract', metaKey: true }, ZOOM_OUT],
    ['⌘0', { key: '0', code: 'Digit0', metaKey: true }, ZOOM_RESET],
    ['⌘ 小键盘 0', { key: '0', code: 'Numpad0', metaKey: true }, ZOOM_RESET],
  ] as const)('mac %s → %s', (_label, init, id) => {
    expect(winningCommandFor(key(init), specs, 'mac', {})?.id).toBe(id);
  });

  it('命令面板显示主键', () => {
    const tk = (_k: string | undefined, fb: string): string => fb;
    const shown = buildDisplayCommands(specs, tk, 'mac', {}).filter((d) => ZOOM_IDS.includes(d.cmd.id));
    expect(shown.map((d) => d.hotkeyParts.length > 0)).toEqual([true, true, true]);
  });

  it('popout 子窗里也分发;终端获焦时带 ⌘ 让出,Win/Linux 的 Ctrl+= 照常进 shell', () => {
    for (const id of ZOOM_IDS) expect(isPopoutHotkeyCommand(spec(id)), id).toBe(true);
    const registry = { getAll: () => specs };
    expect(terminalYieldedCommandId(key({ key: '=', code: 'Equal', metaKey: true }), 'mac', {}, registry)).toBe(ZOOM_IN);
    expect(terminalYieldedCommandId(key({ key: '=', code: 'Equal', ctrlKey: true }), 'other', {}, registry)).toBeNull();
  });
});

describe('命令面板可搜', () => {
  const zhTk = (k: string | undefined, fb: string): string => (k ? ((zh as Record<string, string>)[k] ?? fb) : fb);
  const enTk = (k: string | undefined, fb: string): string => (k ? ((en as Record<string, string>)[k] ?? fb) : fb);

  it.each(['缩放', 'zoom'])('中文界面搜「%s」→ 放大 / 缩小 / 重置缩放都在结果里', (query) => {
    const items = buildDisplayCommands(specs, zhTk, 'mac', {}, enTk);
    const ids = searchDisplayCommands(items, query).matches.map((d) => d.cmd.id);
    expect(ids).toEqual(expect.arrayContaining(ZOOM_IDS));
  });
});

describe('ZoomLevelFromSettings(设置值 → main)', () => {
  it('挂载即推当前值(未设置 = 0);值变化再推新值', async () => {
    render(<ZoomLevelFromSettings />);
    await vi.waitFor(() => expect(h.setZoomLevel).toHaveBeenLastCalledWith(0));
    await act(async () => {
      await run(ZOOM_IN);
    });
    await vi.waitFor(() => expect(h.setZoomLevel).toHaveBeenLastCalledWith(1));
    await act(async () => {
      await run(ZOOM_RESET);
    });
    await vi.waitFor(() => expect(h.setZoomLevel).toHaveBeenLastCalledWith(0));
    expect(h.setZoomLevel).toHaveBeenCalledTimes(3);
  });

  it('值变化后推送失败 → 可见反馈;挂载时的失败只记日志', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const fail = { ok: false as const, code: 'X', message: 'boom' };
    h.setZoomLevel.mockResolvedValueOnce(fail as never);
    render(<ZoomLevelFromSettings />);
    await vi.waitFor(() => expect(warn).toHaveBeenCalled());
    expect(h.notifyFailure).not.toHaveBeenCalled();
    h.setZoomLevel.mockResolvedValueOnce(fail as never);
    await act(async () => {
      setLevel(2);
    });
    await vi.waitFor(() => expect(h.notifyFailure).toHaveBeenCalledWith(fail));
    warn.mockRestore();
  });
});
