// topic 49 第十三轮 · P2-AJ:scope 授权弹窗挂起期间插件被卸载 → 落地 grant 前重校验
// token 仍 active,否则复活已撤销插件的 path-scope。
//
// 根因:plugin-fs:request-scope 弹授权框后 await 用户决定;await 期间插件可被
// _unregister-plugin(revoke token → 进 5s drain;且 generation 守卫通过时 revokeAll)。
// 用户随后点 grant → 旧实现无条件 pathScopeRegistry.grant(pluginId, scopes) 把 scope
// 重新写回(按 pluginId 键、内存常驻)。同 id 插件重装时新 token 解析到同一 pluginId →
// check 命中这批僵尸 scope → 无需重新弹框直接继承文件系统读写权限(绕过 _unregister
// 的 revokeAll 守卫,审计 #2 同源)。lookup/resolve 在 drain 期仍能查到,无法区分,
// 故新增 IdentityRegistry.isActive(token) 专门判 active 态,grant 落地前 gate 之。

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
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
  app: { getPath: vi.fn(() => '/tmp/scope-revoke-home') },
}));

let tmpRoot: string;
let tmpCanonical: string;
let ipc: StubIpcMain;
let event: ReturnType<typeof makeFakeEvent>;
let identity: IdentityRegistry;
let scopes: PathScopeRegistry;
let correlator: ScopeRequestCorrelator;
let token: string;

beforeEach(async () => {
  tmpRoot = await mkdtemp(join(tmpdir(), `scope-revoke-${randomUUID()}-`));
  tmpCanonical = await realpath(tmpRoot);
  ipc = new StubIpcMain();
  identity = new IdentityRegistry();
  scopes = new PathScopeRegistry(identity);
  correlator = new ScopeRequestCorrelator({ ttlMs: 60_000, gcIntervalMs: 60_000 });
  registerPluginFsHandlers(ipc as never, {
    identityRegistry: identity,
    pathScopeRegistry: scopes,
    correlator,
    webContentsForSender: () => null,
  });
  event = makeFakeEvent({ id: 1 });
  const reg = (await ipc.invokeWithEvent(
    event,
    PLUGIN_FS_CHANNELS.REGISTER_PLUGIN,
    'plugin.fs',
  )) as { token: string };
  token = reg.token;
});

afterEach(async () => {
  correlator.dispose();
  await rm(tmpRoot, { recursive: true, force: true });
});

describe('topic49 P2-AJ · 弹窗挂起期间被卸载则不落地 grant', () => {
  it('插件在 grant 前被 _unregister → scope 不被复活', async () => {
    const pending = ipc.invokeWithEvent(
      event,
      PLUGIN_FS_CHANNELS.REQUEST_SCOPE,
      token,
      [{ path: tmpCanonical, mode: 'rw' }],
    );
    const sent = event.sender.send.mock.calls[0]?.[1] as { requestId: string };

    // 弹窗挂起期间插件被卸载:revoke token(进 drain)+ revokeAll(pluginId)
    await ipc.invokeWithEvent(
      event,
      PLUGIN_FS_CHANNELS.UNREGISTER_PLUGIN,
      token,
    );
    expect(scopes._peek('plugin.fs')).toEqual([]);

    // 用户随后点 grant
    await ipc.invokeWithEvent(
      event,
      PLUGIN_FS_CHANNELS.SCOPE_DECISION,
      sent.requestId,
      'grant',
    );
    await expect(pending).resolves.toBe('grant');

    // 关键:token 已 revoke,grant 不得复活 scope(否则同 id 重装直接继承)
    expect(scopes._peek('plugin.fs')).toEqual([]);
  });

  it('未被卸载的正常 grant 仍写入 scope(回归)', async () => {
    const pending = ipc.invokeWithEvent(
      event,
      PLUGIN_FS_CHANNELS.REQUEST_SCOPE,
      token,
      [{ path: tmpCanonical, mode: 'rw' }],
    );
    const sent = event.sender.send.mock.calls[0]?.[1] as { requestId: string };

    await ipc.invokeWithEvent(
      event,
      PLUGIN_FS_CHANNELS.SCOPE_DECISION,
      sent.requestId,
      'grant',
    );
    await expect(pending).resolves.toBe('grant');
    expect(scopes._peek('plugin.fs')).toEqual([
      { path: tmpCanonical, mode: 'rw' },
    ]);
  });
});
