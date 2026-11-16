// @vitest-environment jsdom
// 停用即吊销 scoped app(终审 P1):插件实例离开运行态时,先吊销它的 scoped app,再调 onunload。
// 之后(延迟回调 / 超时仍在跑的 onunload)调用有外部副作用的能力在 renderer 源头被拒、不发 IPC。见同目录 README.md。
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

const h = vi.hoisted(() => ({
  shellExec: vi.fn(),
  execStream: vi.fn(),
  writeFile: vi.fn(),
  readFile: vi.fn(),
  checkPath: vi.fn(),
  fetch: vi.fn(),
  clipboardWrite: vi.fn(),
  clipboardRead: vi.fn(),
}));

vi.mock('@/lib/co-api', () => ({
  coApi: {
    pluginFsRaw: {
      _registerPlugin: async () => ({ token: 'tok', generation: 1 }),
      _unregisterPlugin: async () => undefined,
      writeFile: h.writeFile,
      readFile: h.readFile,
      checkPath: h.checkPath,
    },
    shell: { exec: h.shellExec, killPluginProcesses: async () => ({ ok: true, data: undefined }) },
    pluginShellStreamRaw: { execStream: h.execStream },
  },
}));

vi.mock('../../plugins/sandbox-sweep', () => ({
  getCachedFetch: () => h.fetch,
  getCachedClipboard: () => ({ writeText: h.clipboardWrite, readText: h.clipboardRead }),
}));

import { Plugin, PLUGIN_UNLOAD_TIMEOUT_MS } from '../../plugins/Plugin';
import { PluginManager, type ManagerHost } from '../../plugins/PluginManager';
import { PermissionError } from '../../plugins/permissions';
import { createScopedAppController } from '../../plugins/scoped-app';
import { createTestCoApp } from '../../plugins/test-utils';
import type { CoPluginApp } from '../../plugins/types';

const ID = 'com.x.p';

const OK_EXEC = {
  ok: true,
  data: { stdout: '', stderr: '', exitCode: 0, signal: null, timedOut: false, truncated: false },
};

beforeEach(() => {
  for (const fn of Object.values(h)) fn.mockReset();
  h.shellExec.mockResolvedValue(OK_EXEC);
  h.execStream.mockReturnValue({
    chunks: { [Symbol.asyncIterator]: () => ({ next: async () => ({ value: undefined, done: true }) }) },
    done: Promise.resolve({ exitCode: 0, signal: null }),
  });
  h.writeFile.mockResolvedValue(undefined);
  h.readFile.mockResolvedValue('content');
  h.checkPath.mockResolvedValue(true);
  h.fetch.mockResolvedValue(new Response('x'));
  h.clipboardWrite.mockResolvedValue(undefined);
  h.clipboardRead.mockResolvedValue('clip');
});

function noIpc(): void {
  expect(h.shellExec).not.toHaveBeenCalled();
  expect(h.execStream).not.toHaveBeenCalled();
}

describe('scoped app:revoke() 后有外部副作用的能力一律拒绝,不发 IPC', () => {
  function revoked(): { app: CoPluginApp; editorOpen: ReturnType<typeof vi.fn> } {
    const coApp = createTestCoApp();
    const editorOpen = vi.fn().mockResolvedValue({ ok: true, lineApplied: false, reason: 'no-line-arg' });
    const ctl = createScopedAppController({ ...coApp, editor: { openFile: editorOpen } }, ID, null, 'tok');
    ctl.revoke();
    return { app: ctl.app, editorOpen };
  }

  it('shell.exec → PermissionError,不发 IPC', async () => {
    const { app } = revoked();
    await expect(app.shell.exec('/bin/echo', ['hi'])).rejects.toBeInstanceOf(PermissionError);
    noIpc();
  });

  it('shell.execStream → done 与 chunks 均 reject PermissionError,不 spawn', async () => {
    const { app } = revoked();
    const s = app.shell.execStream('/bin/echo', ['hi']);
    await expect(s.done).rejects.toBeInstanceOf(PermissionError);
    await expect(s.chunks[Symbol.asyncIterator]().next()).rejects.toBeInstanceOf(PermissionError);
    noIpc();
  });

  it('network / fs 写 / clipboard / mcp 注册 → PermissionError,不触达底层', async () => {
    const { app } = revoked();
    await expect(app.network.fetch('https://example.com')).rejects.toBeInstanceOf(PermissionError);
    await expect(app.fs.writeFile('/w/a', 'x')).rejects.toBeInstanceOf(PermissionError);
    await expect(app.fs.requestScope([{ path: '/w', mode: 'r' }])).rejects.toBeInstanceOf(
      PermissionError,
    );
    await expect(app.clipboard.writeText('x')).rejects.toBeInstanceOf(PermissionError);
    await expect(app.clipboard.readText()).rejects.toBeInstanceOf(PermissionError);
    await expect(
      app.mcp.register({
        name: 't',
        description: 'd',
        jsonSchema: { type: 'object' },
        inputSchema: z.object({}),
        run: () => ({}),
      }),
    ).rejects.toBeInstanceOf(PermissionError);
    expect(h.fetch).not.toHaveBeenCalled();
    expect(h.writeFile).not.toHaveBeenCalled();
    expect(h.clipboardWrite).not.toHaveBeenCalled();
    expect(h.clipboardRead).not.toHaveBeenCalled();
  });

  it('notifications.show / dock.openPanel 抛 PERMISSION_DENIED;editor.openFile 返回 PERMISSION_DENIED 结果', async () => {
    const { app, editorOpen } = revoked();
    expect(() => app.notifications.show({ kind: 'info', message: 'x' })).toThrow(
      expect.objectContaining({ code: 'PERMISSION_DENIED' }),
    );
    expect(() => app.dock.openPanel('p')).toThrow(expect.objectContaining({ code: 'PERMISSION_DENIED' }));
    await expect(app.editor.openFile('/w/a')).resolves.toMatchObject({ ok: false, code: 'PERMISSION_DENIED' });
    expect(editorOpen).not.toHaveBeenCalled();
  });

  it('不阻断:fs 读、dataStore、permission 查询(onunload 收尾可用,无外部副作用)', async () => {
    const { app } = revoked();
    await expect(app.fs.readFile('/w/a')).resolves.toBe('content');
    await expect(app.dataStore.write(ID, { a: 1 })).resolves.toBeUndefined();
    await expect(app.dataStore.read(ID)).resolves.toEqual({ a: 1 });
    await expect(app.permission.check('shell')).resolves.toBe(true);
  });

  it('权限等待期间被吊销 → 等待结束后仍拒绝(不在吊销后发 IPC)', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const store = {
      get: async () => {
        await gate;
        return [{ permission: 'shell' as const, granted: true, decidedAt: 1 }];
      },
      grant: async () => {},
      deny: async () => {},
      clearDenied: async () => {},
    };
    const ctl = createScopedAppController(createTestCoApp(), ID, store, 'tok', ['shell']);
    const p = ctl.app.shell.exec('/bin/echo', []);
    const s = ctl.app.shell.execStream('/bin/echo', []);
    ctl.revoke();
    release();
    await expect(p).rejects.toBeInstanceOf(PermissionError);
    await expect(s.done).rejects.toBeInstanceOf(PermissionError);
    noIpc();
  });

  it('未吊销时照常转发', async () => {
    const ctl = createScopedAppController(createTestCoApp(), ID, null, 'tok');
    await ctl.app.shell.exec('/bin/echo', ['hi']);
    expect(h.shellExec).toHaveBeenCalledTimes(1);
  });
});

