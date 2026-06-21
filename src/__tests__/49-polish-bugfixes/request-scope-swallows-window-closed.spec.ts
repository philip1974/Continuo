// topic 49 后续 · 窗口关闭时 request-scope handler 不得把取消冒泡成 handler 错误。
//
// 根因:plugin-fs `request-scope` handler `await correlator.createRequest(...).promise`
// 等 renderer 弹窗决策。窗口硬关闭时 index.ts win.on('closed') →
// cancelScopeRequestsForWebContents → correlator.cancelBySender 会 reject 该 pending
// (ScopeRequestTimeoutError 'window closed')。但 handler 没 catch,于是 reject 冒泡到
// ipcMain.handle,Electron 打印:
//   Error occurred in handler for 'plugin-fs:request-scope': ScopeRequestTimeoutError: window closed
// 这是预期内的取消(等待的 renderer 已随窗口销毁,reply 无处可送),不该当错误噪声。
//
// 修复:handler catch 到 ScopeRequestTimeoutError 且 sender 已销毁 → 视为终态 deny
// 静默收口。renderer 仍存活的 TTL 超时按原契约 reject(让 requestScope() 抛出)。

import { afterEach, describe, expect, it, vi } from 'vitest';
import { PLUGIN_FS_CHANNELS } from '../../../electron/shared/plugin-fs-channels';
import { IdentityRegistry } from '../../../electron/main/services/identity-registry.service';
import { PathScopeRegistry } from '../../../electron/main/services/path-scope-registry.service';
import { ScopeRequestCorrelator } from '../../../electron/main/services/scope-request-correlator';
import { registerPluginFsHandlers } from '../../../electron/main/services/plugin-fs.service';
import {
  StubIpcMain,
  makeFakeEvent,
  type StubIpcEvent,
} from '../sdk-contract/integration/make-stub-ipc';

vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => '/tmp/req-scope-home') },
}));

let correlator: ScopeRequestCorrelator | null = null;

interface Harness {
  ipc: StubIpcMain;
  correlator: ScopeRequestCorrelator;
  token: string;
}

// 注意:token 经 identityRegistry 绑定注册时的 sender id,REQUEST_SCOPE 必须用同一
// sender id 才能 resolve 成功,否则在 createRequest 前就抛 identity 错。
async function makeHarness(senderId: number): Promise<Harness> {
  const ipc = new StubIpcMain();
  const identity = new IdentityRegistry();
  const scopes = new PathScopeRegistry(identity);
  const corr = new ScopeRequestCorrelator({ ttlMs: 60_000, gcIntervalMs: 60_000 });
  correlator = corr;
  registerPluginFsHandlers(ipc as never, {
    identityRegistry: identity,
    pathScopeRegistry: scopes,
    correlator: corr,
    webContentsForSender: () => null,
  });
  const reg = (await ipc.invokeWithEvent(
    makeFakeEvent({ id: senderId }),
    PLUGIN_FS_CHANNELS.REGISTER_PLUGIN,
    'plugin.fs',
  )) as { token: string };
  return { ipc, correlator: corr, token: reg.token };
}

afterEach(() => {
  correlator?.dispose();
  correlator = null;
});

describe('topic49 后续 · request-scope handler 收口窗口关闭取消', () => {
  it('窗口关闭(sender 已销毁)→ handler 解析为 deny,不冒泡 reject', async () => {
    const { ipc, correlator: corr, token } = await makeHarness(7);
    let destroyed = false;
    const event: StubIpcEvent = makeFakeEvent({
      id: 7,
      isDestroyed: () => destroyed,
    });
    const handlerPromise = ipc.invokeWithEvent(
      event,
      PLUGIN_FS_CHANNELS.REQUEST_SCOPE,
      token,
      [],
    );
    // 模拟窗口关闭:webContents 销毁 + cancelBySender 结算该窗 pending。
    destroyed = true;
    expect(corr.cancelBySender(7)).toBe(1);
    await expect(handlerPromise).resolves.toBe('deny');
  });

  it('renderer 仍存活的 TTL 超时仍按原契约 reject', async () => {
    const { ipc, correlator: corr, token } = await makeHarness(8);
    const event: StubIpcEvent = makeFakeEvent({
      id: 8,
      isDestroyed: () => false, // 窗口未关
    });
    const handlerPromise = ipc.invokeWithEvent(
      event,
      PLUGIN_FS_CHANNELS.REQUEST_SCOPE,
      token,
      [],
    );
    // 用 cancelBySender 触发同型 reject,但 sender 未销毁 → 应继续抛出。
    expect(corr.cancelBySender(8)).toBe(1);
    await expect(handlerPromise).rejects.toMatchObject({
      code: 'SCOPE_REQUEST_TIMEOUT',
    });
  });
});
