// @vitest-environment node
// 安全:插件仓库里的符号链接不能把宿主的读写引到插件目录之外(详见同目录 README)。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  readFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  promises as fs,
  readdirSync,
  rmSync,
  symlinkSync,
  truncateSync,
  writeFileSync,
} from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

// mock 的 git clone:把 manifest / main 写进真实 clone 目录,再由用例(同步)追加符号链接。
const ctl = vi.hoisted(() => ({
  populate: (_cloneDir: string): void => {},
}));

vi.mock('node:child_process', async () => {
  const nodeFs = await import('node:fs');
  const np = await import('node:path');
  return {
    spawn: (_cmd: string, args: readonly string[]) => {
      const cloneDir = args[args.length - 1] as string;
      const listeners: Record<string, ((arg?: unknown) => void)[]> = {};
      const child = {
        stderr: { on() {} },
        on(ev: string, cb: (arg?: unknown) => void) {
          (listeners[ev] ??= []).push(cb);
          return child;
        },
        kill() {},
      };
      queueMicrotask(() => {
        nodeFs.mkdirSync(np.join(cloneDir, '.git'), { recursive: true });
        nodeFs.writeFileSync(
          np.join(cloneDir, 'manifest.json'),
          JSON.stringify({ id: 'evil', name: 'Evil', version: '1.0.0' }),
        );
        nodeFs.writeFileSync(np.join(cloneDir, 'main.js'), '// plugin');
        ctl.populate(cloneDir);
        listeners['exit']?.forEach((cb) => cb(0));
      });
      return child;
    },
  };
});

import {
  installFromGit,
  listPluginDirs,
  pluginManifestHash,
  readPluginMainByDir,
} from '../../../electron/main/services/plugins.service';
import { registerPluginDataStoreHandlers } from '../../../electron/main/services/plugin-data-store.service';

type Handler = (event: unknown, ...args: unknown[]) => Promise<unknown>;

const URL = 'https://example.com/evil.git';
const SECRET = 'TOP-SECRET-not-json';
let root: string;
let baseDir: string;
let outside: string;
const handlers = new Map<string, Handler>();
const invoke = (ch: string, ...args: unknown[]): Promise<unknown> => handlers.get(ch)!({}, ...args);

beforeEach(async () => {
  // realpath:macOS 的 tmpdir 在 /var → /private/var 链接下,包含判定比较的是真实路径。
  root = await fs.realpath(await mkdtemp(path.join(tmpdir(), 'plugin-symlink-')));
  baseDir = path.join(root, 'plugins');
  outside = path.join(root, 'outside');
  await fs.mkdir(baseDir, { recursive: true });
  await fs.mkdir(outside, { recursive: true });
  await fs.writeFile(path.join(outside, 'secret.txt'), SECRET);
  ctl.populate = () => {};
  handlers.clear();
  registerPluginDataStoreHandlers(
    { handle: (ch: string, h: Handler) => handlers.set(ch, h) } as never,
    { userDataPath: root },
  );
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true }).catch(() => {});
});

async function makePlugin(id: string): Promise<string> {
  const dir = path.join(baseDir, id);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'manifest.json'), JSON.stringify({ id, name: id, version: '1.0.0' }));
  await fs.writeFile(path.join(dir, 'main.js'), '// ok');
  return dir;
}

