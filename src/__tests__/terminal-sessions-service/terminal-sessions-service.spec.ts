// BDD: terminal-sessions-service
// main 端 session metadata 真相源。每个 test 用 _reset 隔离。

import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as terminalSessions from '../../../electron/main/services/terminal-sessions.service';
import {
  add,
  get,
  getAll,
  remove,
  removeByOwner,
  setExited,
  updateCwd,
  nextDefaultTitle,
  subscribe,
  _reset,
  MAX_TERMINAL_SESSIONS_GLOBAL_FOR_TEST,
  MAX_TERMINAL_SESSIONS_PER_WINDOW_FOR_TEST,
  type MainTerminalSession,
} from '../../../electron/main/services/terminal-sessions.service';
import { ERROR_CODES } from '../../../electron/shared/error-codes';

beforeEach(() => {
  _reset();
});

const userInput = (id = 'term-1', overrides: Partial<MainTerminalSession> = {}) => ({
  id,
  title: 'Terminal 1',
  cwd: '/work',
  originHint: 'user' as const,
  ownerWindowId: 11,
  ...overrides,
});

const agentInput = (id = 'term-2') => ({
  id,
  title: 'Terminal 2',
  cwd: '/work',
  originHint: 'agent' as const,
  agentLabel: 'codex',
  ownerWindowId: 11,
});

// ────────────────────────────────────────────────────────────
// add
// ────────────────────────────────────────────────────────────

describe('add', () => {
  it('入 Map + 自动填 createdAt / exitCode:null + ownerWindowId 透传', () => {
    const before = Date.now();
    add(userInput());
    const after = Date.now();
    const s = get('term-1')!;
    expect(s).toBeDefined();
    expect(s.id).toBe('term-1');
    expect(s.title).toBe('Terminal 1');
    expect(s.cwd).toBe('/work');
    expect(s.originHint).toBe('user');
    expect(s.ownerWindowId).toBe(11);
    expect(s.exitCode).toBeNull();
    expect(s.createdAt).toBeGreaterThanOrEqual(before);
    expect(s.createdAt).toBeLessThanOrEqual(after);
  });

  it('agent session 带 agentLabel', () => {
    add(agentInput());
    const s = get('term-2')!;
    expect(s.originHint).toBe('agent');
    expect(s.agentLabel).toBe('codex');
  });

  it('user session 不带 agentLabel(字段不存在)', () => {
    add(userInput());
    const s = get('term-1')!;
    expect(s.agentLabel).toBeUndefined();
  });

  it('workspaceRoot 透传(folder isolation:renderer 据此过滤跨 workspace 可见性)', () => {
    add(userInput('term-w', { workspaceRoot: '/Users/me/proj-a' }));
    const s = get('term-w')!;
    expect(s.workspaceRoot).toBe('/Users/me/proj-a');
  });

  it('未传 workspaceRoot → 字段不存在(全局会话,所有 workspace 都可见)', () => {
    add(userInput());
    const s = get('term-1')!;
    expect('workspaceRoot' in s).toBe(false);
  });

  it('重复 id → 抛 TERMINAL_SESSION_DUPLICATE', () => {
    add(userInput('term-1'));
    expect(() => add(userInput('term-1'))).toThrowError(/duplicate/i);
  });

  it('触发 subscribers', () => {
    const fn = vi.fn();
    subscribe(fn);
    add(userInput());
    expect(fn).toHaveBeenCalledTimes(1);
    const snapshot = fn.mock.calls[0]![0] as readonly MainTerminalSession[];
    expect(snapshot).toHaveLength(1);
    expect(snapshot[0]!.id).toBe('term-1');
  });
});

// ────────────────────────────────────────────────────────────
// get / getAll
// ────────────────────────────────────────────────────────────

describe('get', () => {
  it('不存在 → undefined', () => {
    expect(get('nope')).toBeUndefined();
  });

  it('存在 → 同一引用', () => {
    add(userInput());
    const a = get('term-1');
    const b = get('term-1');
    expect(a).toBe(b);
  });
});

