// 安全:插件经 editor.openFile 打开的标签,主进程「路径没被换入链接」的确认记录只在内存里,且数量有上限。
// F1(重启):这类标签不进会话快照 —— 否则重启后宿主按路径重读,插件此前换入的链接让标签显示 / 保存到 scope 外。
// F2(记录上限):满额后拒绝新的打开而不是淘汰旧记录;记录随标签关闭释放。行为见同目录 README。
// 插件 scoped app → 真实主进程 handler(plugin-fs + 宿主 fs:read-file / fs:write-file)→ 真实编辑器 store → 真实快照 /
// 会话恢复,真实临时目录。
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  hostHandlers: new Map<string, (event: unknown, raw: unknown) => Promise<unknown>>(),
}));

vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => '') },
  ipcMain: {
    handle: (channel: string, fn: (event: unknown, raw: unknown) => Promise<unknown>) =>
      h.hostHandlers.set(channel, fn),
  },
  BrowserWindow: { getAllWindows: () => [], fromWebContents: () => null, fromId: () => null },
  dialog: {},
  shell: {},
}));

vi.mock('@/lib/co-api', async () => {
  const { FS_CHANNELS, toFsReadFileResult, toFsWriteFileResult } = await import(
    '../../../electron/shared/fs-channels'
  );
  const hostEvent = { sender: { id: 9 }, senderFrame: { url: 'file:///app/index.html' } };
  const host = (channel: string, raw: unknown): Promise<never> =>
    h.hostHandlers.get(channel)!(hostEvent, raw) as Promise<never>;
  return {
    coApi: {
      pluginFsRaw: {}, // 各方法在 beforeEach 接到真实 handler
      fs: {
        readFile: vi.fn(async (p: string) => toFsReadFileResult(await host(FS_CHANNELS.READ_FILE, { path: p }), 8192)),
        writeFile: vi.fn(async (p: string, content: string) =>
          toFsWriteFileResult(await host(FS_CHANNELS.WRITE_FILE, { path: p, content })),
        ),
      },
    },
  };
});

const { coApi } = await import('@/lib/co-api');
const { PLUGIN_FS_CHANNELS: C } = await import('../../../electron/shared/plugin-fs-channels');
const { IdentityRegistry } = await import('../../../electron/main/services/identity-registry.service');
const { PathScopeRegistry } = await import('../../../electron/main/services/path-scope-registry.service');
const { ScopeRequestCorrelator } = await import('../../../electron/main/services/scope-request-correlator');
const {
  registerPluginFsHandlers,
  _resetPluginOpenedPathsForTest,
  _pluginOpenedPathRefsForTest: refs,
  pluginFsIdentityEpoch,
  PLUGIN_OPENED_PATHS_MAX,
  PLUGIN_OPENED_PATHS_PER_PLUGIN_MAX: PER_PLUGIN,
} = await import('../../../electron/main/services/plugin-fs.service');
const { registerFsIpc } = await import('../../../electron/main/ipc/fs.ipc');
const { FS_CHANNELS } = await import('../../../electron/shared/fs-channels');
const { StubIpcMain, makeFakeEvent } = await import('../sdk-contract/integration/make-stub-ipc');
const { createScopedApp, createScopedAppController } = await import('@/plugins/scoped-app');
const { InMemoryPermissionStore } = await import('@/plugins/permissions');
const { coApp } = await import('@/plugins/co-app');
const { useEditorStore } = await import('@/stores/editor.store');
const { useWorkspaceStore } = await import('@/stores/workspace.store');
const { openFileByPath, saveFile } = await import('@/panels/Editor/editor-file-actions');
const { snapshotFromStores, hydrateEditorTabs } = await import('@/lib/persist/explorer-persist');

const PLUGIN = 'plugin.opener';
const SECRET = 'outside secret';
const BENIGN = 'BENIGN';

let root: string;
let home: string;
let work: string;
let outDir: string;
let T: string; // 插件打开的路径:w/a/sub/x.md
let ipc: InstanceType<typeof StubIpcMain>;
let correlator: InstanceType<typeof ScopeRequestCorrelator>;
let token: string;
let plugin: ReturnType<typeof createScopedApp>;
let scopes: InstanceType<typeof PathScopeRegistry>;
const event = makeFakeEvent({ id: 1, isDestroyed: () => false });
const invoke = (channel: string, ...args: unknown[]): Promise<unknown> =>
  ipc.invokeWithEvent(event, channel, token, ...args);
