// @vitest-environment jsdom
// main 侧已收口(超时 / 插件已注销)的 scope 请求:renderer 撤掉对应弹窗并推进队列,不回传决定
// (main 已无此请求,回传只会失败并弹「决定未生效」的错误提示)。
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  onScopeRequest: vi.fn(),
  onScopeRequestCancelled: vi.fn(),
  scopeDecision: vi.fn(),
  notifyError: vi.fn(),
}));

vi.mock('@/lib/co-api', () => ({
  coApi: {
    pluginFsRaw: {
      onScopeRequest: h.onScopeRequest,
      onScopeRequestCancelled: h.onScopeRequestCancelled,
      _scopeDecision: h.scopeDecision,
    },
  },
}));
vi.mock('@/notifications/notify', () => ({ notify: { error: h.notifyError } }));

import { usePermissionPromptStore } from '../../plugins/permissions/promptStore';
import { startPluginFsScopeRequestBridge } from '../../plugins/permissions/usePluginFsScopeRequests';

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));
const unsubRequest = vi.fn();
const unsubCancelled = vi.fn();

function start(): {
  stop: () => void;
  request: (requestId: string) => void;
  cancel: (payload: unknown) => void;
} {
  const stop = startPluginFsScopeRequestBridge();
  const onRequest = h.onScopeRequest.mock.calls[0]![0] as (p: unknown) => void;
  const cancel = h.onScopeRequestCancelled.mock.calls[0]![0] as (p: unknown) => void;
  return {
    stop,
    request: (requestId) =>
      onRequest({ requestId, pluginId: 'com.test', scopes: [{ path: `/tmp/${requestId}`, mode: 'r' }] }),
    cancel,
  };
}

beforeEach(() => {
  Object.values(h).forEach((m) => m.mockReset());
  unsubRequest.mockReset();
  unsubCancelled.mockReset();
  h.onScopeRequest.mockReturnValue(unsubRequest);
  h.onScopeRequestCancelled.mockReturnValue(unsubCancelled);
  h.scopeDecision.mockResolvedValue(undefined);
  const store = usePermissionPromptStore.getState();
  for (const id of [...store.fsScopeQueue]) store.denyFsScope(id);
});

describe('main 撤销 scope 请求 → renderer 撤掉弹窗', () => {
  it('当前弹窗被撤销 → 关闭并显示队列里的下一个;不回传决定、不报错', async () => {
    const bridge = start();
    bridge.request('r1');
    bridge.request('r2');
    expect(usePermissionPromptStore.getState().currentFsScope?.requestId).toBe('r1');

    bridge.cancel({ requestId: 'r1' });
    await flush();
    expect(usePermissionPromptStore.getState().currentFsScope?.requestId).toBe('r2');
    expect(h.scopeDecision).not.toHaveBeenCalled();
    expect(h.notifyError).not.toHaveBeenCalled();

    // 没被撤销的请求照常回传用户的决定。
    usePermissionPromptStore.getState().grantFsScope('r2');
    await flush();
    expect(h.scopeDecision.mock.calls).toEqual([['r2', 'grant']]);
    bridge.stop();
  });

  it('未知 requestId / 畸形 payload → 忽略,不影响现有弹窗', async () => {
    const bridge = start();
    bridge.request('r1');
    for (const payload of [null, {}, { requestId: 7 }, { requestId: 'nope' }, { requestId: 'x'.repeat(1000) }]) {
      bridge.cancel(payload);
    }
    await flush();
    expect(usePermissionPromptStore.getState().currentFsScope?.requestId).toBe('r1');
    // 未知 id 的撤销不留痕:之后同 id 的真实请求照常回传决定。
    bridge.request('nope');
    usePermissionPromptStore.getState().denyFsScope('nope');
    usePermissionPromptStore.getState().denyFsScope('r1');
    await flush();
    expect(h.scopeDecision.mock.calls).toEqual([
      ['nope', 'deny'],
      ['r1', 'deny'],
    ]);
    bridge.stop();
  });

  it('bridge 停止 → 撤销订阅一并取消', () => {
    const bridge = start();
    bridge.stop();
    expect(unsubRequest).toHaveBeenCalledTimes(1);
    expect(unsubCancelled).toHaveBeenCalledTimes(1);
  });
});
