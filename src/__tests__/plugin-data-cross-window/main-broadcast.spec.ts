// 插件 data.json 写盘成功后向其它窗口广播 plugin-data:changed(跨窗口缓存失效)。见同目录 README.md。
import { promises as fs } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type Handler = (event: unknown, ...args: unknown[]) => Promise<unknown>;

const h = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, ...args: unknown[]) => Promise<unknown>>(),
  windows: [] as unknown[],
  userData: '',
}));

vi.mock('electron', () => ({
  app: { getPath: () => h.userData },
  ipcMain: {
    handle: (channel: string, fn: Handler) => {
      h.handlers.set(channel, fn);
    },
  },
  BrowserWindow: { getAllWindows: () => h.windows },
}));

import { registerPluginDataIpc } from '../../../electron/main/ipc/plugin-data.ipc';
import { PLUGIN_DATA_CHANNELS } from '../../../electron/shared/plugin-data-channels';
import { setTrustedDevOrigin } from '../../../electron/main/safe-handle';
import { makeFakeWin, type FakeWin } from '../_helpers/fake-window';

const RENDERER_URL = 'http://localhost:5173';
const ID = 'com.x.p';

function eventFrom(win: FakeWin): unknown {
  return { senderFrame: { url: `${RENDERER_URL}/` }, sender: win.webContents };
}

function save(win: FakeWin, id: string, json: string): Promise<unknown> {
  return h.handlers.get(PLUGIN_DATA_CHANNELS.SAVE_SERIALIZED)!(eventFrom(win), id, json);
}

function changedSends(win: FakeWin): unknown[] {
  return win.webContents.send.mock.calls
    .filter((c) => c[0] === PLUGIN_DATA_CHANNELS.CHANGED)
    .map((c) => c[1]);
}

beforeEach(async () => {
  setTrustedDevOrigin(RENDERER_URL);
  h.handlers.clear();
  h.windows.length = 0;
  h.userData = await mkdtemp(path.join(tmpdir(), 'plugin-data-xwin-'));
  await fs.mkdir(path.join(h.userData, 'plugins', ID), { recursive: true });
  registerPluginDataIpc();
});

afterEach(async () => {
  setTrustedDevOrigin(null);
  await rm(h.userData, { recursive: true, force: true });
});

describe('main:plugin-data:save-serialized 写后广播', () => {
  it('成功 → 向发起窗口以外的所有窗口广播 { id },发起窗口不收', async () => {
    const a = makeFakeWin();
    const b = makeFakeWin();
    const c = makeFakeWin();
    h.windows.push(a, b, c);

    await save(a, ID, '{"url":"new"}');

    expect(changedSends(a)).toEqual([]);
    expect(changedSends(b)).toEqual([{ id: ID }]);
    expect(changedSends(c)).toEqual([{ id: ID }]);
  });

  it('写失败(插件未安装)→ 不广播', async () => {
    const a = makeFakeWin();
    const b = makeFakeWin();
    h.windows.push(a, b);
    await expect(save(a, 'com.x.missing', '{"a":1}')).rejects.toMatchObject({ code: 'NOT_INSTALLED' });
    expect(changedSends(b)).toEqual([]);
  });

  it('校验拒绝(非 JSON)→ 不广播', async () => {
    const a = makeFakeWin();
    const b = makeFakeWin();
    h.windows.push(a, b);
    await expect(save(a, ID, '1,"x":2')).rejects.toBeDefined();
    expect(changedSends(b)).toEqual([]);
  });
});
