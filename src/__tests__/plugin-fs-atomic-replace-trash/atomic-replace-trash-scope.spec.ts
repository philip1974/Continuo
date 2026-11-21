// 安全:atomicReplaceWithinScope 的 trash 落点与过期清扫只发生在插件已授 rw scope 内的目录,且只回收宿主自己
// 生成形态的 trash。经真实 IPC handler + 真实 PathScopeRegistry + 真实临时目录。行为见同目录 README。
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PLUGIN_FS_CHANNELS } from '../../../electron/shared/plugin-fs-channels';
import { IdentityRegistry } from '../../../electron/main/services/identity-registry.service';
import { PathScopeRegistry } from '../../../electron/main/services/path-scope-registry.service';
import { ScopeRequestCorrelator } from '../../../electron/main/services/scope-request-correlator';
import {
  registerPluginFsHandlers,
  trashPathFor,
} from '../../../electron/main/services/plugin-fs.service';
import { ScopeError } from '../../plugins/types';
import { StubIpcMain, makeFakeEvent } from '../sdk-contract/integration/make-stub-ipc';

vi.mock('electron', () => ({ app: { getPath: vi.fn(() => '') } }));

const PLUGIN = 'plugin.atomic';
const DAY_MS = 24 * 60 * 60 * 1000;

let outer: string; // canonical;scope 根的父目录(scope 外)
let proj: string; // scope 根
let ipc: StubIpcMain;
let scopes: PathScopeRegistry;
let correlator: ScopeRequestCorrelator;
let token: string;
const event = makeFakeEvent({ id: 1, isDestroyed: () => false });

function replace(
  staging: string,
  final: string,
  opts: { overwrite?: boolean } = { overwrite: true },
): Promise<unknown> {
  return ipc.invokeWithEvent(event, PLUGIN_FS_CHANNELS.ATOMIC_REPLACE, token, staging, final, opts);
}

/** 把条目的 mtime 拨到 ageMs 之前。 */
async function age(path: string, ageMs: number): Promise<void> {
  const t = (Date.now() - ageMs) / 1000;
  await utimes(path, t, t);
}

/** 宿主形态的 trash 路径(与生产同一个生成函数),名字里的时间戳在 ageMs 之前。 */
function hostTrash(dir: string, name: string, ageMs: number, rand = 'ab12'): string {
  return trashPathFor(join(dir, name), `${Date.now() - ageMs}-${rand}`);
}

beforeEach(async () => {
  outer = await realpath(await mkdtemp(join(tmpdir(), 'atomic-trash-')));
  proj = join(outer, 'proj');
  await mkdir(proj);
  ipc = new StubIpcMain();
  const identity = new IdentityRegistry();
  scopes = new PathScopeRegistry(identity);
  correlator = new ScopeRequestCorrelator({ ttlMs: 60_000, gcIntervalMs: 60_000 });
  registerPluginFsHandlers(ipc as never, {
    identityRegistry: identity,
    pathScopeRegistry: scopes,
    correlator,
    webContentsForSender: () => null,
  });
  token = (
    (await ipc.invokeWithEvent(event, PLUGIN_FS_CHANNELS.REGISTER_PLUGIN, PLUGIN)) as { token: string }
  ).token;
  scopes.grant(PLUGIN, [{ path: proj, mode: 'rw' }]);
});

afterEach(async () => {
  correlator.dispose();
  await rm(outer, { recursive: true, force: true });
});

