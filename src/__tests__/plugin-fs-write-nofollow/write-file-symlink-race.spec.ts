// 安全:plugin-fs 的写操作在「scope 校验通过的 父目录 realpath + 叶子名」上进行,且不跟随叶子符号链接 ——
// 校验与实际操作的跟随策略一致。行为见同目录 README。
//
// 用 vi.mock 包住写入器,在「scope 校验之后、写入之前」把叶子换成指向 scope 外的符号链接,确定性复现竞态窗口
// (做法同 agent-terminal-mcp-install-stop-hook/install-stop-hook-symlink-race.spec.ts)。
import { constants as fsConstants, promises as fsp } from 'node:fs';
import { lstat, mkdir, mkdtemp, readFile, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const hook = vi.hoisted(() => ({
  beforeWrite: null as (() => Promise<void>) | null,
  calls: [] as { writer: 'follow' | 'nofollow'; path: string }[],
}));

vi.mock('electron', () => ({ app: { getPath: vi.fn(() => '') } }));
vi.mock('../../../electron/main/ipc/fs/atomic-write', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../../../electron/main/ipc/fs/atomic-write')>();
  return {
    ...orig,
    atomicWriteFile: async (...args: Parameters<typeof orig.atomicWriteFile>) => {
      hook.calls.push({ writer: 'follow', path: args[0] });
      await hook.beforeWrite?.();
      return orig.atomicWriteFile(...args);
    },
    atomicReplaceFileNoFollow: async (...args: Parameters<typeof orig.atomicReplaceFileNoFollow>) => {
      hook.calls.push({ writer: 'nofollow', path: args[0] });
      await hook.beforeWrite?.();
      return orig.atomicReplaceFileNoFollow(...args);
    },
  };
});

const { PLUGIN_FS_CHANNELS } = await import('../../../electron/shared/plugin-fs-channels');
const { IdentityRegistry } = await import('../../../electron/main/services/identity-registry.service');
const { PathScopeRegistry } = await import('../../../electron/main/services/path-scope-registry.service');
const { ScopeRequestCorrelator } = await import('../../../electron/main/services/scope-request-correlator');
const { registerPluginFsHandlers } = await import('../../../electron/main/services/plugin-fs.service');
const { StubIpcMain, makeFakeEvent } = await import('../sdk-contract/integration/make-stub-ipc');

const PLUGIN = 'plugin.race';
const SECRET = 'outside secret\n';
let root: string;
let proj: string; // rw scope
let secret: string; // scope 外
let ipc: InstanceType<typeof StubIpcMain>;
let correlator: InstanceType<typeof ScopeRequestCorrelator>;
let token: string;
const event = makeFakeEvent({ id: 1, isDestroyed: () => false });

const invoke = (channel: string, ...args: unknown[]): Promise<unknown> =>
  ipc.invokeWithEvent(event, channel, token, ...args);

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'pfs-nofollow-')));
  proj = join(root, 'proj');
  await mkdir(proj);
  secret = join(root, 'secret.txt');
  await writeFile(secret, SECRET);
  ipc = new StubIpcMain();
  const identity = new IdentityRegistry();
  const scopes = new PathScopeRegistry(identity);
  correlator = new ScopeRequestCorrelator({ ttlMs: 60_000, gcIntervalMs: 60_000 });
  registerPluginFsHandlers(ipc as never, {
    identityRegistry: identity,
    pathScopeRegistry: scopes,
    correlator,
  });
  token = ((await ipc.invokeWithEvent(event, PLUGIN_FS_CHANNELS.REGISTER_PLUGIN, PLUGIN)) as { token: string }).token;
  scopes.grant(PLUGIN, [{ path: proj, mode: 'rw' }]);
});

afterEach(async () => {
  hook.beforeWrite = null;
  hook.calls.length = 0;
  vi.restoreAllMocks();
  correlator.dispose();
  await rm(root, { recursive: true, force: true });
});

describe.skipIf(process.platform === 'win32')('plugin-fs writeFile:校验之后叶子被换成符号链接', () => {
  it('校验时 x 不存在,写入前 x 变成指向 scope 外的链接 → 外部文件不变,被替换的是链接本身', async () => {
    const link = join(proj, 'link');
    const x = join(proj, 'x');
    await symlink(secret, link); // scope 内一条指向 scope 外的链接(真实仓库常见)
    hook.beforeWrite = () => rename(link, x); // 等价于并发的 app.fs.rename(link, x)

    await invoke(PLUGIN_FS_CHANNELS.WRITE_FILE, x, 'plugin data');

    expect(await readFile(secret, 'utf-8')).toBe(SECRET);
    const st = await lstat(x);
    expect(st.isSymbolicLink()).toBe(false);
    expect(st.isFile()).toBe(true);
    expect(await readFile(x, 'utf-8')).toBe('plugin data');
  });

  it('校验时 x 是普通文件,写入前被换成链接 → 同样不写穿', async () => {
    const x = join(proj, 'x');
    await writeFile(x, 'old');
    hook.beforeWrite = async () => {
      await rm(x);
      await symlink(secret, x);
    };

    await invoke(PLUGIN_FS_CHANNELS.WRITE_FILE, x, 'plugin data');

    expect(await readFile(secret, 'utf-8')).toBe(SECRET);
    expect((await lstat(x)).isSymbolicLink()).toBe(false);
    expect(await readFile(x, 'utf-8')).toBe('plugin data');
  });

  it('不依赖时序:WRITE_FILE 用的是 no-follow 写入器,作用在校验得到的 父目录 realpath + 叶子名 上', async () => {
    const x = join(proj, 'sub', 'x');
    await mkdir(join(proj, 'sub'));
    await invoke(PLUGIN_FS_CHANNELS.WRITE_FILE, x, 'plugin data');
    expect(hook.calls).toEqual([{ writer: 'nofollow', path: x }]);
    expect(await readFile(x, 'utf-8')).toBe('plugin data');
  });

  it('非竞态:叶子本来就是链接 → 校验阶段拒绝(symlink leaf rejected),写入器不被调用', async () => {
    const link = join(proj, 'link');
    await symlink(secret, link);
    await expect(invoke(PLUGIN_FS_CHANNELS.WRITE_FILE, link, 'plugin data')).rejects.toThrow(/symlink leaf rejected/);
    expect(hook.calls).toEqual([]);
    expect(await readFile(secret, 'utf-8')).toBe(SECRET);
  });
});

