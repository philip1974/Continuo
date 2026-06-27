import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  applySnapshot,
  getIndexedTerminalSessionById,
  getShellFamily,
  nextActiveAfterClose,
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
    activeId: null,
    customTitles: new Map(),
  });
});

// ────────────────────────────────────────────────────────────
// nextActiveAfterClose 纯函数(保留,被 replaceSnapshot 内部用)
// ────────────────────────────────────────────────────────────

describe('nextActiveAfterClose', () => {
  const s = (id: string) => makeSession({ id });
  const list = [s('/a'), s('/b'), s('/c')];

  it('关 head 活跃 → 切下一个', () => {
    const r = nextActiveAfterClose(list, '/a', '/a');
    expect(r.sessions.map((x) => x.id)).toEqual(['/b', '/c']);
    expect(r.activeId).toBe('/b');
  });
  it('关 mid 活跃 → 切下一个', () => {
    const r = nextActiveAfterClose(list, '/b', '/b');
    expect(r.sessions.map((x) => x.id)).toEqual(['/a', '/c']);
    expect(r.activeId).toBe('/c');
  });
  it('关 tail 活跃 → 切前一个', () => {
    const r = nextActiveAfterClose(list, '/c', '/c');
    expect(r.sessions.map((x) => x.id)).toEqual(['/a', '/b']);
    expect(r.activeId).toBe('/b');
  });
  it('关非活跃 → active 不变', () => {
    const r = nextActiveAfterClose(list, '/a', '/c');
    expect(r.sessions.map((x) => x.id)).toEqual(['/a', '/b']);
    expect(r.activeId).toBe('/a');
  });
  it('关唯一 → activeId null', () => {
    const r = nextActiveAfterClose([s('/x')], '/x', '/x');
    expect(r.sessions).toEqual([]);
    expect(r.activeId).toBeNull();
  });
  it('关不存在 id → 状态不变(同引用)', () => {
    const r = nextActiveAfterClose(list, '/a', '/missing');
    expect(r.sessions).toBe(list);
    expect(r.activeId).toBe('/a');
  });
  it('命中关闭项时单次遍历 sessions,不 findIndex 后再 filter', () => {
    const findIndexSpy = vi.spyOn(Array.prototype, 'findIndex');
    const filterSpy = vi.spyOn(Array.prototype, 'filter');

    try {
      const r = nextActiveAfterClose(list, '/b', '/b');
      const findIndexCallsOnList = findIndexSpy.mock.contexts.filter(
        (ctx) => ctx === list,
      ).length;
      const filterCallsOnList = filterSpy.mock.contexts.filter(
        (ctx) => ctx === list,
      ).length;

      expect(findIndexCallsOnList).toBe(0);
      expect(filterCallsOnList).toBe(0);
      expect(r.sessions.map((x) => x.id)).toEqual(['/a', '/c']);
      expect(r.activeId).toBe('/c');
    } finally {
      findIndexSpy.mockRestore();
      filterSpy.mockRestore();
    }
  });
});

// ────────────────────────────────────────────────────────────
// 初态
// ────────────────────────────────────────────────────────────

describe('terminal.store · 初态', () => {
  it('sessions 空,activeId null', () => {
    const s = useTerminalStore.getState();
    expect(s.sessions).toEqual([]);
    expect(s.activeId).toBeNull();
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
    useTerminalStore.setState({ sessions, activeId: '/b' });
    const findSpy = vi.spyOn(sessions, 'find');

    try {
      expect(getShellFamily('/b')).toBe('powershell');
      expect(findSpy).not.toHaveBeenCalled();
    } finally {
      findSpy.mockRestore();
    }
  });
});

// ────────────────────────────────────────────────────────────
// replaceSnapshot
// ────────────────────────────────────────────────────────────

