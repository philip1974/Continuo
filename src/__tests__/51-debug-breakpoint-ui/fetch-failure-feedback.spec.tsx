// @vitest-environment jsdom
// Debug 面板拉取失败须有反馈(此前全部静默):
//   - 停下后取栈失败(ok:false / reject)→ 提示;但仅当仍是发起拉取的那一停(continue / 下一停后迟到的失败不提示);
//   - 进入变量页自动加载第一个作用域 / 用户点「加载作用域」失败(ok:false / reject)→ 提示,「加载」按钮可点重试;
//   - 任何失败都不产生未处理 rejection。

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { DebugViewEvent } from '../../../electron/shared/debug-view-channels';

const h = vi.hoisted(() => ({
  notifyError: vi.fn(),
  events: [] as Array<(event: DebugViewEvent) => void>,
}));

const debugApi = vi.hoisted(() => ({
  onEvent: vi.fn((cb: (event: DebugViewEvent) => void) => {
    h.events.push(cb);
    return () => {
      h.events = h.events.filter((item) => item !== cb);
    };
  }),
  subscribe: vi.fn(async () => ({ ok: true as const, data: { sessions: [] as unknown[] } })),
  getStack: vi.fn(),
  getVariables: vi.fn(),
}));

vi.mock('../../lib/co-api', () => ({ coApi: { debug: debugApi } }));
vi.mock('@/notifications/notify', () => ({ notify: { error: h.notifyError } }));

import { DebugPanel } from '../../panels/Debug/DebugPanel';
import {
  resetDebugStoreForTest,
  startDebugStoreSync,
  useDebugStore,
} from '../../stores/debug.store';
import { setLocale } from '../../i18n';
import { deferred, flushMicrotasks } from '../_helpers/async';

const okStack = {
  ok: true as const,
  data: {
    frames: [{ id: 7, name: 'main', source_path: '/repo/a.ts', line: 14, column: 1 }],
    scopes: [{ name: 'Local', variables_reference: 44, expensive: false }],
  },
};
const failure = { ok: false as const, code: 'DEBUG_SESSION_NOT_FOUND', message: 'gone' };

const unhandled: unknown[] = [];
const onUnhandled = (reason: unknown): void => {
  unhandled.push(reason);
};

beforeEach(() => {
  setLocale('en');
  unhandled.length = 0;
  process.on('unhandledRejection', onUnhandled);
  debugApi.getStack.mockResolvedValue(okStack);
  debugApi.getVariables.mockResolvedValue({
    ok: true,
    data: { variables: [{ name: 'sum', value: '21', variables_reference: 0 }], truncated: false },
  });
});

afterEach(async () => {
  // 给未处理 rejection 一次宏任务的上报机会,再断言(先清理,断言失败也不串到下一用例)。
  await new Promise((r) => setTimeout(r, 0));
  process.off('unhandledRejection', onUnhandled);
  cleanup();
  resetDebugStoreForTest();
  h.events = [];
  vi.clearAllMocks();
  expect(unhandled).toEqual([]);
});

function emit(event: DebugViewEvent): void {
  h.events[0]!(event);
}

