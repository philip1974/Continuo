// BDD: terminal-workspace-isolation — workspaceRoot 跨层 round-trip
//
// 锁 invariant:create 入参里的 workspaceRoot 一路落到
// sessionStore → snapshot,被 renderer 拿到。本 spec 在 main 进程一侧
// 端到端验,renderer 端的 render filter 在 panelReducer 主题的 spec 验。

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  _reset,
  add,
  getAll,
  type MainTerminalSession,
} from '../../../electron/main/services/terminal-sessions.service';
import { makeCreateHandler } from '../../../electron/main/ipc/terminal.ipc';
import type { BrowserWindow } from 'electron';

beforeEach(() => {
  _reset();
});

function fakeWin(id = 11): BrowserWindow {
  return { id } as unknown as BrowserWindow;
}

function makeService() {
  return {
    createTerminal: vi.fn(),
    has: vi.fn(() => false),
    write: vi.fn(),
    resize: vi.fn(),
    interrupt: vi.fn(),
    kill: vi.fn(),
    cleanupAll: vi.fn(),
  };
}

describe('terminal-workspace-isolation: workspaceRoot 跨层 round-trip', () => {
  it('create input.workspaceRoot → sessionStore.add → MainTerminalSession.workspaceRoot', async () => {
    const service = makeService();
    const handler = makeCreateHandler({
      service: service as never,
      generateId: () => 'term-1',
      resolveCwd: () => '/proj-a',
    });
    await handler({ workspaceRoot: '/proj-a' }, fakeWin(11));
    const s = getAll({ ownerWindowId: 11 })[0]!;
    expect(s.workspaceRoot).toBe('/proj-a');
  });

  it('create 未传 workspaceRoot → session 字段不存在(全局,跨 workspace 都可见)', async () => {
    const service = makeService();
    const handler = makeCreateHandler({
      service: service as never,
      generateId: () => 'term-g',
      resolveCwd: () => '/work',
    });
    await handler({}, fakeWin(11));
    const s = getAll({ ownerWindowId: 11 })[0]!;
    expect('workspaceRoot' in s).toBe(false);
  });

  it('两个 workspace 各自 create → snapshot 同时含两个,workspaceRoot 字段区分', async () => {
    const service = makeService();
    const handler = makeCreateHandler({
      service: service as never,
      // 每次新 id;否则 sessionStore 抛 duplicate。
      generateId: (() => {
        let n = 0;
        return () => `term-${++n}`;
      })(),
      resolveCwd: (c) => c ?? '/',
    });
    await handler({ workspaceRoot: '/proj-a', cwd: '/proj-a' }, fakeWin(11));
    await handler({ workspaceRoot: '/proj-b', cwd: '/proj-b' }, fakeWin(11));
    const all = getAll({ ownerWindowId: 11 });
    expect(all).toHaveLength(2);
    expect(all.map((s: MainTerminalSession) => s.workspaceRoot).sort()).toEqual([
      '/proj-a',
      '/proj-b',
    ]);
  });

  it('add 直接调:workspaceRoot 字段透传后 getAll 拿回完整', () => {
    add({
      id: 'term-direct',
      title: 'X',
      cwd: '/x',
      originHint: 'user',
      ownerWindowId: 11,
      workspaceRoot: '/x-root',
    });
    expect(getAll()[0]!.workspaceRoot).toBe('/x-root');
  });
});
