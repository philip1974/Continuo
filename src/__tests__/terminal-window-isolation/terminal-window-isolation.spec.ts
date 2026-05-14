// BDD: terminal-window-isolation (Issue #28 Phase 1)
// 跨 sessionStore + IPC handler 的窗口隔离 invariant + 关闭清理 helper。
//
// 此 spec 在实装前会 red(makeWindowClosedCleanup 不存在 / sessionStore.add 不接
// ownerWindowId / getAll 不支持 filter)。实装目标:
//   - electron/main/services/terminal-sessions.service.ts:
//       AddSessionInput 增 ownerWindowId 必填;getAll(filter?) 支持 owner 过滤;
//       新增 removeByOwner(ownerWindowId): readonly string[]
//   - electron/main/ipc/terminal.ipc.ts:
//       makeCreateHandler 已收 win,sessionStore.add 时附 ownerWindowId: win.id
//       makeListSessionsHandler 改签名 (input: { ownerWindowId: number })
//       export makeWindowClosedCleanup({ service, sessionStore })

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  _reset,
  add,
  getAll,
  removeByOwner,
  subscribe,
} from '../../../electron/main/services/terminal-sessions.service';
import {
  makeCreateHandler,
  makeListSessionsHandler,
  makeWindowClosedCleanup,
} from '../../../electron/main/ipc/terminal.ipc';
import type { BrowserWindow } from 'electron';

beforeEach(() => {
  _reset();
});

// ─── fakes ──────────────────────────────────────────────────

function fakeWin(id: number): BrowserWindow {
  return { id } as unknown as BrowserWindow;
}

function makeService() {
  const created: Array<{ id: string; winId: number }> = [];
  const killed: string[] = [];
  const alive = new Set<string>();
  return {
    created,
    killed,
    createTerminal: vi.fn(
      (id: string, win: BrowserWindow, _shell: string, _args: string[], _cwd: string) => {
        created.push({ id, winId: win.id });
        alive.add(id);
      },
    ),
    has: vi.fn((id: string) => alive.has(id)),
    write: vi.fn(),
    resize: vi.fn(),
    interrupt: vi.fn(),
    kill: vi.fn((id: string) => {
      killed.push(id);
      alive.delete(id);
    }),
    cleanupAll: vi.fn(),
    safeTruncate: vi.fn(),
    isInPlaceUpdate: vi.fn(),
  };
}

// 用真 terminalSessions service(BDD 集成层断言)。
// 用 fake termService 避免真 spawn pty。

function makeCreate(service: ReturnType<typeof makeService>, idSeq: () => string) {
  return makeCreateHandler({
    service: service as never,
    generateId: idSeq,
    resolveCwd: (c) => c ?? '/work',
  });
}

// ────────────────────────────────────────────────────────────
// create 写入 ownerWindowId = win.id
// ────────────────────────────────────────────────────────────

describe('create 写入 sender owner', () => {
  it('windowA(id=11)创建 → session.ownerWindowId === 11', async () => {
    const service = makeService();
    const create = makeCreate(service, () => 'term-a');
    await create({}, fakeWin(11));
    const all = getAll();
    expect(all).toHaveLength(1);
    expect(all[0]!.ownerWindowId).toBe(11);
  });

  it('两个 window 分别创建 → 各自 owner 正确', async () => {
    const service = makeService();
    let seq = 0;
    const create = makeCreate(service, () => `term-${++seq}`);
    await create({}, fakeWin(11));
    await create({}, fakeWin(22));
    await create({}, fakeWin(11));
    const byOwner = new Map<number, number>();
    for (const s of getAll()) {
      byOwner.set(s.ownerWindowId, (byOwner.get(s.ownerWindowId) ?? 0) + 1);
    }
    expect(byOwner.get(11)).toBe(2);
    expect(byOwner.get(22)).toBe(1);
  });
});

// ────────────────────────────────────────────────────────────
// list_sessions 按 sender owner 过滤
// ────────────────────────────────────────────────────────────

describe('list_sessions 按 owner 过滤', () => {
  it('windowB 创建后,windowA list 看不到 windowB 的 session', async () => {
    const service = makeService();
    let seq = 0;
    const create = makeCreate(service, () => `term-${++seq}`);
    const list = makeListSessionsHandler();

    await create({}, fakeWin(11)); // A 的
    await create({}, fakeWin(22)); // B 的
    await create({}, fakeWin(22)); // B 的

    const aList = list({ ownerWindowId: 11 });
    const bList = list({ ownerWindowId: 22 });

    expect(aList.sessions).toHaveLength(1);
    expect(aList.sessions[0]!.ownerWindowId).toBe(11);
    expect(bList.sessions).toHaveLength(2);
    for (const s of bList.sessions) expect(s.ownerWindowId).toBe(22);
  });

  it('无 session 的 window list → 空数组', async () => {
    const service = makeService();
    const create = makeCreate(service, () => 'only-one');
    const list = makeListSessionsHandler();
    await create({}, fakeWin(11));
    expect(list({ ownerWindowId: 99 }).sessions).toEqual([]);
  });

  // agent session 与 user session 同等严格 per-owner — 不开"agent 广播全 window"
  // 后门(曾在 topic-05 86c1799 引入,因为它让 listSessions/broadcast 语义错配
  // 且让 sessions 跨 window 漏出。坚持 ownerWindowId 是唯一可见域)。
  it('agent session 仍按 owner 严格过滤(无 originHint loophole)', () => {
    add({
      id: 'agent-a',
      title: 'A',
      cwd: '/',
      originHint: 'agent',
      ownerWindowId: 11,
    });
    add({
      id: 'user-b',
      title: 'B',
      cwd: '/',
      originHint: 'user',
      ownerWindowId: 22,
    });
    const list = makeListSessionsHandler();
    expect(list({ ownerWindowId: 11 }).sessions.map((s) => s.id)).toEqual([
      'agent-a',
    ]);
    expect(list({ ownerWindowId: 22 }).sessions.map((s) => s.id)).toEqual([
      'user-b',
    ]);
    // windowC 没创建过任何 session → 既看不到自己的(没有),也看不到 agent 的
    expect(list({ ownerWindowId: 33 }).sessions).toEqual([]);
  });
});

