import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DebugViewEvent } from '../../../electron/shared/debug-view-channels';

const debugApi = vi.hoisted(() => ({
  events: [] as Array<(event: DebugViewEvent) => void>,
  onEvent: vi.fn((cb: (event: DebugViewEvent) => void) => {
    debugApi.events.push(cb);
    return () => {
      debugApi.events = debugApi.events.filter((item) => item !== cb);
    };
  }),
  subscribe: vi.fn(async () => ({ ok: true as const, data: { sessions: [] } })),
  getStack: vi.fn(async () => ({
    ok: true as const,
    data: {
      frames: [
        {
          id: 7,
          name: 'main',
          source_path: '/repo/a.ts',
          line: 14,
          column: 1,
        },
      ],
    },
  })),
  getScopes: vi.fn(async () => ({
    ok: true as const,
    data: {
      scopes: [{ name: 'Local', variables_reference: 44, expensive: false }],
    },
  })),
  getVariables: vi.fn(async () => ({
    ok: true as const,
    data: {
      variables: [{ name: 'sum', value: '21', variables_reference: 0 }],
      truncated: false,
    },
  })),
}));

vi.mock('../../lib/co-api', () => ({
  coApi: { debug: debugApi },
}));

import {
  resetDebugStoreForTest,
  startDebugStoreSync,
  useDebugStore,
} from '../../stores/debug.store';

async function flushAsync(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

afterEach(() => {
  resetDebugStoreForTest();
  debugApi.events = [];
  vi.clearAllMocks();
});

describe('topic51 Op4 · debug.store renderer shadow', () => {
  it('subscribes to debug events and mirrors breakpoint changes', async () => {
    startDebugStoreSync();

    debugApi.events[0]!({
      type: 'breakpoints-changed',
      sessionId: 's1',
      breakpoint: { file: '/repo/a.ts', line: 14, verified: true },
    });

    const session = useDebugStore.getState().sessions.get('s1');
    expect(debugApi.onEvent).toHaveBeenCalledTimes(1);
    expect(session?.breakpoints).toEqual([
      { file: '/repo/a.ts', line: 14, verified: true },
    ]);
  });

  it('on stopped pulls stack/scopes and makes the most recent stopped session active', async () => {
    startDebugStoreSync();

    debugApi.events[0]!({
      type: 'stopped',
      sessionId: 's1',
      stopSeq: 1,
      reason: 'breakpoint',
      threadId: 3,
    });
    await flushAsync();

    const state = useDebugStore.getState();
    const session = state.sessions.get('s1');
    expect(state.activeSessionId).toBe('s1');
    expect(session?.stopped).toMatchObject({
      file: '/repo/a.ts',
      line: 14,
      threadId: 3,
      reason: 'breakpoint',
      pausedEpoch: 1,
    });
    expect(session?.frames[0]?.name).toBe('main');
    expect(session?.scopes[0]?.name).toBe('Local');
  });

  it('continued clears stopped state and invalidates variable cache', async () => {
    startDebugStoreSync();
    const emit = debugApi.events[0]!;
    emit({ type: 'stopped', sessionId: 's1', stopSeq: 1, reason: 'breakpoint' });
    await flushAsync();
    await useDebugStore.getState().loadVariables('s1', 44);
    expect(debugApi.getVariables).toHaveBeenCalledTimes(1);

    emit({ type: 'continued', sessionId: 's1', runSeq: 2 });
    await useDebugStore.getState().loadVariables('s1', 44);

    const session = useDebugStore.getState().sessions.get('s1');
    expect(session?.stopped).toBeUndefined();
    expect(session?.frames).toEqual([]);
    expect(debugApi.getVariables).toHaveBeenCalledTimes(2);
  });

  it('terminated removes the session shadow and falls back to another stopped session', async () => {
    startDebugStoreSync();
    const emit = debugApi.events[0]!;

    emit({ type: 'stopped', sessionId: 's1', stopSeq: 1, reason: 'breakpoint' });
    emit({ type: 'stopped', sessionId: 's2', stopSeq: 1, reason: 'breakpoint' });
    await flushAsync();
    expect(useDebugStore.getState().activeSessionId).toBe('s2');

    emit({ type: 'terminated', sessionId: 's2', reason: 'done' });

    const state = useDebugStore.getState();
    expect(state.sessions.has('s2')).toBe(false);
    expect(state.activeSessionId).toBe('s1');
  });

  it('reuses variables within the same paused epoch and refetches after a new stop', async () => {
    startDebugStoreSync();
    const emit = debugApi.events[0]!;
    emit({ type: 'stopped', sessionId: 's1', stopSeq: 1, reason: 'breakpoint' });
    await flushAsync();

    await useDebugStore.getState().loadVariables('s1', 44);
    await useDebugStore.getState().loadVariables('s1', 44);
    expect(debugApi.getVariables).toHaveBeenCalledTimes(1);

    emit({ type: 'stopped', sessionId: 's1', stopSeq: 2, reason: 'step' });
    await flushAsync();
    await useDebugStore.getState().loadVariables('s1', 44);

    expect(debugApi.getVariables).toHaveBeenCalledTimes(2);
  });
});
