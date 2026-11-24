// BDD:Windows 上 dirent 报 symlink(libuv 对任何 reparse point 都报 DT_LINK)时,插件 listDir 与
// readGitBlob 的 pack 目录检查按 lstat 判真实类型。行为见同目录 README。
// 用真实文件 + 伪造 dirent(模拟 Windows libuv 报法)+ 注入 platform='win32'。
import { execFileSync } from 'node:child_process';
import { promises as fsp, type Dirent } from 'node:fs';
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PLUGIN_FS_CHANNELS } from '../../../electron/shared/plugin-fs-channels';
import { IdentityRegistry } from '../../../electron/main/services/identity-registry.service';
import { PathScopeRegistry } from '../../../electron/main/services/path-scope-registry.service';
import { ScopeRequestCorrelator } from '../../../electron/main/services/scope-request-correlator';
import { registerPluginFsHandlers } from '../../../electron/main/services/plugin-fs.service';
import { ScopeError } from '../../plugins/types';
import { StubIpcMain, makeFakeEvent } from '../sdk-contract/integration/make-stub-ipc';

vi.mock('electron', () => ({ app: { getPath: vi.fn(() => '') } }));

const PLUGIN = 'plugin.reparse';
let root: string;
let ipc: StubIpcMain;
let scopes: PathScopeRegistry;
let correlator: ScopeRequestCorrelator;
let token: string;
const event = makeFakeEvent({ id: 1 });

/** 把名字在 reparse 集合里的 dirent 伪装成 symlink(Windows libuv 对 reparse point 的报法)。 */
function asReparse<T extends { name: string; isFile(): boolean; isDirectory(): boolean; isSymbolicLink(): boolean }>(
  d: T,
  reparse: ReadonlySet<string>,
): T {
  if (!reparse.has(d.name)) return d;
  return Object.assign(Object.create(Object.getPrototypeOf(d) as object) as T, d, {
    isFile: () => false,
    isDirectory: () => false,
    isSymbolicLink: () => true,
  });
}

async function setup(platform: NodeJS.Platform): Promise<void> {
  ipc = new StubIpcMain();
  const identity = new IdentityRegistry();
  scopes = new PathScopeRegistry(identity);
  correlator = new ScopeRequestCorrelator({ ttlMs: 60_000 });
  registerPluginFsHandlers(ipc as never, { identityRegistry: identity, pathScopeRegistry: scopes, correlator, platform });
  token = ((await ipc.invokeWithEvent(event, PLUGIN_FS_CHANNELS.REGISTER_PLUGIN, PLUGIN)) as { token: string }).token;
}

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'win-reparse-')));
});

afterEach(async () => {
  vi.restoreAllMocks();
  correlator?.dispose();
  await rm(root, { recursive: true, force: true });
});

describe.skipIf(process.platform === 'win32')('插件 listDir:win32 上 dirent 报 symlink 按 lstat 判类型', () => {
  beforeEach(async () => {
    await mkdir(join(root, 'sub'));
    await writeFile(join(root, 'a.txt'), 'A');
    await symlink(join(root, 'sub'), join(root, 'link-dir'));
    const real = fsp.opendir.bind(fsp);
    vi.spyOn(fsp, 'opendir').mockImplementation(async (p, o) => {
      const dir = await real(p, o);
      const reparse = new Set(['sub', 'a.txt', 'link-dir']);
      return {
        async *[Symbol.asyncIterator]() {
          for await (const d of dir) yield asReparse(d, reparse);
        },
      } as unknown as Awaited<ReturnType<typeof fsp.opendir>>;
    });
  });

  const list = async () => {
    scopes.grant(PLUGIN, [{ path: root, mode: 'r' }]);
    const out = (await ipc.invokeWithEvent(event, PLUGIN_FS_CHANNELS.LIST_DIR, token, root)) as Array<{
      name: string;
      isDirectory: boolean;
      isSymlink: boolean;
    }>;
    return Object.fromEntries(out.map((e) => [e.name, { isDirectory: e.isDirectory, isSymlink: e.isSymlink }]));
  };

  it('win32:reparse 普通目录报目录、普通文件报文件,真符号链接仍报 symlink', async () => {
    await setup('win32');
    expect(await list()).toEqual({
      sub: { isDirectory: true, isSymlink: false },
      'a.txt': { isDirectory: false, isSymlink: false },
      'link-dir': { isDirectory: false, isSymlink: true },
    });
  });

  it('非 win32:dirent 类型直接采信(行为不变)', async () => {
    await setup('linux');
    expect((await list()).sub).toEqual({ isDirectory: false, isSymlink: true });
  });
});

