// BDD:main 推送 plugin-fs:scope-request 时,每个 scope 带归一化后的 displayPath。
// 见同目录 README。
import { homedir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
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
  app: { getPath: vi.fn(() => '/tmp/scope-display-home') },
}));

let correlator: ScopeRequestCorrelator | null = null;

afterEach(() => {
  correlator?.dispose();
  correlator = null;
});

describe('plugin-fs:scope-request 推送带 displayPath', () => {
  it('~ 展开为 home;path/mode 保持插件请求的原始值;按下标对应', async () => {
    const ipc = new StubIpcMain();
    const identity = new IdentityRegistry();
    const corr = new ScopeRequestCorrelator({ ttlMs: 60_000, gcIntervalMs: 60_000 });
    correlator = corr;
    registerPluginFsHandlers(ipc as never, {
      identityRegistry: identity,
      pathScopeRegistry: new PathScopeRegistry(identity),
      correlator: corr,
      webContentsForSender: () => null,
    });
    const senderId = 21;
    const { token } = (await ipc.invokeWithEvent(
      makeFakeEvent({ id: senderId }),
      PLUGIN_FS_CHANNELS.REGISTER_PLUGIN,
      'plugin.fs',
    )) as { token: string };

    // 两个都不存在的目录:realpath 失败 → 归一化回退到 home 展开值,结果确定。
    const absolute = '/continuo-no-such-dir-for-display-path/abs';
    const event = makeFakeEvent({ id: senderId, isDestroyed: () => false });
    const pending = ipc.invokeWithEvent(event, PLUGIN_FS_CHANNELS.REQUEST_SCOPE, token, [
      { path: '~/continuo-no-such-dir-for-display-path', mode: 'r' },
      { path: absolute, mode: 'rw' },
    ]);
    await vi.waitFor(() => {
      if (event.sender.send.mock.calls.length === 0) {
        throw new Error('scope-request 未发出');
      }
    });

    const [channel, payload] = event.sender.send.mock.calls[0]!;
    expect(channel).toBe(PLUGIN_FS_CHANNELS.SCOPE_REQUEST);
    expect((payload as { scopes: unknown }).scopes).toEqual([
      {
        path: '~/continuo-no-such-dir-for-display-path',
        mode: 'r',
        displayPath: path.join(homedir(), 'continuo-no-such-dir-for-display-path'),
      },
      { path: absolute, mode: 'rw', displayPath: absolute },
    ]);

    // 收口 pending,避免悬挂。
    corr.cancelBySender(senderId);
    await pending.catch(() => undefined);
  });
});