function makeManager(PluginClass: typeof Plugin): { mgr: PluginManager } {
  const host: ManagerHost = {
    listPluginDirs: () => [
      {
        id: ID,
        manifestText: JSON.stringify({ id: ID, name: 'p', version: '0.1.0' }),
        moduleUrl: 'mod://p',
      },
    ],
    readEnabledIds: () => new Set([ID]),
    mutateEnabledId: () => {},
    importModule: async () => ({ default: PluginClass }),
    killPluginShellProcesses: async () => {},
  };
  return { mgr: new PluginManager(createTestCoApp('1.0.0'), host) };
}

describe('PluginManager:停用先吊销 scoped app,再调 onunload', () => {
  it('停用后,延迟回调里的 shell.exec 被拒、不发 IPC', async () => {
    let later!: () => Promise<unknown>;
    class Deferred extends Plugin {
      onload() {
        later = () => this.app.shell.exec('/bin/echo', ['late']);
      }
    }
    const { mgr } = makeManager(Deferred);
    await mgr.init();
    await mgr.disable(ID);
    await expect(later()).rejects.toBeInstanceOf(PermissionError);
    noIpc();
  });

  it('onunload 超时后仍在跑的代码调用 shell.exec / execStream 被拒', async () => {
    let resume!: () => void;
    const results: Promise<unknown>[] = [];
    class SlowUnload extends Plugin {
      onload() {}
      async onunload() {
        await new Promise<void>((r) => (resume = r));
        results.push(this.app.shell.exec('/bin/echo', ['zombie']));
        results.push(this.app.shell.execStream('/bin/echo', ['zombie']).done);
        // 下方统一断言;先标记已处理,避免断言前被当作未处理 rejection。
        for (const r of results) r.catch(() => {});
      }
    }
    const { mgr } = makeManager(SlowUnload);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.useFakeTimers();
    try {
      await mgr.init();
      const p = mgr.disable(ID);
      await vi.advanceTimersByTimeAsync(PLUGIN_UNLOAD_TIMEOUT_MS);
      await p;
      expect(mgr.listAll()[0]!.status).toBe('disabled');
      resume();
      await vi.advanceTimersByTimeAsync(0);
    } finally {
      vi.useRealTimers();
      warn.mockRestore();
    }
    expect(results).toHaveLength(2);
    for (const r of results) await expect(r).rejects.toBeInstanceOf(PermissionError);
    noIpc();
  });

  it('onunload 内同步调用 shell.exec 同样被拒(吊销发生在 onunload 之前)', async () => {
    let attempt: Promise<unknown> | undefined;
    class UnloadExec extends Plugin {
      onload() {}
      onunload() {
        attempt = this.app.shell.exec('/bin/echo', ['bye']);
        attempt.catch(() => {});
      }
    }
    const { mgr } = makeManager(UnloadExec);
    await mgr.init();
    await mgr.disable(ID);
    await expect(attempt).rejects.toBeInstanceOf(PermissionError);
    noIpc();
  });

  it('激活失败(onload 抛错)后,其已排程的延迟回调同样被拒', async () => {
    let later!: () => Promise<unknown>;
    class FailLater extends Plugin {
      onload() {
        later = () => this.app.shell.exec('/bin/echo', ['late']);
        throw new Error('boom');
      }
    }
    const { mgr } = makeManager(FailLater);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await mgr.init();
    warn.mockRestore();
    expect(mgr.listAll()[0]!.status).toBe('failed');
    await expect(later()).rejects.toBeInstanceOf(PermissionError);
    noIpc();
  });
});