describe.skipIf(process.platform === 'win32')('readGitBlob pack 目录检查:win32 上 reparse 普通文件放行、真 symlink 拒', () => {
  let repo: string;
  let sha: string;

  beforeEach(async () => {
    repo = join(root, 'repo');
    await mkdir(repo);
    const git = (args: string[]) => execFileSync('git', args, { cwd: repo, stdio: ['ignore', 'pipe', 'ignore'] }).toString();
    git(['init', '-q']);
    await writeFile(join(repo, 'blob-src'), 'own');
    sha = git(['hash-object', '-w', 'blob-src']).trim();
    const pack = join(repo, '.git', 'objects', 'pack');
    await writeFile(join(pack, 'pack-r.pack'), '');
    const real = fsp.readdir.bind(fsp) as (p: string, o: { withFileTypes: true }) => Promise<Dirent[]>;
    vi.spyOn(fsp, 'readdir').mockImplementation((async (p: string, o: { withFileTypes: true }) => {
      const entries = await real(p, o);
      if (basename(String(p)) !== 'pack') return entries;
      return entries.map((d) => asReparse(d, new Set(['pack-r.pack', 'pack-l.pack'])));
    }) as never);
  });

  const read = () => ipc.invokeWithEvent(event, PLUGIN_FS_CHANNELS.READ_GIT_BLOB, token, repo, sha);

  it('win32:pack 文件 dirent 报 symlink 而 lstat 为普通文件 → 正常读取', async () => {
    await setup('win32');
    scopes.grant(PLUGIN, [{ path: repo, mode: 'r' }]);
    expect(Buffer.from((await read()) as Uint8Array).toString()).toBe('own');
  });

  // readdir 与 lstat 之间条目被删(git gc / repack 并发删 tmp_pack 等):无可经由的链接 → 跳过,不误报越界。
  it('win32:pack 条目 readdir 后即被删除(lstat ENOENT)→ 跳过,正常读取', async () => {
    const withPackEntries = fsp.readdir as unknown as (p: string, o: { withFileTypes: true }) => Promise<Dirent[]>;
    vi.spyOn(fsp, 'readdir').mockImplementation((async (p: string, o: { withFileTypes: true }) => {
      const entries = await withPackEntries(p, o);
      if (basename(String(p)) !== 'pack' || entries.length === 0) return entries;
      const ghost = asReparse(Object.assign(Object.create(Object.getPrototypeOf(entries[0]) as object) as Dirent, entries[0], { name: 'tmp_pack_gone' }), new Set(['tmp_pack_gone']));
      return [...entries, ghost];
    }) as never);
    await setup('win32');
    scopes.grant(PLUGIN, [{ path: repo, mode: 'r' }]);
    expect(Buffer.from((await read()) as Uint8Array).toString()).toBe('own');
  });

  it('win32:pack 目录里的真符号链接 → 仍拒', async () => {
    await symlink(join(repo, 'blob-src'), join(repo, '.git', 'objects', 'pack', 'pack-l.pack'));
    await setup('win32');
    scopes.grant(PLUGIN, [{ path: repo, mode: 'r' }]);
    await expect(read()).rejects.toBeInstanceOf(ScopeError);
  });
});
