// @vitest-environment node
// 设置存储的 IPC 边界(electron/main/ipc/user-settings.ipc):同步快照只给受信 frame;UPDATE / IMPORT 经 safe-handle + zod 限幅;
// 每次提交广播给所有窗口。
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setupTempDirs } from '../_helpers/tmp-dir';

type Frame = { url: string };
type InvokeHandler = (event: { sender: object; senderFrame: Frame }, raw: unknown) => Promise<unknown>;
type OnHandler = (event: { sender: object; senderFrame: Frame; returnValue?: unknown }) => void;

const h = vi.hoisted(() => ({
  dir: '',
  handle: new Map<string, InvokeHandler>(),
  on: new Map<string, OnHandler>(),
  sent: [] as Array<{ win: number; channel: string; payload: unknown }>,
  windows: [] as Array<{ id: number; webContents: object & { send: (c: string, p: unknown) => void }; isDestroyed: () => boolean }>,
}));

vi.mock('electron', () => ({
  app: { getPath: () => h.dir },
  ipcMain: {
    handle: (channel: string, fn: InvokeHandler) => h.handle.set(channel, fn),
    on: (channel: string, fn: OnHandler) => h.on.set(channel, fn),
  },
  BrowserWindow: {
    getAllWindows: () => h.windows,
    fromWebContents: (wc: object) => h.windows.find((w) => w.webContents === wc) ?? null,
  },
}));

import { registerUserSettingsIpc, registerUserSettingsSnapshotIpc } from '../../../electron/main/ipc/user-settings.ipc';
import {
  _resetUserSettingsForTest,
  loadUserSettings,
} from '../../../electron/main/services/user-settings.service';
import { setTrustedRendererFile, _resetTrustedRendererFileForTest } from '../../../electron/main/safe-handle';
import {
  USER_SETTINGS_CHANNELS,
  USER_SETTINGS_KEY_MAX,
  USER_SETTINGS_TEXT_MAX,
  USER_SETTINGS_UPDATE_MAX,
} from '../../../electron/shared/user-settings';

const tmp = setupTempDirs();
const RENDERER = path.resolve('/app/out/renderer/index.html');
const trusted: Frame = { url: `file://${RENDERER}` };
const untrusted: Frame = { url: 'https://evil.example/' };

function fakeWindow(id: number) {
  const webContents = { send: (channel: string, payload: unknown) => h.sent.push({ win: id, channel, payload }) };
  const w = { id, webContents, isDestroyed: () => false };
  h.windows.push(w);
  return w;
}

const invoke = (channel: string, raw: unknown, frame: Frame = trusted) =>
  h.handle.get(channel)!({ sender: h.windows[0]!.webContents, senderFrame: frame }, raw) as Promise<{
    ok: boolean;
    code?: string;
    data?: unknown;
  }>;

beforeEach(async () => {
  h.dir = await tmp.make('ui196-user-settings-ipc-');
  h.handle.clear();
  h.on.clear();
  h.sent.length = 0;
  h.windows.length = 0;
  _resetUserSettingsForTest();
  setTrustedRendererFile(RENDERER);
  fakeWindow(1);
  fakeWindow(2);
  await loadUserSettings();
  registerUserSettingsIpc();
  registerUserSettingsSnapshotIpc();
});
afterEach(() => {
  _resetTrustedRendererFileForTest();
});

describe('SNAPSHOT(同步)', () => {
  it('受信 frame → 两类记录的快照;不受信 frame → null', async () => {
    await invoke(USER_SETTINGS_CHANNELS.UPDATE, { scope: 'settings', set: { a: 1 }, remove: [] });
    const ev = { sender: h.windows[0]!.webContents, senderFrame: trusted, returnValue: undefined as unknown };
    h.on.get(USER_SETTINGS_CHANNELS.SNAPSHOT)!(ev);
    expect(ev.returnValue).toMatchObject({
      settings: { record: { a: 1 }, needsImport: false, persistBlocked: false },
      keybindings: { record: {}, needsImport: true, persistBlocked: false },
    });
    const bad = { sender: h.windows[0]!.webContents, senderFrame: untrusted, returnValue: undefined as unknown };
    h.on.get(USER_SETTINGS_CHANNELS.SNAPSHOT)!(bad);
    expect(bad.returnValue).toBeNull();
  });
});

