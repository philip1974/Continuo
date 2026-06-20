// topic 49 第十二 session · codex 复审 loop R3:plugin-fs:cp 不得静默覆盖已存在目标。
//
// 根因:plugin-fs:cp 在 scope 校验后直接 fs.cp(src, dst, { recursive })。Node fs.cp 默认
// force:true → 目标已存在时覆盖。没 lstat(dst) 拒绝、没传 errorOnExist → 插件普通 copy 会
// 静默丢用户已有文件。是 R2(rename 非覆盖)的兄弟方法,同族「防御未传播到平行入口」。显式
// 覆盖由 atomicReplaceWithinScope({overwrite:true}) 承担,普通 cp 应保持非覆盖。
//
// 修:cp 前 lstat(dst),存在则抛 ScopeError(reason:'EEXIST'),与 rename 守卫对称。

import { mkdtemp, rm, realpath, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PLUGIN_FS_CHANNELS } from '../../../electron/shared/plugin-fs-channels';
import { IdentityRegistry } from '../../../electron/main/services/identity-registry.service';
import { PathScopeRegistry } from '../../../electron/main/services/path-scope-registry.service';
import { ScopeRequestCorrelator } from '../../../electron/main/services/scope-request-correlator';
import { registerPluginFsHandlers } from '../../../electron/main/services/plugin-fs.service';
import { ScopeError } from '../../plugins/types';
import {
  StubIpcMain,
  makeFakeEvent,
} from '../sdk-contract/integration/make-stub-ipc';

vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => '') },
}));

let tmpRoot: string;
let tmpCanonical: string;
let ipc: StubIpcMain;
let scopes: PathScopeRegistry;
let correlator: ScopeRequestCorrelator;
let token: string;
const event = makeFakeEvent({ id: 1 });

beforeEach(async () => {
  tmpRoot = await mkdtemp(join(tmpdir(), `pfs-cp-${randomUUID()}-`));
  tmpCanonical = await realpath(tmpRoot);
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
  const reg = (await ipc.invokeWithEvent(
    event,
    PLUGIN_FS_CHANNELS.REGISTER_PLUGIN,
    'plugin.fs',
  )) as { token: string };
  token = reg.token;
  scopes.grant('plugin.fs', [{ path: tmpCanonical, mode: 'rw' }]);
});

afterEach(async () => {
  correlator.dispose();
  await rm(tmpRoot, { recursive: true, force: true });
});

describe('topic49 codex-loop R3 · plugin-fs cp 非覆盖', () => {
  it('cp 到已存在的不同文件 → 抛 EEXIST 且目标内容保留', async () => {
    const a = join(tmpCanonical, 'a.md');
    const b = join(tmpCanonical, 'b.md');
    await writeFile(a, 'A-content');
    await writeFile(b, 'B-content-keep');

    await expect(
      ipc.invokeWithEvent(event, PLUGIN_FS_CHANNELS.CP, token, a, b),
    ).rejects.toBeInstanceOf(ScopeError);

    expect(await readFile(b, 'utf8')).toBe('B-content-keep');
    expect(await readFile(a, 'utf8')).toBe('A-content');
  });

  it('cp 到不存在的目标 → 正常复制,源保留', async () => {
    const a = join(tmpCanonical, 'a.md');
    const c = join(tmpCanonical, 'c.md');
    await writeFile(a, 'A-content');

    await ipc.invokeWithEvent(event, PLUGIN_FS_CHANNELS.CP, token, a, c);

    expect(await readFile(c, 'utf8')).toBe('A-content');
    expect(await readFile(a, 'utf8')).toBe('A-content');
  });
});
