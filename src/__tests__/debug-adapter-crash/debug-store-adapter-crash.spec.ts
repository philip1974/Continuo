// BDD: debug-adapter-crash / 渲染端收到 adapter 意外退出的 terminated → 错误通知并移除会话。见同目录 README。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DebugViewEvent } from '../../../electron/shared/debug-view-channels';

const debugApi = vi.hoisted(() => ({
  events: [] as Array<(event: unknown) => void>,
  onEvent: vi.fn((cb: (event: unknown) => void) => {
    debugApi.events.push(cb);
    return () => {
      debugApi.events = debugApi.events.filter((item) => item !== cb);
    };
  }),
  subscribe: vi.fn(async () => ({ ok: true as const, data: { sessions: [] } })),
}));
const notifyMock = vi.hoisted(() => ({ error: vi.fn(), info: vi.fn(), warning: vi.fn(), success: vi.fn() }));

vi.mock('../../lib/co-api', () => ({ coApi: { debug: debugApi } }));
vi.mock('@/notifications/notify', () => ({ notify: notifyMock }));

import { resetDebugStoreForTest, startDebugStoreSync, useDebugStore } from '../../stores/debug.store';
import { getLocale, setLocale } from '../../i18n';
import { flushMicrotasks } from '../_helpers/async';

let initialLocale: ReturnType<typeof getLocale>;
beforeEach(() => {
  initialLocale = getLocale();
  setLocale('en');
});
afterEach(() => {
  resetDebugStoreForTest();
  debugApi.events = [];
  vi.clearAllMocks();
  setLocale(initialLocale);
});

const send = async (event: DebugViewEvent) => {
  debugApi.events[0]!(event);
  await flushMicrotasks();
};

describe('adapter 意外退出的提示', () => {
  it('带 adapterCrashed 的 terminated → 错误通知「Debug adapter process has terminated unexpectedly (…)」,会话移除', async () => {
    startDebugStoreSync();
    await send({ type: 'started', sessionId: 's1', label: 'app.js' });
    expect(useDebugStore.getState().sessions.has('s1')).toBe(true);

    await send({ type: 'terminated', sessionId: 's1', adapterCrashed: 'signal: SIGKILL' });
    expect(notifyMock.error).toHaveBeenCalledWith('Debug adapter process has terminated unexpectedly (signal: SIGKILL)');
    expect(useDebugStore.getState().sessions.has('s1')).toBe(false);
  });

  it('中文界面 → 中文提示', async () => {
    setLocale('zh');
    startDebugStoreSync();
    await send({ type: 'terminated', sessionId: 's1', adapterCrashed: 'exit code: 3' });
    expect(notifyMock.error).toHaveBeenCalledWith('调试适配器进程意外终止（exit code: 3）');
  });

  it('普通 terminated 不提示', async () => {
    startDebugStoreSync();
    await send({ type: 'started', sessionId: 's1' });
    await send({ type: 'terminated', sessionId: 's1' });
    expect(notifyMock.error).not.toHaveBeenCalled();
  });
});