describe('getAll', () => {
  it('空 → []', () => {
    expect(getAll()).toEqual([]);
  });

  it('按 add 顺序返回', () => {
    add(userInput('term-A'));
    add(userInput('term-B'));
    add(userInput('term-C'));
    expect(getAll().map((s) => s.id)).toEqual(['term-A', 'term-B', 'term-C']);
  });

  it('filter { ownerWindowId } → 只返该 owner,保持 add 顺序', () => {
    add(userInput('a', { ownerWindowId: 11 }));
    add(userInput('b', { ownerWindowId: 22 }));
    add(userInput('c', { ownerWindowId: 11 }));
    add(userInput('d', { ownerWindowId: 22 }));
    expect(getAll({ ownerWindowId: 11 }).map((s) => s.id)).toEqual(['a', 'c']);
    expect(getAll({ ownerWindowId: 22 }).map((s) => s.id)).toEqual(['b', 'd']);
  });

  it('filter 无匹配 → []', () => {
    add(userInput('a', { ownerWindowId: 11 }));
    expect(getAll({ ownerWindowId: 99 })).toEqual([]);
  });
});

// ────────────────────────────────────────────────────────────
// removeByOwner (Issue #28 Phase 1)
// ────────────────────────────────────────────────────────────

describe('removeByOwner', () => {
  it('摘所有匹配 owner 的 sessions,返回 id 列表', () => {
    add(userInput('a', { ownerWindowId: 11 }));
    add(userInput('b', { ownerWindowId: 22 }));
    add(userInput('c', { ownerWindowId: 11 }));
    const removed = removeByOwner(11);
    expect([...removed].sort()).toEqual(['a', 'c']);
    expect(getAll().map((s) => s.id)).toEqual(['b']);
  });

  it('无匹配 → 返回 [],不触发 subscribers', () => {
    add(userInput('a', { ownerWindowId: 11 }));
    const fn = vi.fn();
    subscribe(fn);
    expect(removeByOwner(99)).toEqual([]);
    expect(fn).not.toHaveBeenCalled();
  });

  it('有匹配 → 触发 subscribers 一次,推剩余全量快照', () => {
    add(userInput('a', { ownerWindowId: 11 }));
    add(userInput('b', { ownerWindowId: 22 }));
    const fn = vi.fn();
    subscribe(fn);
    removeByOwner(11);
    expect(fn).toHaveBeenCalledTimes(1);
    const snap = fn.mock.calls[0]![0] as readonly MainTerminalSession[];
    expect(snap.map((s) => s.id)).toEqual(['b']);
  });
});

// ────────────────────────────────────────────────────────────
// remove
// ────────────────────────────────────────────────────────────

describe('remove', () => {
  it('存在 → 删 + 触发', () => {
    add(userInput());
    const fn = vi.fn();
    subscribe(fn);
    remove('term-1');
    expect(get('term-1')).toBeUndefined();
    expect(fn).toHaveBeenCalledTimes(1);
    expect(fn.mock.calls[0]![0]).toEqual([]);
  });

  it('不存在的 id → 不触发,不抛', () => {
    const fn = vi.fn();
    subscribe(fn);
    expect(() => remove('nope')).not.toThrow();
    expect(fn).not.toHaveBeenCalled();
  });
});

// ────────────────────────────────────────────────────────────
// setExited
// ────────────────────────────────────────────────────────────

