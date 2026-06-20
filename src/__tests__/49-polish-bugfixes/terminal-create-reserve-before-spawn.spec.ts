// topic 49 第十二 session · codex 复审 loop R19:terminal:create 必须先登记 session 再 spawn PTY,否则极速退出丢 exit 终态。
//
// 根因:makeCreateHandler 旧实现在 `await service.createTerminal(...)` 完成后才 sessionStore.add()。
// 但 PTY 可能在 createTerminal 的 await 期间就退出(`sh -c 'exit 0'` / 启动即失败),其 onExit →
// cleanupSessionLocal → setExited(id) 此刻 sessions map 还没有该 id → setExited no-op(if !cur
// return)→ exit 终态丢失 → 随后 add 注册一个 exitCode:null 的假 live session(stale panel
// 「活着但已死」,write/resize 走 not-found)。
//
// 修:先 add(reservation,exitCode:null)再 await createTerminal;create 失败 remove(id) 回滚。
// 这样 setExited 无论 PTY 在 spawn 前后退出都能命中已存在的 metadata。

import { describe, it, expect, vi } from 'vitest';
import type { BrowserWindow } from 'electron';
import { makeCreateHandler } from '../../../electron/main/ipc/terminal.ipc';

const fakeWin = { id: 11 } as unknown as BrowserWindow;

// 有状态的假 sessionStore,镜像真实 terminal-sessions.service:setExited 在 id 不存在时 no-op。
function makeStatefulStore() {
  const map = new Map<string, { id: string; title: string; exitCode: number | null }>();
  return {
    map,
    add: vi.fn((input: { id: string; title: string }) => {
      map.set(input.id, { id: input.id, title: input.title, exitCode: null });
    }),
    get: (id: string) => map.get(id),
    getAll: () => [...map.values()],
    remove: vi.fn((id: string) => {
      map.delete(id);
    }),
    setExited: (id: string, code: number) => {
      const cur = map.get(id);
      if (!cur) return; // 真实实现同款:不存在即 no-op
      cur.exitCode = code;
    },
    nextDefaultTitle: () => 'Terminal 1',
    subscribe: () => () => {},
    _reset: () => map.clear(),
  };
}

describe('topic49 codex-loop R19 · terminal create reservation 先于 spawn', () => {
  it('PTY 在 createTerminal 期间极速退出 → exit 终态不丢(session.exitCode=0,非 null)', async () => {
    const store = makeStatefulStore();
    // createTerminal 模拟 PTY spawn 后在 resolve 前就退出 → 调 setExited(id, 0)
    const service = {
      createTerminal: vi.fn(async (id: string) => {
        store.setExited(id, 0);
      }),
    };
    const handler = makeCreateHandler({
      service: service as never,
      sessionStore: store as never,
      generateId: () => 'fixed-id',
      resolveCwd: () => '/work',
    });

    await handler({ cwd: '/work' }, fakeWin);

    // 关键:session 应反映已退出(exitCode=0),不是假 live(null)
    expect(store.get('fixed-id')?.exitCode).toBe(0);
  });

  it('createTerminal 失败 → remove(id) 回滚,不留 stale session', async () => {
    const store = makeStatefulStore();
    const service = {
      createTerminal: vi.fn(async () => {
        throw new Error('spawn failed');
      }),
    };
    const handler = makeCreateHandler({
      service: service as never,
      sessionStore: store as never,
      generateId: () => 'fid',
      resolveCwd: () => '/w',
    });

    await expect(handler({ cwd: '/w' }, fakeWin)).rejects.toThrow('spawn failed');
    expect(store.get('fid')).toBeUndefined();
    expect(store.remove).toHaveBeenCalledWith('fid');
  });

  it('add 在 createTerminal 之前调用(reservation 顺序)', async () => {
    const store = makeStatefulStore();
    const service = { createTerminal: vi.fn(async () => {}) };
    const handler = makeCreateHandler({
      service: service as never,
      sessionStore: store as never,
      generateId: () => 'oid',
      resolveCwd: () => '/w',
    });

    await handler({ cwd: '/w' }, fakeWin);

    const addOrder = store.add.mock.invocationCallOrder[0]!;
    const createOrder = service.createTerminal.mock.invocationCallOrder[0]!;
    expect(addOrder).toBeLessThan(createOrder);
  });
});
