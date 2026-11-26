// @vitest-environment jsdom
// 设置项「启动时恢复所有窗口」:通用 tab 的布尔开关(默认开,三语文案),值经 window:set-restore-windows 推给 main。
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  setRestoreWindows: vi.fn(async (_enabled: boolean) => ({ ok: true as const, data: undefined })),
  notifyFailure: vi.fn(),
  notifyThrownError: vi.fn(),
  handlers: new Map<string, (event: unknown, raw: unknown) => Promise<unknown>>(),
  setRestoreAll: vi.fn(async () => undefined),
}));
vi.mock('@/lib/co-api', () => ({ coApi: { window: { setRestoreWindows: h.setRestoreWindows } } }));
vi.mock('@/notifications/notify-thrown-error', () => ({
  notifyFailure: h.notifyFailure,
  notifyThrownError: h.notifyThrownError,
}));
vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => '/ud'), on: vi.fn() },
  ipcMain: { handle: vi.fn((channel: string, fn: (event: unknown, raw: unknown) => Promise<unknown>) => h.handlers.set(channel, fn)) },
  BrowserWindow: { fromWebContents: vi.fn(), fromId: vi.fn() },
}));
vi.mock('../../../electron/main/persistence', () => ({
  allocateWindowSeq: vi.fn(),
  setRestoreAllWindowsOnLaunch: h.setRestoreAll,
}));

import { GENERAL_RESTORE_WINDOWS } from '@/plugins/settings/core-setting-specs';
import { RestoreWindowsFromSettings } from '@/plugins/settings/RestoreWindowsFromSettings';
import { useSettingsValuesStore } from '@/plugins/settings/values-store';
import { WINDOW_CHANNELS } from '../../../electron/shared/window-channels';
import { registerWindowIpc } from '../../../electron/main/ipc/window.ipc';
import { en } from '../../../electron/shared/i18n-locales/en';
import { zh } from '../../../electron/shared/i18n-locales/zh';
import { ko } from '../../../electron/shared/i18n-locales/ko';

beforeEach(() => {
  vi.clearAllMocks();
  useSettingsValuesStore.setState({ values: {} });
});
afterEach(() => cleanup());

describe('设置项定义', () => {
  it('通用 tab 的布尔开关,默认开(VSCode window.restoreWindows 默认 all)', () => {
    expect(GENERAL_RESTORE_WINDOWS).toMatchObject({
      id: 'window.restoreWindows',
      category: 'general',
      type: 'boolean',
      default: true,
    });
  });

  it('标题与说明三语齐全', () => {
    for (const catalog of [en, zh, ko] as Array<Record<string, string>>) {
      expect(catalog[GENERAL_RESTORE_WINDOWS.titleKey!]).toEqual(expect.any(String));
      expect(catalog[GENERAL_RESTORE_WINDOWS.descriptionKey!]).toEqual(expect.any(String));
    }
  });

  it('由内置「通用」插件注册', () => {
    const src = readFileSync(join(process.cwd(), 'src/core-plugins/GeneralTabPlugin.ts'), 'utf8');
    expect(src).toContain('this.addSettingItem(GENERAL_RESTORE_WINDOWS)');
  });
});

describe('RestoreWindowsFromSettings(设置值 → main)', () => {
  it('挂载即推当前值(未设置 = 默认开);切换开关再推新值', async () => {
    render(<RestoreWindowsFromSettings />);
    await vi.waitFor(() => expect(h.setRestoreWindows).toHaveBeenLastCalledWith(true));
    await act(async () => {
      useSettingsValuesStore.setState({ values: { [GENERAL_RESTORE_WINDOWS.id]: false } });
    });
    await vi.waitFor(() => expect(h.setRestoreWindows).toHaveBeenLastCalledWith(false));
    expect(h.setRestoreWindows).toHaveBeenCalledTimes(2);
  });

  it('用户切换后写入失败 → 可见反馈;挂载时的同步失败只记日志', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    h.setRestoreWindows.mockResolvedValue({ ok: false, code: 'FS_DENIED', message: 'denied' } as never);
    render(<RestoreWindowsFromSettings />);
    await vi.waitFor(() => expect(h.setRestoreWindows).toHaveBeenCalledTimes(1));
    await act(async () => {});
    expect(h.notifyFailure).not.toHaveBeenCalled();
    await act(async () => {
      useSettingsValuesStore.setState({ values: { [GENERAL_RESTORE_WINDOWS.id]: false } });
    });
    await vi.waitFor(() => expect(h.notifyFailure).toHaveBeenCalledTimes(1));
    warn.mockRestore();
  });
});

describe('window:set-restore-windows(main)', () => {
  it('写入 userData/explorer.json 的启动偏好', async () => {
    registerWindowIpc({ createMainWindow: vi.fn(), relaunchApp: vi.fn(), reloadWindow: vi.fn() });
    const handler = h.handlers.get(WINDOW_CHANNELS.SET_RESTORE_WINDOWS)!;
    const r = await handler({ sender: {}, senderFrame: { url: 'file:///renderer/index.html' } }, { enabled: false });
    expect(r).toEqual({ ok: true, data: undefined });
    expect(h.setRestoreAll).toHaveBeenCalledWith(join('/ud', 'explorer.json'), false);
  });
});
