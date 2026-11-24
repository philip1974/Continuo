// 安全(审计 L1)端到端:插件 app.editor.openFile → scoped app → 主进程 plugin-fs:read-for-editor(真实 handler +
// 真实 PathScopeRegistry + 真实临时目录)→ 宿主编辑器标签;之后用户保存经真实 fs:read-file / fs:write-file handler。
// 审计序列(t4.cjs 的等价物):scope 内有一条指向 scope 外目录的既有链接 L;openFile(P = A/secret.json)的校验通过后
// 并发 rename(A → A_)、rename(L → A)—— 此前宿主按 P 另读一次,标签里显示的是 scope 外的文件。
import { promises as fsp } from 'node:fs';
import { lstat, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
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
const { registerPluginFsHandlers, _resetPluginOpenedPathsForTest, pluginFsIdentityEpoch } = await import(
  '../../../electron/main/services/plugin-fs.service'
);
const { registerFsIpc } = await import('../../../electron/main/ipc/fs.ipc');
const { StubIpcMain, makeFakeEvent } = await import('../sdk-contract/integration/make-stub-ipc');
const { createScopedApp } = await import('@/plugins/scoped-app');
const { InMemoryPermissionStore } = await import('@/plugins/testing/in-memory-stores');
const { coApp } = await import('@/plugins/co-app');
const { useEditorStore } = await import('@/stores/editor.store');
const { openFileByPath, saveFile } = await import('@/panels/Editor/editor-file-actions');

const PLUGIN = 'plugin.opener';
const SECRET = '{"ORIGINAL":1}';
const BENIGN = 'BENIGN';
const GAP_MS = 40;

let root: string;
let work: string;
let outDir: string;
let secretFile: string;
let dirA: string;
let link: string;
let P: string;
let ipc: InstanceType<typeof StubIpcMain>;
let correlator: InstanceType<typeof ScopeRequestCorrelator>;
let token: string;
let plugin: ReturnType<typeof createScopedApp>;
const event = makeFakeEvent({ id: 1, isDestroyed: () => false });
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** 插件只用 SDK 的换入 / 换出(rename 走 plugin-fs 独占锁)。 */
const swapIn = async (): Promise<void> => {
  await plugin.fs.rename(dirA, `${dirA}_`);
  await plugin.fs.rename(link, dirA);
};
const swapOut = async (): Promise<void> => {
  await plugin.fs.rename(dirA, link);
  await plugin.fs.rename(`${dirA}_`, dirA);
};
const tabContents = (): string[] => useEditorStore.getState().tabs.map((t) => t.content);

beforeEach(async () => {
  _resetPluginOpenedPathsForTest();
  useEditorStore.setState({ tabs: [], activeTabId: null, mode: 'edit' });
  root = await realpath(await mkdtemp(join(tmpdir(), 'pfs-editor-e2e-')));
  const home = join(root, 'home');
  work = join(home, 'w');
  outDir = join(root, 'outdir');
  secretFile = join(outDir, 'secret.json');
  dirA = join(work, 'A');
  link = join(work, 'L');
  P = join(dirA, 'secret.json');
  await mkdir(dirA, { recursive: true });
  await mkdir(outDir);
  await writeFile(secretFile, SECRET);
  await writeFile(P, BENIGN);
  await symlink(outDir, link);

  ipc = new StubIpcMain();
  const identity = new IdentityRegistry();
  const scopes = new PathScopeRegistry(identity, { identityCache: { getEpoch: pluginFsIdentityEpoch } });
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
  // scoped app 用到的 coApi.pluginFsRaw 方法接到真实 handler(每个用例重置,用例里可再包一层)
  Object.assign(coApi.pluginFsRaw, {
    readForEditor: (t: string, p: string) => ipc.invokeWithEvent(event, C.READ_FOR_EDITOR, t, p),
    rename: (t: string, a: string, b: string) => ipc.invokeWithEvent(event, C.RENAME, t, a, b),
  });
  vi.mocked(coApi.fs.readFile).mockClear();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(async () => {
  vi.restoreAllMocks();
  correlator.dispose();
  useEditorStore.setState({ tabs: [], activeTabId: null, mode: 'edit' });
  await rm(root, { recursive: true, force: true });
});

describe.skipIf(process.platform === 'win32')('插件 editor.openFile:标签内容来自主进程持锁校验后的读取', () => {
  it('SDK 返回值不变;标签绑定 canonical 路径;开标签不经宿主 fs:read-file 另读', async () => {
    const alias = join(work, 'alias.json');
    await symlink(P, alias);
    expect(await plugin.editor.openFile(alias)).toEqual({ ok: true, lineApplied: false, reason: 'no-line-arg' });
    const [tab] = useEditorStore.getState().tabs;
    expect(tab).toMatchObject({ id: P, filePath: P, content: BENIGN });
    expect(tab!.realPath).toBeUndefined();
    expect(coApi.fs.readFile).not.toHaveBeenCalled();
  });

  it('已开着的标签:再次打开只切换,不用新读到的内容覆盖(含用户未保存的编辑)', async () => {
    await plugin.editor.openFile(P);
    useEditorStore.getState().updateContent(P, 'unsaved user edit');
    await writeFile(P, 'changed on disk');
    expect(await plugin.editor.openFile(P)).toMatchObject({ ok: true });
    expect(tabContents()).toEqual(['unsaved user edit']);
  });

  it('scope 外 → PERMISSION_DENIED,不开标签', async () => {
    expect(await plugin.editor.openFile(secretFile)).toMatchObject({ ok: false, code: 'PERMISSION_DENIED' });
    expect(useEditorStore.getState().tabs).toEqual([]);
  });

  it('审计复现:校验通过后并发换入链接 → 标签是校验时的良性内容,不是 scope 外的文件', async () => {
    let swap: Promise<void> | undefined;
    let swappedInGap: boolean | undefined;
    const realOpen = fsp.open.bind(fsp);
    let fired = false;
    vi.spyOn(fsp, 'open').mockImplementation((async (...a: Parameters<typeof fsp.open>) => {
      if (!fired && a[0] === P) {
        fired = true;
        swap = swapIn();
        await sleep(GAP_MS);
        swappedInGap = (await lstat(dirA)).isSymbolicLink();
      }
      return realOpen(...a);
    }) as never);
    expect(await plugin.editor.openFile(P)).toMatchObject({ ok: true });
    await swap;
    expect(tabContents()).toEqual([BENIGN]);
    expect(swappedInGap).toBe(false);
    expect((await lstat(dirA)).isSymbolicLink()).toBe(true); // 换入照常完成,只是排在读取之后
  });

  it('scope 校验的 IPC 一返回就换入(审计 t4 的时序)→ 标签仍是校验时的良性内容', async () => {
    const raw = coApi.pluginFsRaw as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>;
    for (const name of ['readForEditor']) {
      const orig = raw[name]!;
      raw[name] = async (...args: unknown[]) => {
        const r = await orig(...args);
        await swapIn();
        return r;
      };
    }
    expect(await plugin.editor.openFile(P)).toMatchObject({ ok: true });
    expect(tabContents()).toEqual([BENIGN]);
  });

  it('并发 200 次打开 × 换入(换入相对打开的时机错开):标签读穿 scope 外 0 次', async () => {
    let leaked = 0;
    let opened = 0;
    for (let i = 0; i < 200; i += 1) {
      useEditorStore.setState({ tabs: [], activeTabId: null });
      const flip = (async () => {
        for (let k = 0; k < i % 4; k += 1) await Promise.resolve();
        await swapIn();
      })();
      const [r] = await Promise.all([plugin.editor.openFile(P), flip]);
      if (r.ok) opened += 1;
      if (tabContents().some((c) => c !== BENIGN)) leaked += 1;
      await swapOut();
    }
    expect(leaked).toBe(0);
    expect(opened).toBeGreaterThan(0);
  }, 60_000); // 高负载机器上可超默认 5s
});

describe.skipIf(process.platform === 'win32')('插件打开的标签:打开后路径被换成经链接指向别处 → 保存被拒', () => {
  it('普通保存:FS_DENIED,scope 外文件不变(磁盘比对只会给出可「仍然覆盖」的 EDITOR_DISK_CHANGED,不够)', async () => {
    await plugin.editor.openFile(P);
    useEditorStore.getState().updateContent(P, 'user edit');
    await swapIn();
    const deps = { fs: coApi.fs };
    expect(await saveFile(P, deps)).toMatchObject({ ok: false, code: 'FS_DENIED' });
    // 「仍然覆盖」(跳过磁盘比对)同样被拒
    expect(await saveFile(P, deps, { force: true })).toMatchObject({ ok: false, code: 'FS_DENIED' });
    expect(await readFile(secretFile, 'utf-8')).toBe(SECRET);
  });

  it('路径未变:保存照常', async () => {
    await plugin.editor.openFile(P);
    useEditorStore.getState().updateContent(P, 'user edit');
    expect(await saveFile(P, { fs: coApi.fs })).toMatchObject({ ok: true });
    expect(await readFile(P, 'utf-8')).toBe('user edit');
  });
});

describe.skipIf(process.platform === 'win32')('用户已打开的文件,插件经别名路径再打开 → 只切换到用户的标签', () => {
  const OTHER = 'other.txt';
  const userOpens = async (path: string): Promise<void> => {
    expect(await openFileByPath(path, { fs: coApi.fs })).toMatchObject({ ok: true });
  };
  /** 再开一个别的标签让活动标签移走,才能看出插件打开是否切回用户的标签。 */
  const moveActiveAway = async (): Promise<void> => {
    const other = join(work, OTHER);
    await writeFile(other, 'x');
    await userOpens(other);
  };

  it('用户经目录链接(如 /tmp → /private/tmp)打开,插件用同一原路径打开 → 不新建 canonical 标签', async () => {
    const viaLink = join(work, 'linkA');
    await symlink(dirA, viaLink);
    const userPath = join(viaLink, 'secret.json');
    await userOpens(userPath);
    useEditorStore.getState().updateContent(userPath, 'unsaved user edit');
    await moveActiveAway();

    expect(await plugin.editor.openFile(userPath)).toMatchObject({ ok: true });
    const { tabs, activeTabId } = useEditorStore.getState();
    expect(tabs.map((t) => t.filePath)).toEqual([userPath, join(work, OTHER)]);
    expect(activeTabId).toBe(userPath);
    expect(tabs[0]!.content).toBe('unsaved user edit');
    expect(tabs[0]!.pluginOpenedPath).toBeUndefined();
  });

  // 打开判重与之后找标签跳行同一口径(findPluginOpenedTab):否则切到了经链接路径打开的标签,却按 canonical 路径等
  // view → 行号静默不跳(tab-not-mounted)。
  it('带 line 打开经目录链接已开的文件 → 按已有标签 id 等 view 跳行', async () => {
    const viaLink = join(work, 'linkB');
    await symlink(dirA, viaLink);
    const userPath = join(viaLink, 'secret.json');
    await userOpens(userPath);
    await moveActiveAway();
    const waitSpy = vi.spyOn(useEditorStore.getState(), 'waitForViewRef').mockResolvedValue(null);
    await plugin.editor.openFile(userPath, { line: 2 });
    expect(waitSpy).toHaveBeenCalledWith(userPath, expect.any(Number));
    waitSpy.mockRestore();
  });

  it('用户经文件链接打开(标签带 realPath),插件用真实路径打开 → 切到该标签', async () => {
    const alias = join(work, 'alias.json');
    await symlink(P, alias);
    await userOpens(alias);
    expect(useEditorStore.getState().tabs[0]!.realPath).toBe(P);
    await moveActiveAway();

    expect(await plugin.editor.openFile(P)).toMatchObject({ ok: true });
    const { tabs, activeTabId } = useEditorStore.getState();
    expect(tabs.map((t) => t.filePath)).toEqual([alias, join(work, OTHER)]);
    expect(activeTabId).toBe(alias);
  });
});
