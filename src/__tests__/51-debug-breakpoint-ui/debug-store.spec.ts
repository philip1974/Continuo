import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DEBUG_VIEW_SNAPSHOT_BREAKPOINTS_MAX,
  type DebugViewEvent,
} from '../../../electron/shared/debug-view-channels';

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
      // 首帧的作用域随栈帧一次返回(面板不能切帧,首帧 id 是 main 自己刚取到的,不必再绕 renderer 一趟)。
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
import { flushMicrotasks } from '../_helpers/async';

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
      file: '/repo/a.ts',
      breakpoints: [{ file: '/repo/a.ts', line: 14, verified: true }],
    });

    const session = useDebugStore.getState().sessions.get('s1');
    expect(debugApi.onEvent).toHaveBeenCalledTimes(1);
    expect(session?.breakpoints).toEqual([
      { file: '/repo/a.ts', line: 14, verified: true },
    ]);
  });

  // 启动入口与 DebugPanel(StrictMode 双挂载)都会调用:重复调用不重复订阅。
  it('startDebugStoreSync 幂等:多次调用只订阅一次', () => {
    startDebugStoreSync();
    startDebugStoreSync();
    expect(debugApi.onEvent).toHaveBeenCalledTimes(1);
    expect(debugApi.subscribe).toHaveBeenCalledTimes(1);
  });

  // main 每次推该 source 的完整集合(adapter 校正后的行号):renderer 整组替换该 file 的记录、其它文件保留。
  // 按 file+校正后行号增量合并时,同一逻辑断点第二次被校正到不同行会留下旧红点。
  it('breakpoints-changed 按 source 整组替换:其它文件保留,重新校正的行不留旧红点', () => {
    startDebugStoreSync();
    const emit = debugApi.events[0]!;
    emit({
      type: 'breakpoints-changed',
      sessionId: 's1',
      file: '/repo/a.ts',
      breakpoints: [{ file: '/repo/a.ts', line: 4, verified: true }],
    });
    emit({
      type: 'breakpoints-changed',
      sessionId: 's1',
      file: '/repo/b.ts',
      breakpoints: [{ file: '/repo/b.ts', line: 3, verified: true }],
    });
    // 同一逻辑断点(请求第 3 行)这次被校正到第 5 行,并新增第 7 行。
    emit({
      type: 'breakpoints-changed',
      sessionId: 's1',
      file: '/repo/a.ts',
      breakpoints: [
        { file: '/repo/a.ts', line: 5, verified: true },
        { file: '/repo/a.ts', line: 7, verified: false },
      ],
    });

    expect(useDebugStore.getState().sessions.get('s1')?.breakpoints).toEqual([
      { file: '/repo/b.ts', line: 3, verified: true },
      { file: '/repo/a.ts', line: 5, verified: true },
      { file: '/repo/a.ts', line: 7, verified: false },
    ]);
  });

  it('on stopped pulls stack/scopes and makes the most recent stopped session active', async () => {
    startDebugStoreSync();

    debugApi.events[0]!({
      type: 'stopped',
      sessionId: 's1',
      stopSeq: 1,
      reason: 'breakpoint',
    });
    await flushMicrotasks(2);

    const state = useDebugStore.getState();
    const session = state.sessions.get('s1');
    expect(state.activeSessionId).toBe('s1');
    expect(session?.stopped).toMatchObject({
      file: '/repo/a.ts',
      line: 14,
      reason: 'breakpoint',
    });
    expect(session?.frames[0]?.name).toBe('main');
    expect(session?.scopes[0]?.name).toBe('Local');
  });

  it('continued clears stopped state and invalidates variable cache', async () => {
    startDebugStoreSync();
    const emit = debugApi.events[0]!;
    emit({ type: 'stopped', sessionId: 's1', stopSeq: 1, reason: 'breakpoint' });
    await flushMicrotasks(2);
    await useDebugStore.getState().loadVariables('s1', 44);
    expect(debugApi.getVariables).toHaveBeenCalledTimes(1);

    emit({ type: 'continued', sessionId: 's1' });
    await useDebugStore.getState().loadVariables('s1', 44);

    const session = useDebugStore.getState().sessions.get('s1');
    expect(session?.stopped).toBeUndefined();
    expect(session?.frames).toEqual([]);
    expect(debugApi.getVariables).toHaveBeenCalledTimes(2);
  });

  // 连续 step(stopped → continued → stopped)时,上一停在途的请求晚到,不能写进新一停。
  it('上一停迟到的 stack 不覆盖新一停的栈帧与停靠行', async () => {
    startDebugStoreSync();
    const emit = debugApi.events[0]!;
    const frame = (line: number) => ({
      ok: true as const,
      data: {
        frames: [{ id: line, name: `at-${line}`, source_path: '/repo/a.ts', line, column: 1 }],
        scopes: [],
      },
    });
    let releaseOld: (() => void) | null = null;
    debugApi.getStack.mockImplementationOnce(
      () => new Promise((r) => { releaseOld = () => r(frame(14)); }),
    );
    debugApi.getStack.mockImplementationOnce(async () => frame(99));

    emit({ type: 'stopped', sessionId: 's1', stopSeq: 1, reason: 'step' });
    emit({ type: 'continued', sessionId: 's1' });
    emit({ type: 'stopped', sessionId: 's1', stopSeq: 2, reason: 'step' });
    await flushMicrotasks(2);
    await flushMicrotasks(2);
    expect(useDebugStore.getState().sessions.get('s1')?.stopped?.line).toBe(99);

    releaseOld!();
    await flushMicrotasks(2);
    await flushMicrotasks(2);
    const session = useDebugStore.getState().sessions.get('s1');
    expect(session?.stopped?.line).toBe(99);
    expect(session?.frames[0]?.name).toBe('at-99');
  });

  it('上一停迟到的 variables 不写到新一停同号 reference 下', async () => {
    startDebugStoreSync();
    const emit = debugApi.events[0]!;
    emit({ type: 'stopped', sessionId: 's1', stopSeq: 1, reason: 'step' });
    await flushMicrotasks(2);

    let releaseOld: (() => void) | null = null;
    debugApi.getVariables.mockImplementationOnce(
      () =>
        new Promise((r) => {
          releaseOld = () =>
            r({
              ok: true as const,
              data: { variables: [{ name: 'old', value: '1', variables_reference: 0 }], truncated: false },
            });
        }),
    );
    const pending = useDebugStore.getState().loadVariables('s1', 44);

    emit({ type: 'continued', sessionId: 's1' });
    emit({ type: 'stopped', sessionId: 's1', stopSeq: 2, reason: 'step' });
    await flushMicrotasks(2);
    releaseOld!();
    await pending;

    expect(useDebugStore.getState().sessions.get('s1')?.variableRefs.get(44)).toBeUndefined();
  });

  it('terminated removes the session shadow and falls back to another stopped session', async () => {
    startDebugStoreSync();
    const emit = debugApi.events[0]!;

    emit({ type: 'stopped', sessionId: 's1', stopSeq: 1, reason: 'breakpoint' });
    emit({ type: 'stopped', sessionId: 's2', stopSeq: 1, reason: 'breakpoint' });
    await flushMicrotasks(2);
    expect(useDebugStore.getState().activeSessionId).toBe('s2');

    emit({ type: 'terminated', sessionId: 's2' });

    const state = useDebugStore.getState();
    expect(state.sessions.has('s2')).toBe(false);
    expect(state.activeSessionId).toBe('s1');
  });

  it('reuses variables within the same paused epoch and refetches after a new stop', async () => {
    startDebugStoreSync();
    const emit = debugApi.events[0]!;
    emit({ type: 'stopped', sessionId: 's1', stopSeq: 1, reason: 'breakpoint' });
    await flushMicrotasks(2);

    await useDebugStore.getState().loadVariables('s1', 44);
    await useDebugStore.getState().loadVariables('s1', 44);
    expect(debugApi.getVariables).toHaveBeenCalledTimes(1);

    emit({ type: 'stopped', sessionId: 's1', stopSeq: 2, reason: 'step' });
    await flushMicrotasks(2);
    await useDebugStore.getState().loadVariables('s1', 44);

    expect(debugApi.getVariables).toHaveBeenCalledTimes(2);
  });

  // 终审:renderer 重载(Cmd+R)后 store 为空,main 只推增量事件 → 用 subscribe 快照恢复停点与断点。
  describe('subscribe 快照 hydrate(renderer 重载后恢复)', () => {
    const snapshot = {
      sessions: [
        {
          session_id: 's1',
          state: 'stopped',
          owner_window_id: 1,
          stopped_reason: 'breakpoint',
          stop: { stopSeq: 3, reason: 'breakpoint' },
          breakpointsBySource: [
            { file: '/repo/a.ts', breakpoints: [{ file: '/repo/a.ts', line: 14, verified: true }] },
            { file: '/repo/b.ts', breakpoints: [{ file: '/repo/b.ts', line: 2, verified: false, message: 'pending' }] },
          ],
        },
        {
          session_id: 's2',
          state: 'running',
          owner_window_id: 1,
          breakpointsBySource: [],
        },
      ],
    };

    it('快照里的停点、断点进 store,并拉取该停点的栈帧 / 作用域', async () => {
      debugApi.subscribe.mockResolvedValueOnce({ ok: true, data: snapshot } as never);
      startDebugStoreSync();

      await vi.waitFor(() =>
        expect(useDebugStore.getState().sessions.get('s1')?.frames).toHaveLength(1),
      );
      const state = useDebugStore.getState();
      const s1 = state.sessions.get('s1');
      expect(s1?.breakpoints).toEqual([
        { file: '/repo/a.ts', line: 14, verified: true },
        { file: '/repo/b.ts', line: 2, verified: false, message: 'pending' },
      ]);
      expect(s1?.stopped).toMatchObject({ reason: 'breakpoint', stopSeq: 3, file: '/repo/a.ts', line: 14 });
      expect(s1?.scopes).toEqual([{ name: 'Local', variables_reference: 44, expensive: false }]);
      expect(state.activeSessionId).toBe('s1');
      expect(state.sessions.get('s2')?.stopped).toBeUndefined();
      expect(debugApi.getStack).toHaveBeenCalledWith({ sessionId: 's1' });

      // 之后的事件照常增量。
      debugApi.events[0]!({ type: 'continued', sessionId: 's1' });
      expect(useDebugStore.getState().sessions.get('s1')?.stopped).toBeUndefined();
    });

    it('快照到达前已收到的事件更新:不被快照覆盖,也不复活已结束的会话', async () => {
      let resolveSubscribe!: (value: unknown) => void;
      debugApi.subscribe.mockReturnValueOnce(
        new Promise((resolve) => {
          resolveSubscribe = resolve;
        }) as never,
      );
      startDebugStoreSync();
      const emit = debugApi.events[0]!;
      // 快照计算之后、送达之前:a.ts 断点被改、s1 已继续、s2 已结束。
      emit({
        type: 'breakpoints-changed',
        sessionId: 's1',
        file: '/repo/a.ts',
        breakpoints: [{ file: '/repo/a.ts', line: 20, verified: true }],
      });
      emit({ type: 'continued', sessionId: 's1' });
      emit({ type: 'terminated', sessionId: 's2' });
      resolveSubscribe({ ok: true, data: snapshot });
      await flushMicrotasks(2);
      await flushMicrotasks(2);

      const state = useDebugStore.getState();
      expect(state.sessions.get('s1')?.breakpoints).toEqual([
        { file: '/repo/a.ts', line: 20, verified: true },
        { file: '/repo/b.ts', line: 2, verified: false, message: 'pending' },
      ]);
      expect(state.sessions.get('s1')?.stopped).toBeUndefined();
      expect(state.sessions.has('s2')).toBe(false);
      expect(debugApi.getStack).not.toHaveBeenCalled();
    });

    it('快照形态校验:畸形条目丢弃,断点数按上限截断', async () => {
      const many = Array.from({ length: DEBUG_VIEW_SNAPSHOT_BREAKPOINTS_MAX + 10 }, (_, i) => ({
        file: '/repo/a.ts',
        line: i + 1,
        verified: true,
      }));
      debugApi.subscribe.mockResolvedValueOnce({
        ok: true,
        data: {
          sessions: [
            null,
            { session_id: 42 },
            {
              session_id: 's3',
              state: 'running',
              owner_window_id: 1,
              stop: { stopSeq: 'x', reason: 'breakpoint' },
              breakpointsBySource: [
                { file: '/repo/a.ts', breakpoints: [...many, { file: '/repo/a.ts', line: 'bad' }] },
                { file: 7, breakpoints: [] },
              ],
            },
          ],
        },
      } as never);
      startDebugStoreSync();
      await flushMicrotasks(2);
      await flushMicrotasks(2);

      const state = useDebugStore.getState();
      expect([...state.sessions.keys()]).toEqual(['s3']);
      expect(state.sessions.get('s3')?.stopped).toBeUndefined();
      expect(state.sessions.get('s3')?.breakpoints).toHaveLength(DEBUG_VIEW_SNAPSHOT_BREAKPOINTS_MAX);
    });
  });
});