describe('replaceSnapshot', () => {
  const sess = (id: string, extra: Partial<TerminalSession> = {}) =>
    makeSession({ id, ...extra });

  it('applySnapshot 构建 newIds 不对 newSessions 先 map 成中间数组', () => {
    const oldSessions = [sess('/a'), sess('/b')];
    const newSessions = [sess('/b'), sess('/c')];
    const mapSpy = vi.spyOn(Array.prototype, 'map');

    let r: ReturnType<typeof applySnapshot> | null = null;
    try {
      r = applySnapshot(oldSessions, '/a', newSessions);
      const mapCallsOnNewSessions = mapSpy.mock.contexts.filter(
        (ctx) => ctx === newSessions,
      ).length;
      expect(mapCallsOnNewSessions).toBe(0);
    } finally {
      mapSpy.mockRestore();
    }

    expect(r?.sessions).toBe(newSessions);
    expect(r?.activeId).toBe('/b');
  });

  it('空 → 非空:activeId 设为第一个', () => {
    useTerminalStore.getState().replaceSnapshot([sess('/a'), sess('/b')]);
    const s = useTerminalStore.getState();
    expect(s.sessions.map((x) => x.id)).toEqual(['/a', '/b']);
    expect(s.activeId).toBe('/a');
  });

  it('旧 active 仍在新 snapshot → activeId 不变', () => {
    useTerminalStore.setState({
      sessions: [sess('/a'), sess('/b'), sess('/c')],
      activeId: '/b',
    });
    useTerminalStore.getState().replaceSnapshot([sess('/a'), sess('/b'), sess('/c')]);
    expect(useTerminalStore.getState().activeId).toBe('/b');
  });

  it('旧 active mid 被移除 → 切下一个', () => {
    useTerminalStore.setState({
      sessions: [sess('/a'), sess('/b'), sess('/c')],
      activeId: '/b',
    });
    useTerminalStore.getState().replaceSnapshot([sess('/a'), sess('/c')]);
    const s = useTerminalStore.getState();
    expect(s.sessions.map((x) => x.id)).toEqual(['/a', '/c']);
    expect(s.activeId).toBe('/c');
  });

  it('旧 active 是 tail 被移除 → 切前一个', () => {
    useTerminalStore.setState({
      sessions: [sess('/a'), sess('/b'), sess('/c')],
      activeId: '/c',
    });
    useTerminalStore.getState().replaceSnapshot([sess('/a'), sess('/b')]);
    const s = useTerminalStore.getState();
    expect(s.activeId).toBe('/b');
  });

  it('旧 active 是 head 被移除 → 切下一个', () => {
    useTerminalStore.setState({
      sessions: [sess('/a'), sess('/b'), sess('/c')],
      activeId: '/a',
    });
    useTerminalStore.getState().replaceSnapshot([sess('/b'), sess('/c')]);
    expect(useTerminalStore.getState().activeId).toBe('/b');
  });

  it('所有 sessions 被移除 → activeId null', () => {
    useTerminalStore.setState({
      sessions: [sess('/a'), sess('/b')],
      activeId: '/a',
    });
    useTerminalStore.getState().replaceSnapshot([]);
    const s = useTerminalStore.getState();
    expect(s.sessions).toEqual([]);
    expect(s.activeId).toBeNull();
  });

  it('新增 session → activeId 不变', () => {
    useTerminalStore.setState({
      sessions: [sess('/a')],
      activeId: '/a',
    });
    useTerminalStore.getState().replaceSnapshot([sess('/a'), sess('/b')]);
    const s = useTerminalStore.getState();
    expect(s.sessions.map((x) => x.id)).toEqual(['/a', '/b']);
    expect(s.activeId).toBe('/a');
  });

  it('仅 exitCode 字段变化 → activeId 不变,session 对象更新', () => {
    useTerminalStore.setState({
      sessions: [sess('/a'), sess('/b')],
      activeId: '/b',
    });
    useTerminalStore
      .getState()
      .replaceSnapshot([sess('/a'), sess('/b', { exitCode: 0 })]);
    const s = useTerminalStore.getState();
    expect(s.activeId).toBe('/b');
    expect(s.sessions[1]!.exitCode).toBe(0);
  });

  it('多个 session 同时被移除 → 仍按 oldSessions 顺序找下一个', () => {
    useTerminalStore.setState({
      sessions: [sess('/a'), sess('/b'), sess('/c'), sess('/d')],
      activeId: '/b',
    });
    // /b /c 同时移除 → 应切到 /d(b 被关后切 c,c 被关后切 d)
    useTerminalStore.getState().replaceSnapshot([sess('/a'), sess('/d')]);
    expect(useTerminalStore.getState().activeId).toBe('/d');
  });

  it('main 改变 sessions 顺序 → 用 main 给的顺序', () => {
    useTerminalStore.setState({
      sessions: [sess('/a'), sess('/b')],
      activeId: '/a',
    });
    useTerminalStore.getState().replaceSnapshot([sess('/b'), sess('/a')]);
    const s = useTerminalStore.getState();
    expect(s.sessions.map((x) => x.id)).toEqual(['/b', '/a']);
    // active 不变(仍存在)
    expect(s.activeId).toBe('/a');
  });
});