describe('停下后取栈失败 → 提示(仅限当前这一停)', () => {
  it('getStack ok:false → 按 code 本地化提示', async () => {
    debugApi.getStack.mockResolvedValueOnce(failure);
    startDebugStoreSync();
    emit({ type: 'stopped', sessionId: 's1', stopSeq: 1, reason: 'breakpoint' });
    await flushMicrotasks(4);
    expect(h.notifyError).toHaveBeenCalledTimes(1);
    expect(h.notifyError.mock.calls[0]![0]).toBe('Debug session not found');
    expect(h.notifyError.mock.calls[0]![1]).toMatchObject({ code: 'DEBUG_SESSION_NOT_FOUND' });
  });

  it('getStack reject → 提示,且无未处理 rejection', async () => {
    debugApi.getStack.mockRejectedValueOnce(new Error('ipc down'));
    startDebugStoreSync();
    emit({ type: 'stopped', sessionId: 's1', stopSeq: 1, reason: 'breakpoint' });
    await flushMicrotasks(4);
    expect(h.notifyError).toHaveBeenCalledTimes(1);
  });

  it('continue 之后才到的旧一停失败(ok:false / reject)→ 不提示', async () => {
    const first = deferred<typeof failure>();
    const second = deferred<never>();
    debugApi.getStack.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    startDebugStoreSync();
    emit({ type: 'stopped', sessionId: 's1', stopSeq: 1, reason: 'step' });
    emit({ type: 'continued', sessionId: 's1' });
    emit({ type: 'stopped', sessionId: 's1', stopSeq: 2, reason: 'step' });
    emit({ type: 'continued', sessionId: 's1' });
    first.resolve(failure);
    second.reject(new Error('late'));
    await flushMicrotasks(6);
    expect(h.notifyError).not.toHaveBeenCalled();
  });

  it('快照 hydrate 触发的取栈失败同样提示(仍是当前停)', async () => {
    debugApi.subscribe.mockResolvedValueOnce({
      ok: true,
      data: {
        sessions: [
          {
            session_id: 's1',
            state: 'stopped',
            owner_window_id: 1,
            stop: { stopSeq: 3, reason: 'breakpoint' },
            breakpointsBySource: [],
          },
        ],
      },
    });
    debugApi.getStack.mockRejectedValueOnce(new Error('ipc down'));
    startDebugStoreSync();
    await flushMicrotasks(6);
    expect(useDebugStore.getState().sessions.get('s1')?.stopped?.stopSeq).toBe(3);
    expect(h.notifyError).toHaveBeenCalledTimes(1);
  });
});

describe('加载作用域失败(自动加载第一个作用域同样)→ 提示', () => {
  async function renderStoppedPanel(): Promise<void> {
    startDebugStoreSync();
    emit({ type: 'stopped', sessionId: 's1', stopSeq: 1, reason: 'breakpoint' });
    await flushMicrotasks(4);
    render(<DebugPanel />);
    fireEvent.click(screen.getByRole('tab', { name: 'Variables' }));
  }

  it('getVariables ok:false → 提示,「加载」按钮可点(重试)', async () => {
    debugApi.getVariables.mockResolvedValueOnce(failure);
    // 进入变量页即自动加载 Local(首个作用域),失败后「Load Local」按钮可点重试。
    await renderStoppedPanel();
    await waitFor(() => expect(h.notifyError).toHaveBeenCalledTimes(1));
    expect(h.notifyError.mock.calls[0]![1]).toMatchObject({ code: 'DEBUG_SESSION_NOT_FOUND' });
    await waitFor(() =>
      expect((screen.getByRole('button', { name: 'Load Local' }) as HTMLButtonElement).disabled).toBe(false),
    );
  });

  it('getVariables reject → 提示,且无未处理 rejection', async () => {
    debugApi.getVariables.mockRejectedValueOnce(new Error('ipc down'));
    // 进入变量页即自动加载 Local(首个作用域),失败后「Load Local」按钮可点重试。
    await renderStoppedPanel();
    await waitFor(() => expect(h.notifyError).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect((screen.getByRole('button', { name: 'Load Local' }) as HTMLButtonElement).disabled).toBe(false),
    );
  });
});

// 与取栈同规则:variablesReference 只在本停有效,发起后继续运行 / 进入下一停的迟到失败不提示。
describe('加载作用域的迟到失败', () => {
  it('发起后 continue,旧一停的 getVariables 失败(ok:false / reject)→ 不提示', async () => {
    const a = deferred<typeof failure>();
    const b = deferred<never>();
    debugApi.getVariables.mockReturnValueOnce(a.promise).mockReturnValueOnce(b.promise);
    startDebugStoreSync();
    emit({ type: 'stopped', sessionId: 's1', stopSeq: 1, reason: 'breakpoint' });
    await flushMicrotasks(4);
    const p1 = useDebugStore.getState().loadVariables('s1', 44);
    const p2 = useDebugStore.getState().loadVariables('s1', 45);
    emit({ type: 'continued', sessionId: 's1' });
    a.resolve(failure);
    b.reject(new Error('late'));
    await expect(p1).resolves.toEqual([]);
    await expect(p2).resolves.toEqual([]);
    expect(h.notifyError).not.toHaveBeenCalled();
  });
});