// 边界(E168-E175 push ingress 守卫族):debug 事件与 subscribe 快照同形,快照逐字段校验并截断,事件此前直接
// 进 store。畸形事件 drop + warn,不抛、不污染 store;断点数按同一上限截断。
describe('debug 事件入口校验', () => {
  const emit = (event: unknown) => debugApi.events[0]!(event as DebugViewEvent);

  it('畸形事件(null / 缺字段 / 类型不对)→ drop,不抛,store 不变', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    startDebugStoreSync();
    expect(() => emit(null)).not.toThrow();
    emit({ type: 'breakpoints-changed', sessionId: 's1', file: '/a.ts', breakpoints: 'x' });
    emit({ type: 'stopped', sessionId: 's1', stopSeq: 'one', reason: 'step' });
    emit({ type: 'continued' });
    emit({ type: 'unknown', sessionId: 's1' });
    expect(useDebugStore.getState().sessions.size).toBe(0);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('breakpoints-changed:逐个校验断点(丢弃畸形项)并按上限截断', () => {
    startDebugStoreSync();
    const many = Array.from({ length: DEBUG_VIEW_SNAPSHOT_BREAKPOINTS_MAX + 5 }, (_, i) => ({
      file: '/a.ts',
      line: i + 1,
      verified: true,
    }));
    emit({
      type: 'breakpoints-changed',
      sessionId: 's1',
      file: '/a.ts',
      breakpoints: [{ file: '/a.ts', line: 'bad', verified: true }, ...many],
    });
    const bps = useDebugStore.getState().sessions.get('s1')?.breakpoints ?? [];
    expect(bps).toHaveLength(DEBUG_VIEW_SNAPSHOT_BREAKPOINTS_MAX);
    expect(bps.every((bp) => typeof bp.line === 'number')).toBe(true);
  });
});

describe('debug 事件入口校验 — 字段与会话级上限', () => {
  const emit = (event: unknown) => debugApi.events[0]!(event as DebugViewEvent);

  it('断点的 column 字段保留(main breakpointSnapshot 会带)', () => {
    startDebugStoreSync();
    emit({
      type: 'breakpoints-changed',
      sessionId: 's1',
      file: '/a.ts',
      breakpoints: [{ file: '/a.ts', line: 3, column: 5, verified: true }],
    });
    expect(useDebugStore.getState().sessions.get('s1')?.breakpoints).toEqual([
      { file: '/a.ts', line: 3, column: 5, verified: true },
    ]);
  });

  it('跨文件累计的断点总数按会话上限截断(同 subscribe 快照口径)', () => {
    startDebugStoreSync();
    const half = Math.ceil(DEBUG_VIEW_SNAPSHOT_BREAKPOINTS_MAX / 2) + 10;
    for (const file of ['/a.ts', '/b.ts']) {
      emit({
        type: 'breakpoints-changed',
        sessionId: 's1',
        file,
        breakpoints: Array.from({ length: half }, (_, i) => ({ file, line: i + 1, verified: true })),
      });
    }
    expect(useDebugStore.getState().sessions.get('s1')?.breakpoints.length).toBe(
      DEBUG_VIEW_SNAPSHOT_BREAKPOINTS_MAX,
    );
  });
});
