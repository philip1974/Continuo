// topic 49 第十二 session · codex 复审 loop R2:plugin-fs:rename 不得静默覆盖已存在目标。
//
// 根因:plugin-fs:rename 对 dst 只做 scope/write 解析 + same-parent 校验,随后直接
// fs.rename(src, dst)。POSIX rename(2) 在目标已存在时原子覆盖 → 插件在合法授权目录内
// 把 a 改成已有 b 的名字会永久丢失 b。Explorer 侧 renameEntry(ipc/fs/rename.ts)早有
// lstat + inode 比较 + FS_EEXIST 防覆盖,plugin-fs 这个平行入口没同步(「防御建在一入口
// 漏平行入口」族)。与 SDK atomicReplaceWithinScope({overwrite:true}) 的显式覆盖契约也不一致。
//
// 修:rename 前 lstat(dst);存在且与源不是同一 inode → 抛 ScopeError(reason:'EEXIST'),
// 不执行 rename;同 inode(大小写改名到自身)放行。

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
  tmpRoot = await mkdtemp(join(tmpdir(), `pfs-rename-${randomUUID()}-`));
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

describe('topic49 codex-loop R2 · plugin-fs rename 非覆盖', () => {
  it('rename 到已存在的不同文件 → 抛 EEXIST 且目标内容保留', async () => {
    const a = join(tmpCanonical, 'a.md');
    const b = join(tmpCanonical, 'b.md');
    await writeFile(a, 'A-content');
    await writeFile(b, 'B-content-keep');

    await expect(
      ipc.invokeWithEvent(event, PLUGIN_FS_CHANNELS.RENAME, token, a, b),
    ).rejects.toBeInstanceOf(ScopeError);

    // b 内容必须保留,a 必须还在(rename 没执行)
    expect(await readFile(b, 'utf8')).toBe('B-content-keep');
    expect(await readFile(a, 'utf8')).toBe('A-content');
  });

  it('rename 到不存在的目标 → 正常改名', async () => {
    const a = join(tmpCanonical, 'a.md');
    const c = join(tmpCanonical, 'c.md');
    await writeFile(a, 'A-content');

    await ipc.invokeWithEvent(event, PLUGIN_FS_CHANNELS.RENAME, token, a, c);

    expect(await readFile(c, 'utf8')).toBe('A-content');
    await expect(readFile(a, 'utf8')).rejects.toThrow(); // a 已不存在
  });
});
