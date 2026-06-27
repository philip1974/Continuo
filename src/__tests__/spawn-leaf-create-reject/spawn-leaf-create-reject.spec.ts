// @vitest-environment jsdom
// a11y(A129,A116/A128 同族):spawnLeaf run() 的 coApi.terminal.create reject 此前由外层
// void run() 丢弃 → modulePending 不清、不派 SET_PTY_FAIL,终端 leaf 永久 loading。
// 须 try/catch:清账 + 派 SET_PTY_FAIL(若仍有 live dispatch)+ notify.error。
import { describe, it, expect, beforeEach, vi } from 'vitest';

const h = vi.hoisted(() => ({
  create: vi.fn(),
  notifyError: vi.fn(),
}));
vi.mock('@/lib/co-api', () => ({
  coApi: { terminal: { create: h.create, remove: vi.fn(async () => ({ ok: true })) } },
}));
vi.mock('@/notifications/notify', () => ({ notify: { error: h.notifyError } }));

import { createSpawnQueue, type SpawnRequest } from '../../panels/Terminal/spawnLeaf';

function makeReq(over: Partial<SpawnRequest> = {}): SpawnRequest {
  return {
    tabId: 't1',
    leafId: 'l1',
    scoped: false,
    reason: 'split',
    cancelled: { current: false },
    ...over,
  };
}

beforeEach(() => {
  h.create.mockReset();
  h.notifyError.mockReset();
});

describe('a11y(A129) — spawnLeaf create reject 须清账 + 反馈', () => {
  it('pendingKeys 不通过 Array.from(keys).filter 生成中间数组', () => {
    const queue = createSpawnQueue(vi.fn(), new Set(), 'terminal-panelPendingKeys');
    const arrayFromSpy = vi.spyOn(Array, 'from');
    try {
      expect(queue.pendingKeys()).toEqual([]);
      expect(arrayFromSpy).not.toHaveBeenCalled();
    } finally {
      arrayFromSpy.mockRestore();
    }
  });

  it('create reject → 派 SET_PTY_FAIL + notify.error + 清 pending', async () => {
    h.create.mockRejectedValue(new Error('ipc down'));
    const dispatch = vi.fn();
    const queue = createSpawnQueue(dispatch, new Set(), 'terminal-panelA');
    queue.enqueue(makeReq());
    await vi.waitFor(() => {
      expect(dispatch).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'PANE_ACTION',
          tabId: 't1',
          action: { type: 'SET_PTY_FAIL', leafId: 'l1' },
        }),
      );
      expect(h.notifyError).toHaveBeenCalledTimes(1);
    });
    // pending 已清(否则同 key 再 enqueue 会被当 in-flight 跳过)
    expect(queue.pendingKeys()).toHaveLength(0);
  });

  it('create reject 但已 cancelled → 不派 fail/不 notify(静默清账)', async () => {
    h.create.mockRejectedValue(new Error('ipc down'));
    const dispatch = vi.fn();
    const queue = createSpawnQueue(dispatch, new Set(), 'terminal-panelB');
    const cancelled = { current: false };
    queue.enqueue(makeReq({ cancelled }));
    cancelled.current = true; // create 往返期间被取消
    await vi.waitFor(() => {
      expect(queue.pendingKeys()).toHaveLength(0);
    });
    expect(h.notifyError).not.toHaveBeenCalled();
    expect(dispatch).not.toHaveBeenCalled();
  });
});