describe('安装:克隆树含符号链接 → 拒绝', () => {
  const cases: [string, (cloneDir: string) => void][] = [
    ['data.json 指向别的插件的数据', (d) => symlinkSync('../victim/data.json', path.join(d, 'data.json'))],
    ['绝对路径链接', (d) => symlinkSync('/etc/hosts', path.join(d, 'hosts'))],
    ['树内相对链接', (d) => symlinkSync('main.js', path.join(d, 'alias.js'))],
    [
      '子目录里的悬空链接',
      (d) => {
        mkdirSync(path.join(d, 'a', 'b'), { recursive: true });
        symlinkSync('nope', path.join(d, 'a', 'b', 'dangling'));
      },
    ],
    ['目录链接', (d) => symlinkSync('..', path.join(d, 'up'))],
  ];
  for (const [name, populate] of cases) {
    it(`${name} → PLUGIN_SYMLINK_REJECTED,不落地、无残留`, async () => {
      ctl.populate = populate;
      await expect(installFromGit(URL, baseDir)).rejects.toMatchObject({ code: 'PLUGIN_SYMLINK_REJECTED' });
      expect(readdirSync(baseDir)).toEqual([]);
    });
  }

  it('manifest.json 是指向树外的链接 → 在读 manifest 之前拒绝(错误不含目标内容)', async () => {
    ctl.populate = (d) => {
      rmSync(path.join(d, 'manifest.json'));
      symlinkSync(path.join(outside, 'secret.txt'), path.join(d, 'manifest.json'));
    };
    const err = await installFromGit(URL, baseDir).catch((e: unknown) => e as Error & { code?: string });
    expect(err).toMatchObject({ code: 'PLUGIN_SYMLINK_REJECTED' });
    expect((err as Error).message).not.toContain(SECRET);
  });

  it('main.js 是指向仓库外的链接 → 拒绝安装,不落地', async () => {
    ctl.populate = (d) => {
      rmSync(path.join(d, 'main.js'));
      symlinkSync(path.join(outside, 'secret.txt'), path.join(d, 'main.js'));
    };
    await expect(installFromGit(URL, baseDir)).rejects.toMatchObject({ code: 'PLUGIN_SYMLINK_REJECTED' });
    expect(readdirSync(baseDir)).toEqual([]);
  });

  // 安装与列举同口径(resolveContainedPluginMain):main 超 8MiB 时列举会跳过 → 安装须当场拒绝,
  // 否则报「安装成功」而插件静默不出现。
  it('main 超 8MiB → BAD_MAIN 拒绝安装,不落地', async () => {
    ctl.populate = (d) => {
      truncateSync(path.join(d, 'main.js'), 8 * 1024 * 1024 + 1);
    };
    await expect(installFromGit(URL, baseDir)).rejects.toMatchObject({ code: 'BAD_MAIN' });
    expect(readdirSync(baseDir)).toEqual([]);
  });

  it('无符号链接的仓库照常安装', async () => {
    ctl.populate = (d) => {
      mkdirSync(path.join(d, 'dist'));
      writeFileSync(path.join(d, 'dist', 'x.js'), '1');
    };
    await expect(installFromGit(URL, baseDir)).resolves.toMatchObject({ id: 'evil' });
    expect(existsSync(path.join(baseDir, 'evil', 'dist', 'x.js'))).toBe(true);
  });
});

describe('plugin-data:data.json 是链接', () => {
  it('load:指向别的插件 data.json → {},读不到对方数据', async () => {
    await fs.mkdir(path.join(baseDir, 'victim'), { recursive: true });
    await invoke('plugin-data:save-serialized', 'victim', JSON.stringify({ token: 'victim-secret' }));
    await fs.mkdir(path.join(baseDir, 'evil'), { recursive: true });
    await fs.symlink('../victim/data.json', path.join(baseDir, 'evil', 'data.json'));
    await expect(invoke('plugin-data:load', 'evil')).resolves.toEqual({});
  });

  it('load:指向非 JSON 文件 → {},不生成 .corrupt 副本', async () => {
    const dir = path.join(baseDir, 'evil');
    await fs.mkdir(dir, { recursive: true });
    await fs.symlink(path.join(outside, 'secret.txt'), path.join(dir, 'data.json'));
    await expect(invoke('plugin-data:load', 'evil')).resolves.toEqual({});
    expect(existsSync(path.join(dir, 'data.json.corrupt'))).toBe(false);
  });

  it.skipIf(process.platform === 'win32')('load:硬链接到别处的文件 → {},不生成 .corrupt 副本', async () => {
    const dir = path.join(baseDir, 'evil');
    await fs.mkdir(dir, { recursive: true });
    await fs.link(path.join(outside, 'secret.txt'), path.join(dir, 'data.json'));
    await expect(invoke('plugin-data:load', 'evil')).resolves.toEqual({});
    expect(existsSync(path.join(dir, 'data.json.corrupt'))).toBe(false);
  });

  it('save:不写穿链接,落成插件目录里的普通文件', async () => {
    await fs.mkdir(path.join(baseDir, 'victim'), { recursive: true });
    await invoke('plugin-data:save-serialized', 'victim', JSON.stringify('victim-data'));
    const victimFile = path.join(baseDir, 'victim', 'data.json');
    const before = await fs.readFile(victimFile, 'utf-8');
    const dir = path.join(baseDir, 'evil');
    await fs.mkdir(dir, { recursive: true });
    await fs.symlink('../victim/data.json', path.join(dir, 'data.json'));

    await invoke('plugin-data:save-serialized', 'evil', JSON.stringify('mine'));

    expect(await fs.readFile(victimFile, 'utf-8')).toBe(before);
    expect(readdirSync(path.join(baseDir, 'victim'))).toEqual(['data.json']);
    expect(lstatSync(path.join(dir, 'data.json')).isFile()).toBe(true);
    await expect(invoke('plugin-data:load', 'evil')).resolves.toEqual({ value: 'mine' });
  });

  it('save:悬空链接 → 删链接后正常写入,不在链接目标处建文件', async () => {
    const dir = path.join(baseDir, 'evil');
    await fs.mkdir(dir, { recursive: true });
    await fs.symlink(path.join(outside, 'created-by-save.json'), path.join(dir, 'data.json'));
    await invoke('plugin-data:save-serialized', 'evil', JSON.stringify(1));
    expect(readdirSync(outside)).toEqual(['secret.txt']);
    expect(lstatSync(path.join(dir, 'data.json')).isFile()).toBe(true);
  });
});