describe.skipIf(process.platform === 'win32')('plugin-fs cp:目标文件以排他方式创建', () => {
  it('fs.cp 带 COPYFILE_EXCL:目标在 cp 自己的检查之后被换成链接时,copyFile 不会跟随它写到 scope 外', async () => {
    const src = join(proj, 'src.txt');
    const dst = join(proj, 'dst.txt');
    await writeFile(src, 'copied');
    const cp = vi.spyOn(fsp, 'cp');
    await invoke(PLUGIN_FS_CHANNELS.CP, src, dst);
    expect(await readFile(dst, 'utf-8')).toBe('copied');
    const opts = cp.mock.calls[0]![2]!;
    expect(opts.force).toBe(false);
    expect(opts.errorOnExist).toBe(true);
    expect((opts.mode ?? 0) & fsConstants.COPYFILE_EXCL).toBe(fsConstants.COPYFILE_EXCL);
  });

  it('确定性复现:cp 内部检查通过后、copyFile 之前目标变成链接 → 以 EEXIST 类错误拒绝,外部文件不变', async () => {
    const src = join(proj, 'src.txt');
    const dst = join(proj, 'dst.txt');
    await writeFile(src, 'copied');
    const realCopyFile = fsp.copyFile.bind(fsp);
    // Node 的 fs.cp 对「目标不存在」的文件最终执行 copyFile(src, dest, opts.mode)。这里用宿主传给 cp 的 mode
    // 直接走这一步,并在它之前换入链接(cp 内部的检查与 copyFile 之间无处插钩子)。
    vi.spyOn(fsp, 'cp').mockImplementation(async (s, d, o) => {
      await symlink(secret, d as string);
      await realCopyFile(s as string, d as string, o?.mode);
    });
    await expect(invoke(PLUGIN_FS_CHANNELS.CP, src, dst)).rejects.toThrow(/already exists|EEXIST/);
    expect(await readFile(secret, 'utf-8')).toBe(SECRET);
    expect((await lstat(dst)).isSymbolicLink()).toBe(true);
  });

  it('递归复制目录照常工作;目标已存在仍拒绝', async () => {
    await mkdir(join(proj, 'a', 'b'), { recursive: true });
    await writeFile(join(proj, 'a', 'b', 'f.txt'), 'deep');
    await invoke(PLUGIN_FS_CHANNELS.CP, join(proj, 'a'), join(proj, 'a2'), { recursive: true });
    expect(await readFile(join(proj, 'a2', 'b', 'f.txt'), 'utf-8')).toBe('deep');
    await expect(
      invoke(PLUGIN_FS_CHANNELS.CP, join(proj, 'a'), join(proj, 'a2'), { recursive: true }),
    ).rejects.toThrow(/already exists/);
  });
});

describe.skipIf(process.platform === 'win32')('plugin-fs 其它写操作:作用在条目本身,不跟随叶子链接', () => {
  it('mkdir:叶子是指向 scope 外目录的链接 → 拒绝,不在外部建目录', async () => {
    const outsideDir = join(root, 'outside-dir');
    await mkdir(outsideDir);
    await symlink(outsideDir, join(proj, 'dlink'));
    await expect(invoke(PLUGIN_FS_CHANNELS.MKDIR, join(proj, 'dlink'), { recursive: true })).rejects.toThrow(
      /symlink leaf rejected/,
    );
    await expect(invoke(PLUGIN_FS_CHANNELS.MKDIR, join(proj, 'dlink', 'child'))).rejects.toThrow();
    await expect(lstat(join(outsideDir, 'child'))).rejects.toThrow();
  });

  it('rm / rename:操作的是链接本身,外部目标不动', async () => {
    await symlink(secret, join(proj, 'l1'));
    await symlink(secret, join(proj, 'l2'));
    await invoke(PLUGIN_FS_CHANNELS.RM, join(proj, 'l1'));
    await invoke(PLUGIN_FS_CHANNELS.RENAME, join(proj, 'l2'), join(proj, 'l3'));
    expect(await readFile(secret, 'utf-8')).toBe(SECRET);
    expect((await lstat(join(proj, 'l3'))).isSymbolicLink()).toBe(true);
    await expect(lstat(join(proj, 'l1'))).rejects.toThrow();
  });

  it('atomicReplaceWithinScope:final 是链接 → 校验阶段拒绝;外部目标不动', async () => {
    await writeFile(join(proj, 'staging'), 'new');
    await symlink(secret, join(proj, 'final'));
    await expect(
      invoke(PLUGIN_FS_CHANNELS.ATOMIC_REPLACE, join(proj, 'staging'), join(proj, 'final'), { overwrite: true }),
    ).rejects.toThrow(/symlink leaf rejected/);
    expect(await readFile(secret, 'utf-8')).toBe(SECRET);
  });
});
