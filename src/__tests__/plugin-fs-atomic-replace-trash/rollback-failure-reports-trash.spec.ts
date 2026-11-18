// 数据安全:atomicReplaceWithinScope 覆盖时,旧 final 先挪到 trash;staging → final 失败后回滚
// (trash → final)又失败 → 旧 final 只剩 trash 里那一份(24 小时后会被清扫)。抛给插件的错误必须带上
// trash 路径,主进程也记日志,否则这份数据无人知晓。行为见同目录 README。
import { promises as fsp } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PLUGIN_FS_CHANNELS } from '../../../electron/shared/plugin-fs-channels';
import { IdentityRegistry } from '../../../electron/main/services/identity-registry.service';
import { PathScopeRegistry } from '../../../electron/main/services/path-scope-registry.service';
import { ScopeRequestCorrelator } from '../../../electron/main/services/scope-request-correlator';
import { registerPluginFsHandlers } from '../../../electron/main/services/plugin-fs.service';
import { StubIpcMain, makeFakeEvent } from '../sdk-contract/integration/make-stub-ipc';

vi.mock('electron', () => ({ app: { getPath: vi.fn(() => '') } }));

const PLUGIN = 'plugin.atomic';
let outer: string;
let proj: string;
let ipc: StubIpcMain;
let correlator: ScopeRequestCorrelator;
let token: string;
const event = makeFakeEvent({ id: 1, isDestroyed: () => false });

beforeEach(async () => {
  outer = await realpath(await mkdtemp(join(tmpdir(), 'atomic-rollback-')));
  proj = join(outer, 'proj');
  await mkdir(proj);
  ipc = new StubIpcMain();
  const identity = new IdentityRegistry();
  const scopes = new PathScopeRegistry(identity);
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
  vi.restoreAllMocks();
  correlator.dispose();
  await rm(outer, { recursive: true, force: true });
});

function eio(): NodeJS.ErrnoException {
  return Object.assign(new Error('EIO: i/o error, rename'), { code: 'EIO' });
}

describe('atomicReplaceWithinScope:回滚失败时报告 trash 路径', () => {
  it('staging → final 失败且 trash → final 回滚也失败 → 错误信息带 trash 路径,主进程记日志,旧内容在 trash 里', async () => {
    const staging = join(proj, 'data.next');
    const final = join(proj, 'data');
    await writeFile(staging, 'new');
    await writeFile(final, 'old');
    const realRename = fsp.rename.bind(fsp);
    let calls = 0;
    // 第 1 次(final → trash)照常;第 2 次(staging → final)与第 3 次(回滚)失败。
    vi.spyOn(fsp, 'rename').mockImplementation(async (from, to) => {
      calls += 1;
      if (calls === 1) return realRename(from, to);
      throw eio();
    });
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});

    const err = (await ipc
      .invokeWithEvent(event, PLUGIN_FS_CHANNELS.ATOMIC_REPLACE, token, staging, final, { overwrite: true })
      .catch((e: unknown) => e)) as NodeJS.ErrnoException;

    expect(calls).toBe(3);
    const trashName = (await readdir(proj)).find((n) => n.startsWith('.trash-data-'));
    expect(trashName).toBeDefined();
    const trashPath = join(proj, trashName!);
    expect(await readFile(trashPath, 'utf-8')).toBe('old');
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toContain(trashPath);
    expect(err.message).toContain('EIO'); // 原始失败原因仍在
    expect(err.code).toBe('EIO');
    expect(logged.mock.calls.some((c) => c.some((a) => String(a).includes(trashPath)))).toBe(true);
  });

  it('回滚成功 → 错误仍是原始错误,不提 trash;final 恢复为旧内容', async () => {
    const staging = join(proj, 'data.next');
    const final = join(proj, 'data');
    await writeFile(staging, 'new');
    await writeFile(final, 'old');
    const realRename = fsp.rename.bind(fsp);
    let calls = 0;
    vi.spyOn(fsp, 'rename').mockImplementation(async (from, to) => {
      calls += 1;
      if (calls === 2) throw eio();
      return realRename(from, to);
    });

    const err = (await ipc
      .invokeWithEvent(event, PLUGIN_FS_CHANNELS.ATOMIC_REPLACE, token, staging, final, { overwrite: true })
      .catch((e: unknown) => e)) as Error;

    expect(err.message).not.toContain('.trash-');
    expect(await readFile(final, 'utf-8')).toBe('old');
    expect((await readdir(proj)).sort()).toEqual(['data', 'data.next']);
  });
});