describe('atomicReplaceWithinScope:trash 落点与清扫不出 scope', () => {
  it('final 等于 scope 根 → 拒绝,scope 根的父目录(scope 外)里的 .trash-* 一个都不动', async () => {
    // scope 外:用户自己的旧目录 + 宿主形态的旧 trash,都超过 24h
    const userDir = join(outer, '.trash-my-old-stuff');
    await mkdir(userDir);
    await writeFile(join(userDir, 'keep.txt'), 'user data');
    await age(userDir, 2 * DAY_MS);
    const hostShaped = hostTrash(outer, 'proj', 2 * DAY_MS);
    await mkdir(hostShaped);
    await writeFile(join(hostShaped, 'keep.txt'), 'other data');
    await age(hostShaped, 2 * DAY_MS);
    await writeFile(join(proj, 'inside.txt'), 'inside');

    await expect(replace(proj, proj)).rejects.toBeInstanceOf(ScopeError);

    expect(await readFile(join(userDir, 'keep.txt'), 'utf-8')).toBe('user data');
    expect(await readFile(join(hostShaped, 'keep.txt'), 'utf-8')).toBe('other data');
    // 拒绝发生在任何文件系统变更之前:scope 根原样,父目录没有新增条目
    expect(await readFile(join(proj, 'inside.txt'), 'utf-8')).toBe('inside');
    expect((await readdir(outer)).sort()).toEqual(
      ['.trash-my-old-stuff', basename(hostShaped), 'proj'].sort(),
    );
  });

  it('staging 与 final 是两条相邻的 scope 根 → 拒绝:共同父目录在 scope 外,不清扫、不落 trash、不替换', async () => {
    const stagingRoot = join(outer, 'proj-next');
    await mkdir(stagingRoot);
    await writeFile(join(stagingRoot, 'f'), 'new');
    await writeFile(join(proj, 'f'), 'old');
    scopes.grant(PLUGIN, [{ path: stagingRoot, mode: 'rw' }]);
    const hostShaped = hostTrash(outer, 'proj', 2 * DAY_MS);
    await mkdir(hostShaped);
    await writeFile(join(hostShaped, 'keep.txt'), 'other data');
    await age(hostShaped, 2 * DAY_MS);

    await expect(replace(stagingRoot, proj)).rejects.toThrow(/parent directory must be inside a granted rw scope/);

    expect(await readFile(join(hostShaped, 'keep.txt'), 'utf-8')).toBe('other data');
    expect(await readFile(join(proj, 'f'), 'utf-8')).toBe('old');
    expect(await readFile(join(stagingRoot, 'f'), 'utf-8')).toBe('new');
    expect((await readdir(outer)).sort()).toEqual([basename(hostShaped), 'proj', 'proj-next'].sort());
  });

  it('父目录只有只读 scope 覆盖 → 同样拒绝', async () => {
    const stagingRoot = join(outer, 'proj-next');
    await mkdir(stagingRoot);
    scopes.grant(PLUGIN, [
      { path: stagingRoot, mode: 'rw' },
      { path: outer, mode: 'r' },
    ]);

    await expect(replace(stagingRoot, proj)).rejects.toBeInstanceOf(ScopeError);

    expect((await readdir(outer)).sort()).toEqual(['proj', 'proj-next']);
  });

  it('staging 与 final 是同一路径 → 拒绝,文件原样', async () => {
    const file = join(proj, 'a.txt');
    await writeFile(file, 'same');

    await expect(replace(file, file)).rejects.toBeInstanceOf(ScopeError);

    expect(await readFile(file, 'utf-8')).toBe('same');
    expect(await readdir(proj)).toEqual(['a.txt']);
  });

  it('scope 内的正常替换:只回收宿主形态且过期的 trash,用户自己命名的 .trash-* 与未过期的都保留', async () => {
    const userDir = join(proj, '.trash-my-old-stuff');
    await mkdir(userDir);
    await writeFile(join(userDir, 'keep.txt'), 'user data');
    await age(userDir, 2 * DAY_MS);
    // 形似但不是宿主形态:时间戳位数不对 / 随机段含大写
    const staleTs = String(Date.now() - 2 * DAY_MS);
    const nearMiss1 = join(proj, `.trash-data.json-${staleTs.slice(0, 12)}-ab12`);
    const nearMiss2 = join(proj, `.trash-data.json-${staleTs}-XY12`);
    for (const p of [nearMiss1, nearMiss2]) {
      await writeFile(p, 'user');
      await age(p, 2 * DAY_MS);
    }
    const staleSameName = hostTrash(proj, 'data.json', 2 * DAY_MS);
    const staleOtherName = hostTrash(proj, 'other.json', 2 * DAY_MS, 'zz99');
    const fresh = hostTrash(proj, 'data.json', 60_000, 'cd34');
    for (const p of [staleSameName, staleOtherName, fresh]) await writeFile(p, 'leaked');
    for (const p of [staleSameName, staleOtherName]) await age(p, 2 * DAY_MS);
    // 名字里的时间戳过期,但条目近期被改过 → 不删(两个条件都要满足)
    const staleNameFreshMtime = hostTrash(proj, 'data.json', 3 * DAY_MS, 'ef56');
    await writeFile(staleNameFreshMtime, 'recently touched');
    // 反过来:mtime 很旧(目录改名不更新自身 mtime),但名字里的时间戳表明刚被移入 trash → 不删
    const freshNameStaleMtime = hostTrash(proj, 'data.json', 30_000, 'gh78');
    await mkdir(freshNameStaleMtime);
    await age(freshNameStaleMtime, 2 * DAY_MS);

    const staging = join(proj, 'data.json.tmp');
    const final = join(proj, 'data.json');
    await writeFile(staging, 'next');
    await writeFile(final, 'old');
    await replace(staging, final);

    expect(await readFile(final, 'utf-8')).toBe('next');
    expect(existsSync(staleSameName)).toBe(false);
    expect(existsSync(staleOtherName)).toBe(false);
    expect(await readFile(join(userDir, 'keep.txt'), 'utf-8')).toBe('user data');
    expect(existsSync(nearMiss1)).toBe(true);
    expect(existsSync(nearMiss2)).toBe(true);
    expect(existsSync(fresh)).toBe(true);
    expect(existsSync(staleNameFreshMtime)).toBe(true);
    expect(existsSync(freshNameStaleMtime)).toBe(true);
  });

  it('宿主形态的 trash 名是符号链接 → 按链接自身判定,不按它指向的目录的旧 mtime 去删', async () => {
    const victim = join(outer, 'victim');
    await mkdir(victim);
    await writeFile(join(victim, 'keep.txt'), 'victim data');
    await age(victim, 2 * DAY_MS);
    const link = hostTrash(proj, 'data.json', 2 * DAY_MS);
    await symlink(victim, link); // 链接自身刚创建(mtime 新),目标 mtime 旧

    const staging = join(proj, 'data.json.tmp');
    await writeFile(staging, 'next');
    await replace(staging, join(proj, 'data.json'));

    expect(await readFile(join(victim, 'keep.txt'), 'utf-8')).toBe('victim data');
    expect(existsSync(link)).toBe(true);
  });

  it('替换成功后不留下本次的 trash', async () => {
    const staging = join(proj, 'dir.tmp');
    const final = join(proj, 'dir');
    await mkdir(staging);
    await writeFile(join(staging, 'f'), 'new');
    await mkdir(final);
    await writeFile(join(final, 'f'), 'old');

    await replace(staging, final);

    expect(await readFile(join(final, 'f'), 'utf-8')).toBe('new');
    expect(await readdir(proj)).toEqual(['dir']);
  });
});
