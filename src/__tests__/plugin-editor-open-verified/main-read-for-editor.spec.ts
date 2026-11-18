// 安全:插件发起的 editor.openFile 不再是「checkPath 通过 → 宿主受信通道按原路径另读一次」。主进程在 plugin-fs
// 全局锁的共享锁内完成 scope 校验 + 读取并返回已校验的内容;之后宿主对该标签路径的读 / 写先确认路径没有被换入
// 链接。行为见同目录 README。真实 IPC handler + 真实 PathScopeRegistry + 真实临时目录。
import { promises as fsp } from 'node:fs';
import { lstat, mkdir, mkdtemp, readFile, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const hostIpc = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, raw: unknown) => Promise<unknown>>(),
}));

vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => '') },
  ipcMain: {
    handle: (channel: string, h: (event: unknown, raw: unknown) => Promise<unknown>) =>
      hostIpc.handlers.set(channel, h),
  },
  BrowserWindow: { getAllWindows: () => [], fromWebContents: () => null, fromId: () => null },
  dialog: {},
  shell: {},
}));

const { PLUGIN_FS_CHANNELS: C } = await import('../../../electron/shared/plugin-fs-channels');
const { IdentityRegistry } = await import('../../../electron/main/services/identity-registry.service');
const { PathScopeRegistry } = await import('../../../electron/main/services/path-scope-registry.service');
const { ScopeRequestCorrelator } = await import('../../../electron/main/services/scope-request-correlator');
const { registerPluginFsHandlers, guardPluginOpenedPath, _resetPluginOpenedPathsForTest, pluginFsIdentityEpoch } =
  await import('../../../electron/main/services/plugin-fs.service');
const { guardedReadFileHandler, guardedWriteFileHandler, registerFsIpc } = await import(
  '../../../electron/main/ipc/fs.ipc'
);
const { FS_CHANNELS } = await import('../../../electron/shared/fs-channels');
const { StubIpcMain, makeFakeEvent } = await import('../sdk-contract/integration/make-stub-ipc');

const PLUGIN = 'plugin.opener';
const SECRET = '{"ORIGINAL":1}';
const BENIGN = 'BENIGN';
const GAP_MS = 40;

let root: string;
let home: string; // rw scope
let work: string;
let outDir: string; // scope 外
let secretFile: string;
let dirA: string; // 真目录:A/secret.json = BENIGN
let link: string; // scope 内既有的、指向 scope 外目录的链接(SDK 不能建链接,只能挪既有的)
let P: string; // 插件请求打开的路径:A/secret.json
let ipc: InstanceType<typeof StubIpcMain>;
let correlator: InstanceType<typeof ScopeRequestCorrelator>;
let token: string;
const event = makeFakeEvent({ id: 1, isDestroyed: () => false });

const invoke = (channel: string, ...args: unknown[]): Promise<unknown> =>
  ipc.invokeWithEvent(event, channel, token, ...args);
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** 审计者的换入:rename(A → A_) + rename(链接 → A),之后 P 经链接解析到 scope 外的同名文件。 */
async function swapIn(): Promise<void> {
  await invoke(C.RENAME, dirA, `${dirA}_`);
  await invoke(C.RENAME, link, dirA);
}
async function swapOut(): Promise<void> {
  await invoke(C.RENAME, dirA, link);
  await invoke(C.RENAME, `${dirA}_`, dirA);
}