describe('已安装目录:manifest / main 经链接逃出插件目录 → 插件不可用', () => {
  it('main.js 指向目录外 → 列举跳过,读 main 返回 null', async () => {
    const dir = await makePlugin('evil');
    await fs.rm(path.join(dir, 'main.js'));
    await fs.symlink(path.join(outside, 'secret.txt'), path.join(dir, 'main.js'));
    const manifestText = await fs.readFile(path.join(dir, 'manifest.json'), 'utf-8');

    expect(await listPluginDirs(baseDir)).toEqual([]);
    expect(await readPluginMainByDir(baseDir, 'evil', pluginManifestHash(manifestText))).toBeNull();
  });

  it('manifest.main 经目录链接逃出(dist -> 目录外)→ 不可用', async () => {
    const dir = await makePlugin('evil');
    await fs.writeFile(
      path.join(dir, 'manifest.json'),
      JSON.stringify({ id: 'evil', name: 'evil', version: '1.0.0', main: 'dist/secret.txt' }),
    );
    await fs.symlink(outside, path.join(dir, 'dist'));
    expect(await listPluginDirs(baseDir)).toEqual([]);
  });

  it('manifest.json 指向目录外 → 列举跳过', async () => {
    const dir = await makePlugin('evil');
    await fs.writeFile(path.join(outside, 'm.json'), JSON.stringify({ id: 'evil', name: 'x', version: '1.0.0' }));
    await fs.rm(path.join(dir, 'manifest.json'));
    await fs.symlink(path.join(outside, 'm.json'), path.join(dir, 'manifest.json'));
    expect(await listPluginDirs(baseDir)).toEqual([]);
  });

  it('插件目录本身是链接(本地开发)、目录内的链接 → 照旧可用', async () => {
    const real = path.join(root, 'dev-repo');
    await fs.mkdir(real);
    await fs.writeFile(path.join(real, 'manifest.json'), JSON.stringify({ id: 'dev', name: 'dev', version: '1.0.0' }));
    await fs.mkdir(path.join(real, 'dist'));
    await fs.writeFile(path.join(real, 'dist', 'main.js'), '// built');
    await fs.symlink('dist/main.js', path.join(real, 'main.js'));
    await fs.symlink(real, path.join(baseDir, 'dev'));

    const listed = await listPluginDirs(baseDir);
    expect(listed.map((p) => p.id)).toEqual(['dev']);
    expect(await readPluginMainByDir(baseDir, 'dev', listed[0]!.manifestHash)).toBe('// built');
  });
});

// 克隆树检查的条目类型判定与宿主 listDir / 插件 listDir / pack 检查同一来源(realDirentType):win32 上 libuv 对任何
// reparse point 都报链接,OneDrive / Dedup 的普通文件被误判为符号链接 → 插件装不上。win32 行为见 dirent-real-type 单测。
describe('assertNoSymlinksInClone 用共享的真实类型判定', () => {
  it('源码接线', () => {
    const src = readFileSync(path.join(process.cwd(), 'electron/main/services/plugins.service.ts'), 'utf-8');
    const body = src.slice(src.indexOf('async function assertNoSymlinksInClone'), src.indexOf('function cloneTooLargeError'));
    expect(body).toContain('realDirentType(dirent, full)');
    expect(body).not.toMatch(/dirent\.isSymbolicLink\(\)/);
  });
});

