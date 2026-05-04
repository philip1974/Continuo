import { describe, it, expect, beforeEach } from 'vitest';
import {
  nextActiveAfterClose,
  useTerminalStore,
  type TerminalSession,
} from '../../stores/terminal.store';

const makeSession = (overrides: Partial<TerminalSession> = {}): TerminalSession => ({
  id: '/t/1',
  title: 'Terminal 1',
  createdAt: 0,
  exitCode: null,
  ...overrides,
});

beforeEach(() => {
  useTerminalStore.setState({ sessions: [], activeId: null });
});

// ────────────────────────────────────────────────────────────
// nextActiveAfterClose 纯函数
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

// ────────────────────────────────────────────────────────────
// addSession
// ────────────────────────────────────────────────────────────

describe('addSession', () => {
  it('推入 + 自动切活跃', () => {
    useTerminalStore.getState().addSession({ id: '/a', title: 'A' });
    const s = useTerminalStore.getState();
    expect(s.sessions).toHaveLength(1);
    expect(s.sessions[0]).toMatchObject({ id: '/a', title: 'A', exitCode: null });
    expect(s.activeId).toBe('/a');
  });

  it('多次 add → 顺序追加,active 跟最后', () => {
    const add = useTerminalStore.getState().addSession;
    add({ id: '/a', title: 'A' });
    add({ id: '/b', title: 'B' });
    const s = useTerminalStore.getState();
    expect(s.sessions.map((x) => x.id)).toEqual(['/a', '/b']);
    expect(s.activeId).toBe('/b');
  });

  it('createdAt 自动赋值(单调递增)', () => {
    useTerminalStore.getState().addSession({ id: '/a', title: 'A' });
    useTerminalStore.getState().addSession({ id: '/b', title: 'B' });
    const s = useTerminalStore.getState();
    expect(s.sessions[0]!.createdAt).toBeLessThanOrEqual(s.sessions[1]!.createdAt);
  });
});

// ────────────────────────────────────────────────────────────
// removeSession / switchSession / setExited
// ────────────────────────────────────────────────────────────

describe('removeSession', () => {
  it('委托 nextActiveAfterClose:关活跃中间 → 切下一个', () => {
    useTerminalStore.setState({
      sessions: [makeSession({ id: '/a' }), makeSession({ id: '/b' }), makeSession({ id: '/c' })],
      activeId: '/b',
    });
    useTerminalStore.getState().removeSession('/b');
    const s = useTerminalStore.getState();
    expect(s.sessions.map((x) => x.id)).toEqual(['/a', '/c']);
    expect(s.activeId).toBe('/c');
  });

  it('关不存在 id → 不变', () => {
    useTerminalStore.setState({
      sessions: [makeSession({ id: '/a' })],
      activeId: '/a',
    });
    useTerminalStore.getState().removeSession('/zombie');
    expect(useTerminalStore.getState().sessions).toHaveLength(1);
  });
});

describe('switchSession', () => {
  it('只改 activeId', () => {
    useTerminalStore.setState({
      sessions: [makeSession({ id: '/a' }), makeSession({ id: '/b' })],
      activeId: '/a',
    });
    useTerminalStore.getState().switchSession('/b');
    expect(useTerminalStore.getState().activeId).toBe('/b');
  });
});

describe('setExited', () => {
  it('exitCode 写入对应 session', () => {
    useTerminalStore.setState({
      sessions: [makeSession({ id: '/a' })],
      activeId: '/a',
    });
    useTerminalStore.getState().setExited('/a', 0);
    expect(useTerminalStore.getState().sessions[0]?.exitCode).toBe(0);
  });

  it('id 不存在 → 不抛', () => {
    expect(() =>
      useTerminalStore.getState().setExited('/nope', 1),
    ).not.toThrow();
  });
});

describe('clearAll', () => {
  it('全清', () => {
    useTerminalStore.setState({
      sessions: [makeSession({ id: '/a' }), makeSession({ id: '/b' })],
      activeId: '/a',
    });
    useTerminalStore.getState().clearAll();
    const s = useTerminalStore.getState();
    expect(s.sessions).toEqual([]);
    expect(s.activeId).toBeNull();
  });
});