const hostRead = (p: string): Promise<unknown> =>
  h.hostHandlers.get(FS_CHANNELS.READ_FILE)!({ sender: { id: 9 }, senderFrame: { url: 'file:///app/index.html' } }, { path: p });
/** release 经 Promise 链异步发出:等它们落到主进程。 */
const flush = async (): Promise<void> => {
  for (let i = 0; i < 10; i++) await new Promise<void>((r) => setImmediate(r));
};
const editorDeps = () => ({ fs: coApi.fs, store: useEditorStore });

/** 审计序列:rename(w/a → w/a_) + rename(w/MH → w/a)。MH 是 scope 内指向 scope 外目录的链接(可经 cp 获得)。 */
async function swapIn(): Promise<void> {
  await plugin.fs.rename(join(work, 'a'), join(work, 'a_'));
  await plugin.fs.rename(join(work, 'MH'), join(work, 'a'));
}

beforeEach(async () => {
  useEditorStore.setState({ tabs: [], activeTabId: null, mode: 'edit' });
  useWorkspaceStore.setState({ root: null });
  await flush(); // 上一个用例的标签释放先落地,再清空记录
  _resetPluginOpenedPathsForTest();
  root = await realpath(await mkdtemp(join(tmpdir(), 'pfs-editor-life-')));
  home = join(root, 'home');
  work = join(home, 'w');
  outDir = join(root, 'outdir');
  T = join(work, 'a', 'sub', 'x.md');
  await mkdir(join(work, 'a', 'sub'), { recursive: true });
  await mkdir(join(outDir, 'sub'), { recursive: true });
  await writeFile(T, BENIGN);
  await writeFile(join(outDir, 'sub', 'x.md'), SECRET);
  if (process.platform !== 'win32') await symlink(outDir, join(work, 'MH'));

  ipc = new StubIpcMain();
  const identity = new IdentityRegistry();
  scopes = new PathScopeRegistry(identity, { identityCache: { getEpoch: pluginFsIdentityEpoch } });
  correlator = new ScopeRequestCorrelator({ ttlMs: 60_000, gcIntervalMs: 60_000 });
  registerPluginFsHandlers(ipc as never, {
    identityRegistry: identity,
    pathScopeRegistry: scopes,
    correlator,
  });
  registerFsIpc();
  token = ((await ipc.invokeWithEvent(event, C.REGISTER_PLUGIN, PLUGIN)) as { token: string }).token;
  scopes.grant(PLUGIN, [{ path: home, mode: 'rw' }]);
  const perms = new InMemoryPermissionStore();
  await perms.grant(PLUGIN, ['fs']);
  plugin = createScopedApp(coApp, PLUGIN, perms, token);
  Object.assign(coApi.pluginFsRaw, {
    readForEditor: (t: string, p: string) => ipc.invokeWithEvent(event, C.READ_FOR_EDITOR, t, p),
    releaseEditorPath: (p: string) => ipc.invokeWithEvent(event, C.RELEASE_EDITOR_PATH, p),
    rename: (t: string, a: string, b: string) => ipc.invokeWithEvent(event, C.RENAME, t, a, b),
  });
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(async () => {
  vi.restoreAllMocks();
  correlator.dispose();
  useEditorStore.setState({ tabs: [], activeTabId: null, mode: 'edit' });
  await flush();
  await rm(root, { recursive: true, force: true });
});

describe('F1:插件打开的标签不进会话快照', () => {
  it('插件打开的标签不进 openFilePaths(是活动标签时 activePath 也不记);用户打开的照常', async () => {
    const userFile = join(work, 'user.md');
    await writeFile(userFile, 'mine');
    expect(await openFileByPath(userFile, editorDeps())).toMatchObject({ ok: true });
    expect(await plugin.editor.openFile(T)).toMatchObject({ ok: true });
    expect(useEditorStore.getState().tabs.map((t) => t.id)).toEqual([userFile, T]);
    expect(useEditorStore.getState().activeTabId).toBe(T);
    const snap = snapshotFromStores();
    expect(snap.windows[0]!.editor).toEqual({ openFilePaths: [userFile], activePath: null });
  });

  it('标签之后被用户「接管」(用户从文件树再打开同一路径)→ 只是切换,标记保留到关闭,仍不进快照', async () => {
    await plugin.editor.openFile(T);
    expect(await openFileByPath(T, editorDeps())).toMatchObject({ ok: true });
    const [tab] = useEditorStore.getState().tabs;
    expect(tab).toMatchObject({ id: T, pluginOpenedPath: T });
    expect(collectPaths()).toEqual([]);
  });

  it('用户先打开、插件再打开同一路径 → 用户的标签不被打标记,照常进快照', async () => {
    await openFileByPath(T, editorDeps());
    await plugin.editor.openFile(T);
    expect(useEditorStore.getState().tabs).toHaveLength(1);
    expect(useEditorStore.getState().tabs[0]!.pluginOpenedPath).toBeUndefined();
    expect(collectPaths()).toEqual([T]);
  });

  it.skipIf(process.platform === 'win32')(
    '审计重启序列:openFile(T) → 换入链接 → 快照 → 重启(主进程记录清空)→ 会话恢复:T 不被恢复,读不到也写不到 scope 外',
    async () => {
      expect(await plugin.editor.openFile(T)).toMatchObject({ ok: true });
      await swapIn();
      // 本次运行内:宿主对 T 的读写被拒,标签还在
      expect(await hostRead(T)).toMatchObject({ ok: false, code: 'FS_DENIED' });
      expect(useEditorStore.getState().tabs.map((t) => t.id)).toEqual([T]);
      const snap = snapshotFromStores();

      // 重启:主进程内存记录清空、编辑器为空,按快照恢复(宿主受信 fs:read-file)
      _resetPluginOpenedPathsForTest();
      useEditorStore.setState({ tabs: [], activeTabId: null });
      await hydrateEditorTabs(snap, { readFile: coApi.fs.readFile });
      const restored = useEditorStore.getState().tabs;
      expect(restored.map((t) => t.content)).not.toContain(SECRET);
      expect(restored).toEqual([]);
      // 若被恢复,用户保存会经链接写到 scope 外 —— 确认 scope 外文件未变
      expect(await readFile(join(outDir, 'sub', 'x.md'), 'utf-8')).toBe(SECRET);
    },
  );
});

function collectPaths(): readonly string[] {
  const snap = snapshotFromStores();
  return snap.windows[0]!.editor!.openFilePaths;
}

describe('F2:记录满额拒绝新打开(不淘汰旧记录),记录随标签关闭释放', () => {
  it.skipIf(process.platform === 'win32')(
    `打开 T 后再打开 ${PER_PLUGIN} 个别的文件:超出该插件名额的部分 FS_BUSY,T 的记录仍生效(换入后宿主读写 T 被拒)`,
    async () => {
      expect(await invoke(C.READ_FOR_EDITOR, T)).toMatchObject({ ok: true });
      const others = join(work, 'others');
      await mkdir(others);
      const files = Array.from({ length: PER_PLUGIN }, (_, i) => join(others, `f${i}.txt`));
      for (let i = 0; i < files.length; i += 256) {
        await Promise.all(files.slice(i, i + 256).map((f) => writeFile(f, 'x')));
      }
      const results: { ok: boolean; code?: string }[] = [];
      for (let i = 0; i < files.length; i += 64) {
        results.push(
          ...((await Promise.all(files.slice(i, i + 64).map((f) => invoke(C.READ_FOR_EDITOR, f)))) as {
            ok: boolean;
            code?: string;
          }[]),
        );
      }
      expect(results.filter((r) => r.ok)).toHaveLength(PER_PLUGIN - 1);
      expect(results.filter((r) => !r.ok)).toEqual([{ ok: false, code: 'FS_BUSY', message: expect.any(String) }]);
      expect(refs()).toBe(PER_PLUGIN);
      await swapIn();
      expect(await hostRead(T)).toMatchObject({ ok: false, code: 'FS_DENIED' });
      // 释放一份后又能打开
      await ipc.invokeWithEvent(event, C.RELEASE_EDITOR_PATH, files[0]);
      expect(await invoke(C.READ_FOR_EDITOR, files[1])).toMatchObject({ ok: true });
    },
    120_000,
  );

  it('满额时插件 editor.openFile 得到 EXCEPTION(FS_BUSY 的消息),不开标签', async () => {
    for (let i = 0; i < PER_PLUGIN; i += 64) {
      await Promise.all(Array.from({ length: 64 }, () => invoke(C.READ_FOR_EDITOR, T)));
    }
    expect(refs()).toBe(PER_PLUGIN);
    const r = await plugin.editor.openFile(T);
    expect(r).toMatchObject({ ok: false, code: 'EXCEPTION' });
    expect(useEditorStore.getState().tabs).toEqual([]);
  }, 60_000);

  /** 在窗口 1 注册另一个插件(同样授予 home),返回其 token。 */
  async function otherPlugin(id: string): Promise<string> {
    const t = ((await ipc.invokeWithEvent(event, C.REGISTER_PLUGIN, id)) as { token: string }).token;
    scopes.grant(id, [{ path: home, mode: 'rw' }]);
    return t;
  }
  async function fill(tok: string, n: number): Promise<void> {
    for (let i = 0; i < n; i += 64) {
      await Promise.all(
        Array.from({ length: Math.min(64, n - i) }, () => ipc.invokeWithEvent(event, C.READ_FOR_EDITOR, tok, T)),
      );
    }
  }

  it('名额按插件:插件 A 占满自己的名额后,插件 B 的 editor.openFile 照常(此前全局共享,A 开满后所有插件都失败)', async () => {
    await fill(token, PER_PLUGIN);
    expect(await invoke(C.READ_FOR_EDITOR, T)).toMatchObject({ ok: false, code: 'FS_BUSY' });
    expect(await plugin.editor.openFile(T)).toMatchObject({ ok: false, code: 'EXCEPTION' });
    const tb = await otherPlugin('plugin.b');
    const perms = new InMemoryPermissionStore();
    await perms.grant('plugin.b', ['fs']);
    const b = createScopedApp(coApp, 'plugin.b', perms, tb);
    const other = join(work, 'other.md');
    await writeFile(other, 'o');
    expect(await b.editor.openFile(other)).toMatchObject({ ok: true });
    await flush();
    expect(useEditorStore.getState().tabs.map((t) => t.pluginOpenedPath)).toEqual([other]);
    expect(refs('plugin.b')).toBe(1);
    expect(refs(PLUGIN)).toBe(PER_PLUGIN);
  }, 60_000);

  it('全部插件合计到全局上限后,名额未满的插件也 FS_BUSY;释放一份后恢复', async () => {
    const plugins = [token];
    while (plugins.length * PER_PLUGIN < PLUGIN_OPENED_PATHS_MAX) plugins.push(await otherPlugin(`plugin.f${plugins.length}`));
    for (const t of plugins) await fill(t, PER_PLUGIN);
    expect(refs()).toBe(PLUGIN_OPENED_PATHS_MAX);
    const late = await otherPlugin('plugin.late');
    expect(await ipc.invokeWithEvent(event, C.READ_FOR_EDITOR, late, T)).toMatchObject({ ok: false, code: 'FS_BUSY' });
    await ipc.invokeWithEvent(event, C.RELEASE_EDITOR_PATH, T);
    expect(await ipc.invokeWithEvent(event, C.READ_FOR_EDITOR, late, T)).toMatchObject({ ok: true });
  }, 120_000);

  it('同一窗口两个插件打开同一路径:后者「已开着只切换」当即释放的是它自己的那份;关标签归还前者的', async () => {
    const tb = await otherPlugin('plugin.b');
    const perms = new InMemoryPermissionStore();
    await perms.grant('plugin.b', ['fs']);
    const b = createScopedApp(coApp, 'plugin.b', perms, tb);
    expect(await plugin.editor.openFile(T)).toMatchObject({ ok: true });
    expect(await b.editor.openFile(T)).toMatchObject({ ok: true });
    await flush();
    expect(useEditorStore.getState().tabs).toHaveLength(1);
    expect([refs(PLUGIN), refs('plugin.b')]).toEqual([1, 0]);
    useEditorStore.getState().closeTab(T);
    await flush();
    expect([refs(PLUGIN), refs()]).toEqual([0, 0]);
  });

  it('一个标签持有一份:关闭标签即释放;已开着再打开(只切换)不多占', async () => {
    await plugin.editor.openFile(T);
    await plugin.editor.openFile(T);
    await plugin.editor.openFile(T);
    await flush();
    expect(useEditorStore.getState().tabs).toHaveLength(1);
    expect(refs()).toBe(1);
    useEditorStore.getState().closeTab(T);
    await flush();
    expect(refs()).toBe(0);
  });

  it(`反复打开 / 关闭 ${PLUGIN_OPENED_PATHS_MAX + 10} 次后仍能打开(名额不泄漏)`, async () => {
    for (let i = 0; i < PLUGIN_OPENED_PATHS_MAX + 10; i++) {
      expect(await plugin.editor.openFile(T)).toMatchObject({ ok: true });
      useEditorStore.getState().closeTab(T);
    }
    await flush();
    expect(refs()).toBe(0);
  }, 120_000);

  it('读取成功后插件被吊销(不开标签)→ 当即释放', async () => {
    const perms = new InMemoryPermissionStore();
    await perms.grant(PLUGIN, ['fs']);
    const ctl = createScopedAppController(coApp, PLUGIN, perms, token);
    const raw = coApi.pluginFsRaw as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>;
    const orig = raw.readForEditor!;
    raw.readForEditor = async (...a: unknown[]) => {
      const r = await orig(...a);
      ctl.revoke();
      return r;
    };
    expect(await ctl.app.editor.openFile(T)).toMatchObject({ ok: false, code: 'PERMISSION_DENIED' });
    await flush();
    expect(useEditorStore.getState().tabs).toEqual([]);
    expect(refs()).toBe(0);
  });

  it('标签以其它方式消失(删除文件 / 整体清空)同样释放', async () => {
    const other = join(work, 'other.md');
    await writeFile(other, 'o');
    await plugin.editor.openFile(T);
    await plugin.editor.openFile(other);
    await flush();
    expect(refs()).toBe(2);
    useEditorStore.getState().removePaths([T]);
    await flush();
    expect(refs()).toBe(1);
    useEditorStore.setState({ tabs: [], activeTabId: null });
    await flush();
    expect(refs()).toBe(0);
  });

  it('释放只作用于发起窗口自己的记录;窗口关闭 / 重载时整窗释放', async () => {
    let gone: (() => void) | undefined;
    const ev2 = {
      ...makeFakeEvent({ id: 2, isDestroyed: () => false }),
      sender: { id: 2, send: vi.fn(), isDestroyed: () => false, once: vi.fn((_: string, cb: () => void) => (gone = cb)), on: vi.fn() },
    };
    await ipc.invokeWithEvent(ev2, C.REGISTER_PLUGIN, 'plugin.other'); // 挂上窗口 2 的 wc-gone 钩子
    expect(await invoke(C.READ_FOR_EDITOR, T)).toMatchObject({ ok: true });
    // 窗口 2 释放窗口 1 的记录 → no-op
    await ipc.invokeWithEvent(ev2, C.RELEASE_EDITOR_PATH, T);
    expect(refs()).toBe(1);
    // 窗口 2 关闭:不影响窗口 1
    gone?.();
    expect(refs()).toBe(1);
  });

  it('窗口(webContents)消失 → 释放它持有的全部记录', async () => {
    let gone: (() => void) | undefined;
    const ev3 = {
      ...makeFakeEvent({ id: 3, isDestroyed: () => false }),
      sender: { id: 3, send: vi.fn(), isDestroyed: () => false, once: vi.fn((_: string, cb: () => void) => (gone = cb)), on: vi.fn() },
    };
    const t3 = ((await ipc.invokeWithEvent(ev3, C.REGISTER_PLUGIN, PLUGIN)) as { token: string }).token;
    expect(await ipc.invokeWithEvent(ev3, C.READ_FOR_EDITOR, t3, T)).toMatchObject({ ok: true });
    expect(await ipc.invokeWithEvent(ev3, C.READ_FOR_EDITOR, t3, T)).toMatchObject({ ok: true });
    expect(await invoke(C.READ_FOR_EDITOR, T)).toMatchObject({ ok: true });
    expect(refs()).toBe(3);
    gone!();
    expect(refs()).toBe(1);
  });

  it('保存仍受确认:换入后「仍然覆盖」保存被拒,scope 外文件不变', async () => {
    if (process.platform === 'win32') return;
    await plugin.editor.openFile(T);
    useEditorStore.getState().updateContent(T, 'edit');
    await swapIn();
    expect(await saveFile(T, editorDeps(), { force: true })).toMatchObject({ ok: false, code: 'FS_DENIED' });
    expect(await readFile(join(outDir, 'sub', 'x.md'), 'utf-8')).toBe(SECRET);
  });
});