// ────────────────────────────────────────────────────────────
// setActive
// ────────────────────────────────────────────────────────────

describe('setActive', () => {
  it('改 activeId', () => {
    useTerminalStore.setState({
      sessions: [makeSession({ id: '/a' }), makeSession({ id: '/b' })],
      activeId: '/a',
    });
    useTerminalStore.getState().setActive('/b');
    expect(useTerminalStore.getState().activeId).toBe('/b');
  });

  it('id 不在 sessions 也接受(允许 race:create 后立即 setActive)', () => {
    useTerminalStore.setState({
      sessions: [makeSession({ id: '/a' })],
      activeId: '/a',
    });
    useTerminalStore.getState().setActive('/pending');
    expect(useTerminalStore.getState().activeId).toBe('/pending');
  });
});

// ────────────────────────────────────────────────────────────
// renameSession + customTitles(issue #19)
//   用户可在 UI 双击 tab 改显示名,override 存在 store 不破坏 main 真相源。
//   session 关闭(snapshot 移除该 id)后,override 自动清理避免泄漏。
// ────────────────────────────────────────────────────────────

describe('renameSession', () => {
  it('初态 customTitles 空', () => {
    expect(useTerminalStore.getState().customTitles.size).toBe(0);
  });

  it('renameSession(id, title) → customTitles.get(id) === title', () => {
    useTerminalStore.setState({
      sessions: [makeSession({ id: '/a' })],
      activeId: '/a',
      customTitles: new Map(),
    });
    useTerminalStore.getState().renameSession('/a', '调试 prompt');
    expect(useTerminalStore.getState().customTitles.get('/a')).toBe(
      '调试 prompt',
    );
  });

  it('renameSession(id, "") → 删除该 id 的 override(回退默认 title)', () => {
    useTerminalStore.setState({
      sessions: [makeSession({ id: '/a' })],
      activeId: '/a',
      customTitles: new Map([['/a', 'X']]),
    });
    useTerminalStore.getState().renameSession('/a', '');
    expect(useTerminalStore.getState().customTitles.has('/a')).toBe(false);
  });

  it('renameSession(id, "  ") → 视同空,删除', () => {
    useTerminalStore.setState({
      sessions: [makeSession({ id: '/a' })],
      activeId: '/a',
      customTitles: new Map([['/a', 'X']]),
    });
    useTerminalStore.getState().renameSession('/a', '   ');
    expect(useTerminalStore.getState().customTitles.has('/a')).toBe(false);
  });

  // 边界(E238):renameSession 是 renderer-only store 入口,不经主进程 terminal-create schema 的
  // LABEL_MAX(512)校验。极长自定义标题须截断,否则进 customTitles 被 Dock tab 反复渲染绕过主进程边界。
  it('E238 renameSession 超 LABEL_MAX(512)的标题 → 截断到 512 写入', () => {
    useTerminalStore.setState({
      sessions: [makeSession({ id: '/a' })],
      activeId: '/a',
      customTitles: new Map(),
    });
    const long = 'x'.repeat(5000);
    useTerminalStore.getState().renameSession('/a', long);
    const stored = useTerminalStore.getState().customTitles.get('/a');
    expect(stored).toBeDefined();
    expect(stored!.length).toBe(512); // 截断到 LABEL_MAX,不是 5000
  });

  it('E238 前后空白 + 超长 → 先 trim 再截断到 512', () => {
    useTerminalStore.setState({
      sessions: [makeSession({ id: '/a' })],
      activeId: '/a',
      customTitles: new Map(),
    });
    useTerminalStore.getState().renameSession('/a', `   ${'y'.repeat(5000)}   `);
    expect(useTerminalStore.getState().customTitles.get('/a')!.length).toBe(512);
  });

  it('replaceSnapshot 移除已不存在 id 的 customTitle(防泄漏)', () => {
    useTerminalStore.setState({
      sessions: [makeSession({ id: '/a' }), makeSession({ id: '/b' })],
      activeId: '/a',
      customTitles: new Map([
        ['/a', 'A custom'],
        ['/b', 'B custom'],
      ]),
    });
    // /b 被关闭,新 snapshot 只剩 /a
    useTerminalStore.getState().replaceSnapshot([makeSession({ id: '/a' })]);
    const titles = useTerminalStore.getState().customTitles;
    expect(titles.has('/a')).toBe(true);
    expect(titles.has('/b')).toBe(false);
  });
});
