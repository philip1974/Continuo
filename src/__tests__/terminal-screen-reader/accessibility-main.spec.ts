// BDD: terminal-screen-reader —— main:accessibility:get-support 返回 app.isAccessibilitySupportEnabled();系统状态变化
// ('accessibility-support-changed')广播到所有窗口(含 popout);推送 payload 守卫。见同目录 README 行为 3。
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ACCESSIBILITY_CHANNELS,
  isAccessibilitySupportChangedPayload,
} from '../../../electron/shared/accessibility-channels';

const m = vi.hoisted(() => ({
  handlers: new Map<string, { schema: { safeParse: (v: unknown) => { success: boolean } }; fn: () => unknown }>(),
  appListeners: new Map<string, (event: unknown, enabled: boolean) => void>(),
  enabled: false,
  windows: [] as Array<{ isDestroyed: () => boolean; webContents: { send: ReturnType<typeof vi.fn> } }>,
}));

vi.mock('../../../electron/main/safe-handle', () => ({
  safeHandle: (channel: string, schema: never, fn: () => unknown) => m.handlers.set(channel, { schema, fn }),
}));
vi.mock('electron', () => ({
  app: {
    isAccessibilitySupportEnabled: () => m.enabled,
    on: (name: string, cb: (event: unknown, enabled: boolean) => void) => m.appListeners.set(name, cb),
  },
  BrowserWindow: { getAllWindows: () => m.windows },
}));

import { registerAccessibilityIpc } from '../../../electron/main/ipc/accessibility.ipc';

const win = () => ({ isDestroyed: () => false, webContents: { send: vi.fn() } });

afterEach(() => {
  m.handlers.clear();
  m.appListeners.clear();
  m.windows = [];
  m.enabled = false;
});

describe('main 读屏检测通道', () => {
  it('get-support 返回当前系统检测值;只收无参', () => {
    registerAccessibilityIpc();
    const h = m.handlers.get(ACCESSIBILITY_CHANNELS.GET_SUPPORT)!;
    expect(h.fn()).toBe(false);
    m.enabled = true;
    expect(h.fn()).toBe(true);
    expect(h.schema.safeParse(undefined).success).toBe(true);
    expect(h.schema.safeParse({ x: 1 }).success).toBe(false);
  });

  it('系统状态变化 → 广播 { enabled } 到所有窗口(主窗 + popout)', () => {
    const main = win();
    const popout = win();
    m.windows = [main, popout];
    registerAccessibilityIpc();
    m.appListeners.get('accessibility-support-changed')!({}, true);
    for (const w of [main, popout]) {
      expect(w.webContents.send).toHaveBeenCalledWith(ACCESSIBILITY_CHANNELS.SUPPORT_CHANGED, { enabled: true });
    }
  });

  it('推送 payload 守卫:只认 { enabled: boolean }', () => {
    expect(isAccessibilitySupportChangedPayload({ enabled: true })).toBe(true);
    expect(isAccessibilitySupportChangedPayload({ enabled: 'yes' })).toBe(false);
    expect(isAccessibilitySupportChangedPayload(true)).toBe(false);
    expect(isAccessibilitySupportChangedPayload(null)).toBe(false);
  });
});
