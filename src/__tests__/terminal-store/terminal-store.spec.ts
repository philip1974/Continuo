import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  filterByWorkspaceRoot,
  getIndexedTerminalSessionById,
  getShellFamily,
  useTerminalStore,
  type TerminalSession,
} from '../../stores/terminal.store';

const makeSession = (
  overrides: Partial<TerminalSession> = {},
): TerminalSession => ({
  id: '/t/1',
  title: 'Terminal 1',
  cwd: '/work',
  originHint: 'user',
  createdAt: 0,
  exitCode: null,
  ...overrides,
  ownerWindowId: 1,
});

beforeEach(() => {
  useTerminalStore.setState({
    sessions: [],
  });
});

describe('terminal.store · 初态', () => {
  it('sessions 为空', () => {
    expect(useTerminalStore.getState().sessions).toEqual([]);
  });
});

describe('filterByWorkspaceRoot', () => {
  it('空 session 列表复用稳定空列表', () => {
    const a: readonly TerminalSession[] = [];
    const b: readonly TerminalSession[] = [];
    const filtered = filterByWorkspaceRoot(a, '/work');

    expect(filtered).toEqual([]);
    expect(filterByWorkspaceRoot(b, null)).toBe(filtered);
  });

  it('全部 session 被当前 workspace 隐藏时复用稳定空列表', () => {
    const sessions = [
      makeSession({ id: '/a', workspaceRoot: '/old' }),
      makeSession({ id: '/b', workspaceRoot: '/other' }),
    ];

    const a = filterByWorkspaceRoot(sessions, '/new');
    const b = filterByWorkspaceRoot([makeSession({ id: '/c', workspaceRoot: '/x' })], '/y');

    expect(a).toEqual([]);
    expect(a).toBe(b);
  });
});

describe('getShellFamily', () => {
  it('按 session id 读取索引缓存不调用 sessions.find 线性扫描', () => {
    const sessions = [makeSession({ id: '/a' }), makeSession({ id: '/b' })];
    const findSpy = vi.spyOn(sessions, 'find');

    try {
      expect(getIndexedTerminalSessionById(sessions, '/b')).toBe(sessions[1]);
      expect(getIndexedTerminalSessionById(sessions, '/missing')).toBeUndefined();
      expect(findSpy).not.toHaveBeenCalled();
    } finally {
      findSpy.mockRestore();
    }
  });

  it('按 session id 读取 shellFamily 不调用 sessions.find 线性扫描', () => {
    const sessions = [
      makeSession({ id: '/a' }),
      makeSession({ id: '/b' }),
    ] as Array<TerminalSession & { shellFamily?: 'posix' | 'powershell' }>;
    sessions[1] = { ...sessions[1]!, shellFamily: 'powershell' };
    useTerminalStore.setState({ sessions });
    const findSpy = vi.spyOn(sessions, 'find');

    try {
      expect(getShellFamily('/b')).toBe('powershell');
      expect(findSpy).not.toHaveBeenCalled();
    } finally {
      findSpy.mockRestore();
    }
  });

  it('空 sessions 查询复用稳定空索引,不重建空 Map 且不返回旧缓存', () => {
    const sessions = [makeSession({ id: '/cached' })];
    expect(getIndexedTerminalSessionById(sessions, '/cached')).toBe(sessions[0]);

    const OriginalMap = globalThis.Map;
    let mapCtorCount = 0;
    class CountingMap<K, V> extends OriginalMap<K, V> {
      constructor(entries?: readonly (readonly [K, V])[] | null) {
        mapCtorCount += 1;
        super(entries);
      }
    }
    globalThis.Map = CountingMap as MapConstructor;

    try {
      expect(getIndexedTerminalSessionById([], '/cached')).toBeUndefined();
      expect(getIndexedTerminalSessionById([], '/missing')).toBeUndefined();
      expect(mapCtorCount).toBe(0);
    } finally {
      globalThis.Map = OriginalMap;
    }
  });
});

// ────────────────────────────────────────────────────────────
// replaceSnapshot:整体替换镜像
// ────────────────────────────────────────────────────────────

describe('replaceSnapshot', () => {
  const sess = (id: string, extra: Partial<TerminalSession> = {}) => makeSession({ id, ...extra });

  it('用 main 推来的列表整体替换(顺序以 main 为准)', () => {
    useTerminalStore.getState().replaceSnapshot([sess('/a'), sess('/b')]);
    const next = [sess('/b'), sess('/a'), sess('/c')];
    useTerminalStore.getState().replaceSnapshot(next);
    expect(useTerminalStore.getState().sessions).toBe(next);
  });

  it('仅 exitCode 等字段变化 → session 对象更新', () => {
    useTerminalStore.getState().replaceSnapshot([sess('/a')]);
    useTerminalStore.getState().replaceSnapshot([sess('/a', { exitCode: 0 })]);
    expect(useTerminalStore.getState().sessions[0]!.exitCode).toBe(0);
  });

  it('同一个 snapshot 引用 → 不通知订阅者', () => {
    const snapshot = [sess('/a')];
    useTerminalStore.getState().replaceSnapshot(snapshot);
    const listener = vi.fn();
    const unsubscribe = useTerminalStore.subscribe(listener);
    try {
      useTerminalStore.getState().replaceSnapshot(snapshot);
      expect(listener).not.toHaveBeenCalled();
    } finally {
      unsubscribe();
    }
  });

  it('重复空 snapshot 即使是新数组引用也不通知订阅者', () => {
    const listener = vi.fn();
    const unsubscribe = useTerminalStore.subscribe(listener);
    try {
      useTerminalStore.getState().replaceSnapshot([]);
      useTerminalStore.getState().replaceSnapshot([]);
      expect(listener).not.toHaveBeenCalled();
    } finally {
      unsubscribe();
    }
  });

  it('全部 session 被移除 → sessions 为空', () => {
    useTerminalStore.getState().replaceSnapshot([sess('/a')]);
    useTerminalStore.getState().replaceSnapshot([]);
    expect(useTerminalStore.getState().sessions).toEqual([]);
  });
});

// 「哪个终端处于活动状态」由 dockview 的活动 panel 决定;store 不再记 activeId,也没有改名(customTitles)。
describe('store 只镜像 sessions', () => {
  it('状态里只有 sessions 与 replaceSnapshot', () => {
    expect(Object.keys(useTerminalStore.getState()).sort()).toEqual(['replaceSnapshot', 'sessions']);
  });
});
