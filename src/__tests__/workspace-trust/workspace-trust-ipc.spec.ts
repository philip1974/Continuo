// BDD: workspace-trust / IPC:renderer 伪造不了信任(没有置信任的通道,决定只来自 main 原生对话框)、帧信任 / 入参校验、
// notify-root 触发询问、userData 持久化(损坏隔离)、E2E 默认只在 CONTINUO_E2E=1 下生效。
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WORKSPACE_TRUST_CHANNELS } from '../../../electron/shared/workspace-trust';
import { WINDOW_CHANNELS } from '../../../electron/shared/window-channels';

type InvokeHandler = (event: { sender: object; senderFrame: unknown }, raw: unknown) => Promise<unknown>;

const m = vi.hoisted(() => ({
  handlers: new Map<string, InvokeHandler>(),
  userData: '',
  sent: [] as [string, unknown][],
  showMessageBox: vi.fn(),
}));

const fakeWin = {
  id: 7,
  isDestroyed: () => false,
  webContents: { send: (ch: string, p: unknown) => m.sent.push([ch, p]), isDestroyed: () => false },
};

vi.mock('electron', () => ({
  app: { getPath: () => m.userData, on: vi.fn() },
  ipcMain: { handle: (ch: string, h: InvokeHandler) => m.handlers.set(ch, h), on: vi.fn() },
  BrowserWindow: { fromWebContents: () => fakeWin, fromId: () => fakeWin },
  dialog: { showMessageBox: m.showMessageBox },
}));
vi.mock('../../../electron/main/index', () => ({ createMainWindow: vi.fn() }));

const TRUSTED_FRAME = { url: 'file:///app/index.html' };
const sender = {};
const invoke = (ch: string, raw: unknown, frame: unknown = TRUSTED_FRAME) => {
  const h = m.handlers.get(ch);
  if (!h) throw new Error(`no handler ${ch}`);
  return h({ sender, senderFrame: frame }, raw);
};
/** 等 notify-root 触发的询问与落盘完成(真实 fs:realpath / 读写 userData)。 */
const settled = (n: number) =>
  vi.waitFor(() => {
    expect(m.sent.filter(([ch]) => ch === WORKSPACE_TRUST_CHANNELS.CHANGED).length).toBeGreaterThanOrEqual(n);
  });
const fileData = () => vi.waitFor(() => JSON.parse(readFileSync(trustFile(), 'utf8')) as { trusted: string[] });

let ws: string;
let env: Record<string, string | undefined>;

beforeEach(async () => {
  vi.resetModules();
  m.handlers.clear();
  m.sent.length = 0;
  m.showMessageBox.mockReset();
  m.userData = mkdtempSync(path.join(tmpdir(), 'ui189-ud-'));
  ws = mkdtempSync(path.join(tmpdir(), 'ui189-ws-'));
  env = { CONTINUO_E2E: process.env['CONTINUO_E2E'], CONTINUO_E2E_WORKSPACE_TRUST: process.env['CONTINUO_E2E_WORKSPACE_TRUST'] };
  delete process.env['CONTINUO_E2E'];
  delete process.env['CONTINUO_E2E_WORKSPACE_TRUST'];
});
afterEach(() => {
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  rmSync(m.userData, { recursive: true, force: true });
  rmSync(ws, { recursive: true, force: true });
});

async function register() {
  const trust = await import('../../../electron/main/ipc/workspace-trust.ipc');
  const win = await import('../../../electron/main/ipc/window.ipc');
  trust.registerWorkspaceTrustIpc();
  win.registerWindowIpc({ createMainWindow: vi.fn(), relaunchApp: vi.fn(), reloadWindow: vi.fn(), rebuildAppMenu: vi.fn() } as never);
  return trust;
}

const trustFile = () => path.join(m.userData, 'workspace-trust.json');