// ────────────────────────────────────────────────────────────
// removeByOwner:摘所有 owner sessions
// ────────────────────────────────────────────────────────────

describe('removeByOwner', () => {
  it('返回被摘掉的 id 列表', () => {
    add({ id: 'a', title: 'A', cwd: '/', originHint: 'user', ownerWindowId: 11 });
    add({ id: 'b', title: 'B', cwd: '/', originHint: 'user', ownerWindowId: 22 });
    add({ id: 'c', title: 'C', cwd: '/', originHint: 'user', ownerWindowId: 11 });
    const removed = removeByOwner(11);
    expect([...removed].sort()).toEqual(['a', 'c']);
    expect(getAll().map((s) => s.id)).toEqual(['b']);
  });

  it('无匹配 → 返回空数组,不触发 subscriber', () => {
    const fn = vi.fn();
    subscribe(fn);
    add({ id: 'a', title: 'A', cwd: '/', originHint: 'user', ownerWindowId: 11 });
    fn.mockClear();
    const removed = removeByOwner(99);
    expect(removed).toEqual([]);
    expect(fn).not.toHaveBeenCalled();
  });

  it('有匹配 → 触发 subscriber 一次,推剩余全量快照', () => {
    add({ id: 'a', title: 'A', cwd: '/', originHint: 'user', ownerWindowId: 11 });
    add({ id: 'b', title: 'B', cwd: '/', originHint: 'user', ownerWindowId: 22 });
    const fn = vi.fn();
    subscribe(fn);
    removeByOwner(11);
    expect(fn).toHaveBeenCalledTimes(1);
    const snap = fn.mock.calls[0]![0] as { id: string }[];
    expect(snap.map((s) => s.id)).toEqual(['b']);
  });
});

// ────────────────────────────────────────────────────────────
// makeWindowClosedCleanup:摘 metadata + kill PTY
// ────────────────────────────────────────────────────────────

describe('makeWindowClosedCleanup', () => {
  it('摘所有 owner sessions 并 kill 对应 PTY', async () => {
    const service = makeService();
    let seq = 0;
    const create = makeCreate(service, () => `term-${++seq}`);
    await create({}, fakeWin(11)); // term-1
    await create({}, fakeWin(22)); // term-2
    await create({}, fakeWin(11)); // term-3

    const cleanup = makeWindowClosedCleanup({ service: service as never });
    cleanup(11);

    expect(service.killed.sort()).toEqual(['term-1', 'term-3']);
    expect(getAll().map((s) => s.id)).toEqual(['term-2']);
  });

  it('owner 没有 session → noop(不 kill,不抛)', () => {
    const service = makeService();
    const cleanup = makeWindowClosedCleanup({ service: service as never });
    expect(() => cleanup(99)).not.toThrow();
    expect(service.killed).toEqual([]);
  });

  it('PTY 已自然 exit(service.has=false)→ 不重复调 kill', () => {
    const service = makeService();
    const cleanup = makeWindowClosedCleanup({ service: service as never });
    // 直接构造 metadata 但 service 中无 PTY(模拟已 exit)
    add({ id: 'ghost', title: 'G', cwd: '/', originHint: 'user', ownerWindowId: 11 });
    cleanup(11);
    expect(service.killed).toEqual([]);
    expect(getAll()).toEqual([]); // metadata 仍被摘
  });
});

// ────────────────────────────────────────────────────────────
// 集成隔离场景(端到端 invariant)
// ────────────────────────────────────────────────────────────

describe('集成场景:两个 window 并发 + 关闭清理', () => {
  it('两 window 并发创建 + 一个关闭 → 另一个不受影响', async () => {
    const service = makeService();
    let seq = 0;
    const create = makeCreate(service, () => `term-${++seq}`);
    const list = makeListSessionsHandler();
    const cleanup = makeWindowClosedCleanup({ service: service as never });

    await create({}, fakeWin(11)); // A:term-1
    await create({}, fakeWin(22)); // B:term-2
    await create({}, fakeWin(22)); // B:term-3

    expect(list({ ownerWindowId: 11 }).sessions.map((s) => s.id)).toEqual(['term-1']);
    expect(list({ ownerWindowId: 22 }).sessions.map((s) => s.id)).toEqual([
      'term-2',
      'term-3',
    ]);

    // windowA 关闭
    cleanup(11);

    expect(service.killed).toEqual(['term-1']);
    expect(list({ ownerWindowId: 11 }).sessions).toEqual([]);
    expect(list({ ownerWindowId: 22 }).sessions.map((s) => s.id)).toEqual([
      'term-2',
      'term-3',
    ]);

    // windowB 关闭
    cleanup(22);
    expect(service.killed.sort()).toEqual(['term-1', 'term-2', 'term-3']);
    expect(getAll()).toEqual([]);
  });
});
