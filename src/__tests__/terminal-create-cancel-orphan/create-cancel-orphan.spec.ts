// race(R31):makeCreateHandler 先 sessionStore.add()(可见 reservation),再 await
// service.createTerminal()(PTY 在 await 期间才真正建立)。这段窗口内用户关 tab →
// makeRemoveHandler 删 metadata,但当时 service.has(id) 仍 false → 不 kill;随后 createTerminal
// resolve 出真实 PTY,而 metadata 已删 → renderer 看不到、无法经 UI 关闭 = 不可见孤儿终端/进程。
// 修:createTerminal resolve 后复查 reservation,若已被 remove 取消 → kill 刚建 PTY + 抛 CANCELLED。
import { describe, it, expect, vi } from 'vitest';
import type { BrowserWindow } from 'electron';
import { makeCreateHandler } from '../../../electron/main/ipc/terminal.ipc';
import { ERROR_CODES } from '../../../electron/shared/error-codes';

const fakeWin = { id: 7 } as unknown as BrowserWindow;

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
      if (!cur) return;
      cur.exitCode = code;
    },
    nextDefaultTitle: () => 'Terminal 1',
    subscribe: () => () => {},
    _reset: () => map.clear(),
  };
}

describe('race(R31) · terminal create 期间取消不留孤儿 PTY', () => {
  it('create 期间 session 被 remove(用户关 tab)→ kill 孤儿 PTY + 抛 TERMINAL_CREATE_CANCELLED', async () => {
    const store = makeStatefulStore();
    const ptyExists = new Set<string>();
    const service = {
      // 模拟用户在 await createTerminal 期间关 tab:removeHandler 删 metadata(此刻 PTY 还没建,
      // service.has 为 false 不 kill);本函数随后才把 PTY 建出来。
      createTerminal: vi.fn(async (id: string) => {
        store.remove(id);
        ptyExists.add(id);
      }),
      has: vi.fn((id: string) => ptyExists.has(id)),
      kill: vi.fn((id: string) => {
        ptyExists.delete(id);
      }),
    };
    const handler = makeCreateHandler({
      service: service as never,
      sessionStore: store as never,
      generateId: () => 'cid',
      resolveCwd: () => '/w',
    });

    await expect(handler({ cwd: '/w' }, fakeWin)).rejects.toMatchObject({
      code: ERROR_CODES.TERMINAL_CREATE_CANCELLED,
    });
    // 孤儿 PTY 被 kill,不残留;metadata 仍是删除态。
    expect(service.kill).toHaveBeenCalledWith('cid');
    expect(ptyExists.has('cid')).toBe(false);
    expect(store.get('cid')).toBeUndefined();
  });

  it('正常 create(session 未被 remove)→ 返回 {id},不 kill', async () => {
    const store = makeStatefulStore();
    const ptyExists = new Set<string>();
    const service = {
      createTerminal: vi.fn(async (id: string) => {
        ptyExists.add(id);
      }),
      has: vi.fn((id: string) => ptyExists.has(id)),
      kill: vi.fn(),
    };
    const handler = makeCreateHandler({
      service: service as never,
      sessionStore: store as never,
      generateId: () => 'ok',
      resolveCwd: () => '/w',
    });

    const r = await handler({ cwd: '/w' }, fakeWin);
    expect(r).toEqual({ id: 'ok' });
    expect(service.kill).not.toHaveBeenCalled();
  });

  it('exit-during-create(setExited 保留 metadata)→ 不当作取消,正常返回(R19 兼容)', async () => {
    const store = makeStatefulStore();
    const service = {
      // PTY 极速退出:setExited 保留 metadata(exitCode=0),get(id) 仍在 → 不是取消。
      createTerminal: vi.fn(async (id: string) => {
        store.setExited(id, 0);
      }),
      has: vi.fn(() => false),
      kill: vi.fn(),
    };
    const handler = makeCreateHandler({
      service: service as never,
      sessionStore: store as never,
      generateId: () => 'eid',
      resolveCwd: () => '/w',
    });

    const r = await handler({ cwd: '/w' }, fakeWin);
    expect(r).toEqual({ id: 'eid' });
    expect(service.kill).not.toHaveBeenCalled();
    expect(store.get('eid')?.exitCode).toBe(0);
  });
});