describe('setExited', () => {
  it('存在 → 替换对象 + 触发', () => {
    add(userInput());
    const oldRef = get('term-1');
    const fn = vi.fn();
    subscribe(fn);
    setExited('term-1', 0);
    const newRef = get('term-1');
    expect(newRef).not.toBe(oldRef);
    expect(newRef!.exitCode).toBe(0);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('保留其它字段', () => {
    add(agentInput('term-X'));
    setExited('term-X', 137);
    const s = get('term-X')!;
    expect(s).toMatchObject({
      id: 'term-X',
      title: 'Terminal 2',
      cwd: '/work',
      originHint: 'agent',
      agentLabel: 'codex',
      exitCode: 137,
    });
  });

  it('不存在 id → 不触发,不抛', () => {
    const fn = vi.fn();
    subscribe(fn);
    expect(() => setExited('nope', 0)).not.toThrow();
    expect(fn).not.toHaveBeenCalled();
  });

  it('重复 setExited 同 id → 仍触发(不去重)', () => {
    add(userInput());
    const fn = vi.fn();
    subscribe(fn);
    setExited('term-1', 0);
    setExited('term-1', 0);
    expect(fn).toHaveBeenCalledTimes(2);
  });
});

// ────────────────────────────────────────────────────────────
// INV-2 ownerWindowId immutability
// ────────────────────────────────────────────────────────────

describe('INV-2 ownerWindowId immutability', () => {
  it('add() 入参 ownerWindowId 非 finite/integer/非负 → throw', () => {
    for (const ownerWindowId of [NaN, Infinity, -1, 1.5, '11', undefined]) {
      expect(() =>
        add({
          ...userInput(`bad-${String(ownerWindowId)}`),
          ownerWindowId,
        } as never),
      ).toThrowError(/invalid ownerWindowId/);
    }
  });

  it('updateCwd(id, newCwd) 后 ownerWindowId 不变', () => {
    add(userInput('term-cwd', { ownerWindowId: 22 }));
    updateCwd('term-cwd', '/next');
    expect(get('term-cwd')).toMatchObject({
      cwd: '/next',
      ownerWindowId: 22,
    });
  });

  it('setExited(id, exitCode) 后 ownerWindowId 不变', () => {
    add(userInput('term-exit', { ownerWindowId: 33 }));
    setExited('term-exit', 0);
    expect(get('term-exit')).toMatchObject({
      exitCode: 0,
      ownerWindowId: 33,
    });
  });

  it('service module export 中没有 updateOwner / setOwner / transferOwnership 类 API', () => {
    for (const name of Object.keys(terminalSessions)) {
      expect(name).not.toMatch(/updateOwner|setOwner|transferOwnership/i);
    }
  });
});

// ────────────────────────────────────────────────────────────
// nextDefaultTitle
// ────────────────────────────────────────────────────────────

describe('nextDefaultTitle', () => {
  it('单调递增,从 1 开始', () => {
    expect(nextDefaultTitle(1)).toBe('Terminal 1');
    expect(nextDefaultTitle(1)).toBe('Terminal 2');
    expect(nextDefaultTitle(1)).toBe('Terminal 3');
  });

  it('remove 中间一个不重用编号(修复撞号 bug)', () => {
    const t1 = nextDefaultTitle(1); // 1
    add({ ...userInput('a'), title: t1 });
    const t2 = nextDefaultTitle(1); // 2
    add({ ...userInput('b'), title: t2 });
    remove('a');
    const t3 = nextDefaultTitle(1); // 3,不是 2
    expect(t3).toBe('Terminal 3');
  });

  it('本身不改 sessions Map', () => {
    nextDefaultTitle(1);
    nextDefaultTitle(1);
    expect(getAll()).toEqual([]);
  });

  it('_reset 后回到 1', () => {
    nextDefaultTitle(1);
    nextDefaultTitle(1);
    _reset();
    expect(nextDefaultTitle(1)).toBe('Terminal 1');
  });
});

// ────────────────────────────────────────────────────────────
// subscribe
// ────────────────────────────────────────────────────────────

describe('subscribe', () => {
  it('subscribe 时不立刻 invoke', () => {
    const fn = vi.fn();
    subscribe(fn);
    expect(fn).not.toHaveBeenCalled();
  });

  it('多个 subscriber 都被调', () => {
    const a = vi.fn();
    const b = vi.fn();
    subscribe(a);
    subscribe(b);
    add(userInput());
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);
  });

  it('unsubscribe 后该 fn 不再被调', () => {
    const fn = vi.fn();
    const off = subscribe(fn);
    off();
    add(userInput());
    expect(fn).not.toHaveBeenCalled();
  });

  it('一个 subscriber 抛错不影响其它', () => {
    const bad = vi.fn(() => {
      throw new Error('boom');
    });
    const good = vi.fn();
    subscribe(bad);
    subscribe(good);
    expect(() => add(userInput())).not.toThrow();
    expect(good).toHaveBeenCalledTimes(1);
  });

  it('subscriber 收到的是同步当前快照', () => {
    let received: readonly MainTerminalSession[] | null = null;
    subscribe((snap) => {
      received = snap;
    });
    add(userInput('term-1'));
    add(userInput('term-2', { title: 'Terminal 2' }));
    expect(received).not.toBeNull();
    expect(received!.map((s) => s.id)).toEqual(['term-1', 'term-2']);
  });
});

// ────────────────────────────────────────────────────────────
// _reset
// ────────────────────────────────────────────────────────────

// 边界(E235,E230 数量上限族):会话(真实 PTY)全局 + 每窗口数量上限。
describe('E235 会话数量上限', () => {
  function input(id: string, ownerWindowId: number) {
    return {
      id,
      title: id,
      cwd: '/work',
      originHint: 'agent' as const,
      ownerWindowId,
    };
  }

  it('单窗口到 per-window 上限后,再 add 抛 TOO_MANY_TERMINALS,不入 sessions', () => {
    const max = MAX_TERMINAL_SESSIONS_PER_WINDOW_FOR_TEST;
    for (let i = 0; i < max; i++) add(input(`w1-${i}`, 1));
    expect(getAll({ ownerWindowId: 1 })).toHaveLength(max);
    const err = (() => {
      try {
        add(input('overflow', 1));
        return null;
      } catch (e) {
        return e;
      }
    })();
    expect((err as { code?: string }).code).toBe(ERROR_CODES.TOO_MANY_TERMINALS);
    expect(getAll({ ownerWindowId: 1 })).toHaveLength(max); // 没增
  });

  it('remove 释放槽位后可再 add(计数随 Map 增删,含 exited-retained)', () => {
    const max = MAX_TERMINAL_SESSIONS_PER_WINDOW_FOR_TEST;
    for (let i = 0; i < max; i++) add(input(`w1-${i}`, 1));
    // setExited 不释放(exited-retained 仍在 Map 计数)→ 仍溢出
    setExited('w1-0', 0);
    expect(() => add(input('still-full', 1))).toThrow();
    // remove 才释放
    remove('w1-0');
    expect(() => add(input('revived', 1))).not.toThrow();
    expect(getAll({ ownerWindowId: 1 })).toHaveLength(max);
  });

  it('per-window 隔离:窗口 1 满,窗口 2 仍可 add', () => {
    const max = MAX_TERMINAL_SESSIONS_PER_WINDOW_FOR_TEST;
    for (let i = 0; i < max; i++) add(input(`w1-${i}`, 1));
    expect(() => add(input('w1-of', 1))).toThrow();
    expect(() => add(input('w2-0', 2))).not.toThrow();
  });

  it('全局上限:跨多窗累计到全局上限后,新窗口 add 也被全局闸拒', () => {
    const perWin = MAX_TERMINAL_SESSIONS_PER_WINDOW_FOR_TEST;
    const global = MAX_TERMINAL_SESSIONS_GLOBAL_FOR_TEST;
    let filled = 0;
    let win = 100;
    while (filled < global) {
      const room = Math.min(perWin, global - filled);
      for (let i = 0; i < room; i++) add(input(`g-${filled + i}`, win));
      filled += room;
      win += 1;
    }
    expect(getAll()).toHaveLength(global);
    const err = (() => {
      try {
        add(input('fresh', 999999));
        return null;
      } catch (e) {
        return e;
      }
    })();
    expect((err as { code?: string }).code).toBe(ERROR_CODES.TOO_MANY_TERMINALS);
    expect(getAll()).toHaveLength(global); // 没增
  });
});

describe('_reset', () => {
  it('清 sessions + counter + subscribers', () => {
    const fn = vi.fn();
    subscribe(fn);
    add(userInput());
    nextDefaultTitle(1);
    _reset();
    expect(getAll()).toEqual([]);
    expect(nextDefaultTitle(1)).toBe('Terminal 1');
    add(userInput('term-after'));
    // _reset 前的 fn 不应再被调
    expect(fn).toHaveBeenCalledTimes(1); // 只第一次 add 时
  });
});