describe('workspace-trust IPC', () => {
  it('信任相关通道只有 读信息 / 请求询问 / 移除条目;没有任何直接置信任的通道', async () => {
    await register();
    const channels = [...m.handlers.keys()].filter((c) => c.startsWith('workspace-trust:'));
    expect(channels.sort()).toEqual(
      [WORKSPACE_TRUST_CHANNELS.GET_INFO, WORKSPACE_TRUST_CHANNELS.REMOVE_FOLDER, WORKSPACE_TRUST_CHANNELS.REQUEST_TRUST].sort(),
    );
  });

  it('notify-root 打开未信任文件夹 → main 原生对话框询问(挂在该窗口上,带上级文件夹复选框);选「不信任」→ 推受限', async () => {
    await register();
    m.showMessageBox.mockResolvedValue({ response: 1, checkboxChecked: false });
    await invoke(WINDOW_CHANNELS.NOTIFY_ROOT, { root: ws });
    await fileData();
    expect(m.showMessageBox).toHaveBeenCalledTimes(1);
    const [parent, opts] = m.showMessageBox.mock.calls[0]!;
    expect(parent).toBe(fakeWin);
    expect(opts).toMatchObject({ cancelId: 1, checkboxLabel: expect.any(String) });
    expect((opts as { buttons: string[] }).buttons).toHaveLength(2);
    expect((opts as { detail: string }).detail).toContain(ws);
    expect(m.sent.at(-1)).toEqual([WORKSPACE_TRUST_CHANNELS.CHANGED, { root: ws, trusted: false }]);
    expect(await fileData()).toMatchObject({ version: 1, trusted: [] });
  });

  it('renderer 伪造不了确认:请求信任时塞 {trusted:true} 被拒;无入参的请求只会弹对话框,用户选「不信任」就仍不受信任', async () => {
    await register();
    m.showMessageBox.mockResolvedValue({ response: 1, checkboxChecked: true });
    await invoke(WINDOW_CHANNELS.NOTIFY_ROOT, { root: ws });
    await fileData();
    expect(await invoke(WORKSPACE_TRUST_CHANNELS.REQUEST_TRUST, { trusted: true })).toMatchObject({ ok: false });
    expect(await invoke(WORKSPACE_TRUST_CHANNELS.REQUEST_TRUST, undefined)).toEqual({ ok: true, data: false });
    expect(m.showMessageBox).toHaveBeenCalledTimes(2);
    // 「不信任」时复选框勾着也不信任上级
    expect((await fileData()).trusted).toEqual([]);
    // 不受信任的帧(注入的子 frame / 远程页面)调不动
    const untrusted = { url: 'https://evil.example/' };
    expect(await invoke(WORKSPACE_TRUST_CHANNELS.REQUEST_TRUST, undefined, untrusted)).toMatchObject({ ok: false });
    expect(await invoke(WORKSPACE_TRUST_CHANNELS.REMOVE_FOLDER, { path: ws }, untrusted)).toMatchObject({ ok: false });
    expect(m.showMessageBox).toHaveBeenCalledTimes(2);
  });

  it('用户在原生对话框里选「信任」并勾上级 → 记上级(realpath 后)、推受信任;重启后读回', async () => {
    await register();
    m.showMessageBox.mockResolvedValue({ response: 0, checkboxChecked: true });
    await invoke(WINDOW_CHANNELS.NOTIFY_ROOT, { root: ws });
    await settled(2);
    const { realpathSync } = await import('node:fs');
    expect((await fileData()).trusted).toEqual([path.dirname(realpathSync(ws))]);
    expect(m.sent.at(-1)).toEqual([WORKSPACE_TRUST_CHANNELS.CHANGED, { root: ws, trusted: true }]);
    // 重启
    vi.resetModules();
    m.handlers.clear();
    m.showMessageBox.mockReset();
    m.sent.length = 0;
    await register();
    await invoke(WINDOW_CHANNELS.NOTIFY_ROOT, { root: ws });
    await settled(1);
    expect(m.showMessageBox).not.toHaveBeenCalled();
    expect(await invoke(WORKSPACE_TRUST_CHANNELS.GET_INFO, undefined)).toMatchObject({ ok: true, data: { trusted: true } });
  });

  it('持久化文件损坏 → 隔离留证、什么都不信任(会询问)', async () => {
    writeFileSync(trustFile(), '{not json');
    await register();
    m.showMessageBox.mockResolvedValue({ response: 1, checkboxChecked: false });
    await invoke(WINDOW_CHANNELS.NOTIFY_ROOT, { root: ws });
    await vi.waitFor(() => expect(m.showMessageBox).toHaveBeenCalledTimes(1));
    expect(readdirSync(m.userData)).toContain('workspace-trust.json.corrupt');
  });

  it('E2E 默认只在 CONTINUO_E2E=1 下生效;显式 CONTINUO_E2E_WORKSPACE_TRUST=1 打开真实行为;非 E2E 恒开启', async () => {
    const { workspaceTrustEnabled } = await import('../../../electron/main/ipc/workspace-trust.ipc');
    expect(workspaceTrustEnabled({})).toBe(true);
    expect(workspaceTrustEnabled({ CONTINUO_E2E_WORKSPACE_TRUST: '0' })).toBe(true);
    expect(workspaceTrustEnabled({ CONTINUO_E2E: '0' })).toBe(true);
    expect(workspaceTrustEnabled({ CONTINUO_E2E: '1' })).toBe(false);
    expect(workspaceTrustEnabled({ CONTINUO_E2E: '1', CONTINUO_E2E_WORKSPACE_TRUST: '1' })).toBe(true);
  });
});
