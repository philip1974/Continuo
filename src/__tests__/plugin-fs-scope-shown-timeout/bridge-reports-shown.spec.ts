// @vitest-environment jsdom
// renderer 的 fs-scope 弹窗开始显示某个请求时回报 main 一次(main 从此刻起计无应答超时)。行为见同目录 README。
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  onScopeRequest: vi.fn(),
  onScopeRequestCancelled: vi.fn(),
  scopeDecision: vi.fn(),
  scopeShown: vi.fn(),
}));

vi.mock('@/lib/co-api', () => ({
  coApi: {
    pluginFsRaw: {
      onScopeRequest: h.onScopeRequest,
      onScopeRequestCancelled: h.onScopeRequestCancelled,
      _scopeDecision: h.scopeDecision,
      _scopeShown: h.scopeShown,
    },
  },
}));
vi.mock('@/notifications/notify', () => ({ notify: { error: vi.fn() } }));

import { usePermissionPromptStore } from '../../plugins/permissions/promptStore';
import { startPluginFsScopeRequestBridge } from '../../plugins/permissions/usePluginFsScopeRequests';
import { flushMacrotasks } from '../_helpers/async';

function start(): { stop: () => void; request: (id: string) => void; cancel: (id: string) => void } {
  const stop = startPluginFsScopeRequestBridge();
  const onRequest = h.onScopeRequest.mock.calls[0]![0] as (p: unknown) => void;
  const onCancel = h.onScopeRequestCancelled.mock.calls[0]![0] as (p: unknown) => void;
  return {
    stop,
    request: (requestId) =>
      onRequest({ requestId, pluginId: 'com.test', scopes: [{ path: `/tmp/${requestId}`, mode: 'r' }] }),
    cancel: (requestId) => onCancel({ requestId }),
  };
}

const shownIds = (): unknown[] => h.scopeShown.mock.calls.map(([id]) => id);

beforeEach(() => {
  Object.values(h).forEach((m) => m.mockReset());
  h.onScopeRequest.mockReturnValue(() => {});
  h.onScopeRequestCancelled.mockReturnValue(() => {});
  h.scopeDecision.mockResolvedValue(undefined);
  h.scopeShown.mockResolvedValue(undefined);
  const store = usePermissionPromptStore.getState();
  for (const id of [...store.fsScopeQueue]) store.denyFsScope(id);
  store.denyAll();
});

describe('弹窗开始显示时回报 main', () => {
  it('只回报显示中的队首;队首应答 / 被撤后回报下一个;每个请求只回报一次', async () => {
    const bridge = start();
    bridge.request('r1');
    bridge.request('r2');
    bridge.request('r3');
    expect(shownIds()).toEqual(['r1']);

    usePermissionPromptStore.getState().grantFsScope('r1');
    await flushMacrotasks(1);
    expect(shownIds()).toEqual(['r1', 'r2']);

    bridge.cancel('r2');
    await flushMacrotasks(1);
    expect(shownIds()).toEqual(['r1', 'r2', 'r3']);
    bridge.stop();
  });

  it('manifest 权限弹窗占屏时 fs-scope 队首未显示 → 不回报;manifest 关闭后再回报', async () => {
    const bridge = start();
    void usePermissionPromptStore.getState().request('com.other', ['fs']);
    bridge.request('r1');
    expect(shownIds()).toEqual([]);

    usePermissionPromptStore.getState().denyAll();
    expect(shownIds()).toEqual(['r1']);
    bridge.stop();
  });

  it('回报失败不抛、不影响弹窗;bridge 停止后不再回报', async () => {
    h.scopeShown.mockRejectedValue(new Error('unknown'));
    const bridge = start();
    bridge.request('r1');
    await flushMacrotasks(1);
    expect(usePermissionPromptStore.getState().currentFsScope?.requestId).toBe('r1');

    bridge.stop();
    bridge.request('r2');
    usePermissionPromptStore.getState().denyFsScope('r1');
    expect(shownIds()).toEqual(['r1']);
  });
});