describe('UPDATE / IMPORT 输入限幅', () => {
  it.each([
    ['未知 scope', { scope: 'other', set: {}, remove: [] }],
    ['值是对象', { scope: 'settings', set: { a: { x: 1 } }, remove: [] }],
    ['值是 null', { scope: 'settings', set: { a: null }, remove: [] }],
    ['值非有限数', { scope: 'settings', set: { a: Infinity }, remove: [] }],
    ['超长字符串值', { scope: 'settings', set: { a: 'x'.repeat(USER_SETTINGS_TEXT_MAX + 1) }, remove: [] }],
    ['超长 key', { scope: 'settings', set: { ['k'.repeat(USER_SETTINGS_KEY_MAX + 1)]: 1 }, remove: [] }],
    ['remove 超长 key', { scope: 'settings', set: {}, remove: ['k'.repeat(USER_SETTINGS_KEY_MAX + 1)] }],
    [
      'set 条目过多',
      { scope: 'settings', set: Object.fromEntries(Array.from({ length: USER_SETTINGS_UPDATE_MAX + 1 }, (_, i) => [`k${i}`, i])), remove: [] },
    ],
    ['多余字段', { scope: 'settings', set: {}, remove: [], extra: 1 }],
  ])('UPDATE %s → IPC_BAD_INPUT,不写', async (_label, raw) => {
    const r = await invoke(USER_SETTINGS_CHANNELS.UPDATE, raw);
    expect(r).toMatchObject({ ok: false, code: 'IPC_BAD_INPUT' });
    expect(h.sent).toEqual([]);
  });

  it('不受信 frame 的 UPDATE / IMPORT → IPC_DENIED', async () => {
    expect(await invoke(USER_SETTINGS_CHANNELS.UPDATE, { scope: 'settings', set: { a: 1 }, remove: [] }, untrusted)).toMatchObject({
      ok: false,
      code: 'IPC_DENIED',
    });
    expect(await invoke(USER_SETTINGS_CHANNELS.IMPORT, { scope: 'settings', record: { a: 1 } }, untrusted)).toMatchObject({
      ok: false,
      code: 'IPC_DENIED',
    });
  });

  it('IMPORT 值非法 → IPC_BAD_INPUT', async () => {
    expect(await invoke(USER_SETTINGS_CHANNELS.IMPORT, { scope: 'keybindings', record: { a: [1] } })).toMatchObject({
      ok: false,
      code: 'IPC_BAD_INPUT',
    });
  });
});

describe('广播', () => {
  it('提交后向所有窗口广播 {scope, version, record};回复带同一状态', async () => {
    const r = await invoke(USER_SETTINGS_CHANNELS.UPDATE, { scope: 'keybindings', set: { 'editor.save': '' }, remove: [] });
    expect(r.ok).toBe(true);
    const changed = h.sent.filter((s) => s.channel === USER_SETTINGS_CHANNELS.CHANGED);
    expect(changed.map((s) => s.win)).toEqual([1, 2]);
    expect(changed[0]!.payload).toEqual({ scope: 'keybindings', ...(r.data as object) });
    expect((r.data as { record: unknown }).record).toEqual({ 'editor.save': '' });
  });

  it('无变化的 UPDATE 不广播', async () => {
    await invoke(USER_SETTINGS_CHANNELS.UPDATE, { scope: 'settings', set: { a: 1 }, remove: [] });
    h.sent.length = 0;
    await invoke(USER_SETTINGS_CHANNELS.UPDATE, { scope: 'settings', set: { a: 1 }, remove: ['nope'] });
    expect(h.sent).toEqual([]);
  });
});
