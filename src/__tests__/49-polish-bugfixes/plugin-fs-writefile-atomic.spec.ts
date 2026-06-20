// topic 49 第十二 session · codex 复审 loop R4:plugin-fs:write-file 必须 crash-safe 原子写。
//
// 根因:plugin-fs:write-file 直接 `fs.writeFile(path, content, 'utf-8')`。Node fs.writeFile
// 默认以 'w' 打开 → 先 truncate 原文件;写入中途 ENOSPC/崩溃/掉电/进程被杀 → 用户文件留成
// 空/半截且无法回滚。Explorer 的 fs:write-file 已走 atomicWriteFile(同目录 tmp + fsync +
// rename 原子替换),plugin-fs 平行入口没同步(与已修的 plugin-data atomicWriteJson 同源)。
//
// 修:plugin-fs:write-file 复用 atomicWriteFile —— 写失败时原文件原样保留(rename 前不碰目标)。
//
// 验证手段:把目标所在目录设为只读(0o500)。atomicWriteFile 要在该目录建 .tmp → EACCES →
// 在 rename 前失败 → 原文件保留;而裸 fs.writeFile 会直接 truncate 已存在的(文件本身可写)
// 目标 → 原内容丢失。root 下权限失效,跳过。

import { mkdtemp, rm, realpath, writeFile, readFile, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PLUGIN_FS_CHANNELS } from '../../../electron/shared/plugin-fs-channels';
import { IdentityRegistry } from '../../../electron/main/services/identity-registry.service';
import { PathScopeRegistry } from '../../../electron/main/services/path-scope-registry.service';
import { ScopeRequestCorrelator } from '../../../electron/main/services/scope-request-correlator';
import { registerPluginFsHandlers } from '../../../electron/main/services/plugin-fs.service';
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
const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;

beforeEach(async () => {
  tmpRoot = await mkdtemp(join(tmpdir(), `pfs-wf-${randomUUID()}-`));
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
  await chmod(tmpCanonical, 0o700).catch(() => {});
  await rm(tmpRoot, { recursive: true, force: true });
});

describe('topic49 codex-loop R4 · plugin-fs writeFile 原子 crash-safe', () => {
  it('成功路径:写入内容正确,不留 .tmp 残留', async () => {
    const note = join(tmpCanonical, 'note.md');
    await writeFile(note, 'old');
    await ipc.invokeWithEvent(
      event,
      PLUGIN_FS_CHANNELS.WRITE_FILE,
      token,
      note,
      'new-content',
    );
    expect(await readFile(note, 'utf8')).toBe('new-content');
    await expect(readFile(`${note}.tmp`, 'utf8')).rejects.toThrow(); // 无 tmp 残留
  });

  it.skipIf(isRoot)(
    '写失败(目录只读建不了 tmp)时原文件原样保留,不被 truncate',
    async () => {
      const note = join(tmpCanonical, 'note.md');
      await writeFile(note, 'IMPORTANT-original');
      // 目录只读:atomicWriteFile 建 .tmp 会 EACCES,在 rename 前失败 → 原文件保留。
      // 裸 fs.writeFile 则会直接 truncate 可写的目标文件 → 原内容丢失。
      await chmod(tmpCanonical, 0o500);

      await expect(
        ipc.invokeWithEvent(
          event,
          PLUGIN_FS_CHANNELS.WRITE_FILE,
          token,
          note,
          'overwrite-attempt',
        ),
      ).rejects.toBeTruthy();

      await chmod(tmpCanonical, 0o700);
      // 关键断言:原文件内容完好,未被截断
      expect(await readFile(note, 'utf8')).toBe('IMPORTANT-original');
    },
  );
});