beforeEach(async () => {
  _resetPluginOpenedPathsForTest();
  root = await realpath(await mkdtemp(join(tmpdir(), 'pfs-editor-open-')));
  home = join(root, 'home');
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
  if (process.platform !== 'win32') await symlink(outDir, link);
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
  token = ((await ipc.invokeWithEvent(event, C.REGISTER_PLUGIN, PLUGIN)) as { token: string }).token;
  scopes.grant(PLUGIN, [{ path: home, mode: 'rw' }]);
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(async () => {
  vi.restoreAllMocks();
  correlator.dispose();
  await rm(root, { recursive: true, force: true });
});

describe('plugin-fs:read-for-editor —— 校验与读取在同一次持锁内', () => {
  it('scope 内的文件 → 已校验的内容 + canonical 路径', async () => {
    expect(await invoke(C.READ_FOR_EDITOR, P)).toEqual({ ok: true, canonicalPath: P, content: BENIGN });
  });

  it.skipIf(process.platform === 'win32')('经 scope 内的符号链接打开 → canonicalPath 是链接解析后的真实路径', async () => {
    const alias = join(work, 'alias.json');
    await symlink(P, alias);
    expect(await invoke(C.READ_FOR_EDITOR, alias)).toEqual({ ok: true, canonicalPath: P, content: BENIGN });
  });

  it('scope 外 / 不存在 → 同一个拒绝结果(不可区分),不抛', async () => {
    const denied = { ok: false, code: 'SCOPE_ERROR', message: 'path out of granted scope' };
    expect(await invoke(C.READ_FOR_EDITOR, secretFile)).toEqual(denied);
    expect(await invoke(C.READ_FOR_EDITOR, join(outDir, 'missing'))).toEqual(denied);
    expect(await invoke(C.READ_FOR_EDITOR, join(work, 'missing'))).toEqual(denied);
  });

  it('与编辑器读取入口同样的规则:目录 → FS_NOT_FILE,非法 UTF-8 → FS_NOT_UTF8', async () => {
    expect(await invoke(C.READ_FOR_EDITOR, dirA)).toMatchObject({ ok: false, code: 'FS_NOT_FILE' });
    const bin = join(work, 'bin.dat');
    await writeFile(bin, Buffer.from([0xff, 0xfe, 0x00, 0x41]));
    expect(await invoke(C.READ_FOR_EDITOR, bin)).toMatchObject({ ok: false, code: 'FS_NOT_UTF8' });
    // 插件自己的 readFile 契约不变(宽松解码)
    expect(typeof (await invoke(C.READ_FILE, bin))).toBe('string');
  });

  it('未知 token → 照抛(身份错误不折叠成拒绝结果)', async () => {
    await expect(ipc.invokeWithEvent(event, C.READ_FOR_EDITOR, 'bogus-token', P)).rejects.toThrow();
  });

  it.skipIf(process.platform === 'win32')('审计复现:打开之后换入链接 → 再次打开被拒,不读到 scope 外的内容', async () => {
    expect(await invoke(C.READ_FOR_EDITOR, P)).toMatchObject({ ok: true, content: BENIGN });
    await swapIn();
    expect(await readFile(P, 'utf-8')).toBe(SECRET); // 按路径字符串读(此前宿主受信通道的做法)会读到 scope 外
    expect(await invoke(C.READ_FOR_EDITOR, P)).toEqual({
      ok: false,
      code: 'SCOPE_ERROR',
      message: 'path out of granted scope',
    });
  });

  it.skipIf(process.platform === 'win32')('读取处于校验与操作之间时,并发的换入被挡在外面:读到的是校验时的文件', async () => {
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
    expect(await invoke(C.READ_FOR_EDITOR, P)).toEqual({ ok: true, canonicalPath: P, content: BENIGN });
    expect(swappedInGap).toBe(false);
    await swap;
    expect((await lstat(dirA)).isSymbolicLink()).toBe(true); // 换入本身照常完成,只是排在后面
  });

  it.skipIf(process.platform === 'win32')('并发 3000 次打开 × 反复换入换出:没有一次读到 scope 外的内容', async () => {
    const ROUNDS = 300;
    const PER = 10;
    let leaked = 0;
    let benign = 0;
    let denied = 0;
    const read = async (): Promise<void> => {
      const r = (await invoke(C.READ_FOR_EDITOR, P)) as { ok: boolean; content?: string };
      if (!r.ok) denied += 1;
      else if (r.content === BENIGN) benign += 1;
      else leaked += 1;
    };
    for (let i = 0; i < ROUNDS; i += 1) {
      const half = Array.from({ length: PER / 2 }, read);
      const flip = i % 2 === 0 ? swapIn() : swapOut();
      await Promise.all([...half, flip, ...Array.from({ length: PER / 2 }, read)]);
    }
    expect(leaked).toBe(0);
    expect(benign + denied).toBe(ROUNDS * PER);
    expect(benign).toBeGreaterThan(0);
    expect(denied).toBeGreaterThan(0);
  }, 60_000); // 高负载机器上 3000 次真实文件系统调用可超默认 5s
});

describe.skipIf(process.platform === 'win32')('插件打开过的路径:宿主之后的读 / 写先确认路径没有被换入链接', () => {
  it('未被插件打开过的路径:直通,不取锁、不多做文件系统调用', async () => {
    const realpathSpy = vi.spyOn(fsp, 'realpath');
    await swapIn(); // P 经链接指向 scope 外 —— 但它不是插件打开的标签,宿主(用户自己)照常跟随链接
    realpathSpy.mockClear();
    expect(await guardPluginOpenedPath(P, async () => 'ran')).toBe('ran');
    expect(realpathSpy).not.toHaveBeenCalled();
    expect((await guardedReadFileHandler({ path: P })).content).toBe(SECRET);
  });

  it('打开后路径不变:宿主读 / 写照常', async () => {
    await invoke(C.READ_FOR_EDITOR, P);
    expect((await guardedReadFileHandler({ path: P })).content).toBe(BENIGN);
    await guardedWriteFileHandler({ path: P, content: 'edited' });
    expect(await readFile(P, 'utf-8')).toBe('edited');
    // 编辑器保存是「临时文件 + rename」(inode 变了),路径仍是 canonical → 之后照常
    expect((await guardedReadFileHandler({ path: P })).content).toBe('edited');
  });

  it('打开后换入链接:保存被拒(FS_DENIED),scope 外的文件不变;重载 / 保存前比对的读同样被拒', async () => {
    await invoke(C.READ_FOR_EDITOR, P);
    await swapIn();
    await expect(guardedWriteFileHandler({ path: P, content: 'user edit' })).rejects.toMatchObject({ code: 'FS_DENIED' });
    expect(await readFile(secretFile, 'utf-8')).toBe(SECRET);
    await expect(guardedReadFileHandler({ path: P })).rejects.toMatchObject({ code: 'FS_DENIED' });
    // 换回去之后恢复
    await swapOut();
    expect((await guardedReadFileHandler({ path: P })).content).toBe(BENIGN);
  });

  it('宿主编辑器通道 fs:read-file / fs:write-file 注册的就是带确认的处理器', async () => {
    registerFsIpc();
    const hostEvent = { sender: { id: 9 }, senderFrame: { url: 'file:///app/index.html' } };
    const host = (channel: string, raw: unknown): Promise<unknown> => hostIpc.handlers.get(channel)!(hostEvent, raw);
    await invoke(C.READ_FOR_EDITOR, P);
    expect(await host(FS_CHANNELS.READ_FILE, { path: P })).toMatchObject({ ok: true, data: { content: BENIGN } });
    await swapIn();
    expect(await host(FS_CHANNELS.READ_FILE, { path: P })).toMatchObject({ ok: false, code: 'FS_DENIED' });
    expect(await host(FS_CHANNELS.WRITE_FILE, { path: P, content: 'user edit' })).toMatchObject({
      ok: false,
      code: 'FS_DENIED',
    });
    expect(await readFile(secretFile, 'utf-8')).toBe(SECRET);
  });

  it('叶子被换成(悬空)链接:保存不会经它在别处建文件', async () => {
    await invoke(C.READ_FOR_EDITOR, P);
    await rm(P);
    const elsewhere = join(outDir, 'created-by-save');
    await symlink(elsewhere, P);
    await expect(guardedWriteFileHandler({ path: P, content: 'x' })).rejects.toMatchObject({ code: 'FS_DENIED' });
    await expect(lstat(elsewhere)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('文件被删(路径各级仍是真目录):保存照常重建', async () => {
    await invoke(C.READ_FOR_EDITOR, P);
    await rm(P);
    await guardedWriteFileHandler({ path: P, content: 'recreated' });
    expect(await readFile(P, 'utf-8')).toBe('recreated');
  });

  it('确认与写入在同一次持锁内:写入进行期间,插件的换入排在后面', async () => {
    await invoke(C.READ_FOR_EDITOR, P);
    let swap: Promise<void> | undefined;
    let swappedInGap: boolean | undefined;
    await guardPluginOpenedPath(P, async () => {
      swap = swapIn();
      await sleep(GAP_MS);
      swappedInGap = (await lstat(dirA)).isSymbolicLink();
    });
    expect(swappedInGap).toBe(false);
    await swap;
    expect((await lstat(dirA)).isSymbolicLink()).toBe(true);
  });

  it('外部进程把目录换成链接(不经 plugin-fs):同样被拒', async () => {
    await invoke(C.READ_FOR_EDITOR, P);
    await rename(dirA, `${dirA}_`);
    await rename(link, dirA);
    await expect(guardedWriteFileHandler({ path: P, content: 'x' })).rejects.toMatchObject({ code: 'FS_DENIED' });
    expect(await readFile(secretFile, 'utf-8')).toBe(SECRET);
  });
});
