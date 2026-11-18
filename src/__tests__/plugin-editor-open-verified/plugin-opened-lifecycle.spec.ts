// 安全:插件经 editor.openFile 打开的标签,主进程「路径没被换入链接」的确认记录只在内存里,且数量有上限。
// F1(重启):这类标签不进会话快照 —— 否则重启后宿主按路径重读,插件此前换入的链接让标签显示 / 保存到 scope 外。
// 行为见同目录 README。
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
  pluginFsIdentityEpoch,
} = await import('../../../electron/main/services/plugin-fs.service');
const { registerFsIpc } = await import('../../../electron/main/ipc/fs.ipc');
const { FS_CHANNELS } = await import('../../../electron/shared/fs-channels');
const { StubIpcMain, makeFakeEvent } = await import('../sdk-contract/integration/make-stub-ipc');
const { createScopedApp } = await import('@/plugins/scoped-app');
const { InMemoryPermissionStore } = await import('@/plugins/permissions');
const { coApp } = await import('@/plugins/co-app');
const { useEditorStore } = await import('@/stores/editor.store');
const { useWorkspaceStore } = await import('@/stores/workspace.store');
const { openFileByPath } = await import('@/panels/Editor/editor-file-actions');
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
const event = makeFakeEvent({ id: 1, isDestroyed: () => false });
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
  const scopes = new PathScopeRegistry(identity, { identityCache: { getEpoch: pluginFsIdentityEpoch } });
  correlator = new ScopeRequestCorrelator({ ttlMs: 60_000, gcIntervalMs: 60_000 });
  registerPluginFsHandlers(ipc as never, {
    identityRegistry: identity,
    pathScopeRegistry: scopes,
    correlator,
    webContentsForSender: () => null,
  });
  registerFsIpc();
  token = ((await ipc.invokeWithEvent(event, C.REGISTER_PLUGIN, PLUGIN)) as { token: string }).token;
  scopes.grant(PLUGIN, [{ path: home, mode: 'rw' }]);
  const perms = new InMemoryPermissionStore();
  await perms.grant(PLUGIN, ['fs']);
  plugin = createScopedApp(coApp, PLUGIN, perms, token);
  Object.assign(coApi.pluginFsRaw, {
    readForEditor: (t: string, p: string) => ipc.invokeWithEvent(event, C.READ_FOR_EDITOR, t, p),
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
