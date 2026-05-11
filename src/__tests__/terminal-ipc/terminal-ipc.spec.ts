import { describe, it, expect, vi } from 'vitest';
import { TERMINAL_CHANNELS } from '../../../electron/shared/terminal-channels';
import {
  getDefaultShell,
  isAllowedShell,
} from '../../../electron/shared/terminal-shells';
import {
  createInputSchema,
  idOnlyInputSchema,
  makeCreateHandler,
  resizeInputSchema,
  writeInputSchema,
} from '../../../electron/main/ipc/terminal.ipc';

// ────────────────────────────────────────────────────────────
// TERMINAL_CHANNELS
// ────────────────────────────────────────────────────────────

describe('TERMINAL_CHANNELS', () => {
  it('每条字符串与契约一致', () => {
    expect(TERMINAL_CHANNELS.CREATE).toBe('terminal:create');
    expect(TERMINAL_CHANNELS.WRITE).toBe('terminal:write');
    expect(TERMINAL_CHANNELS.RESIZE).toBe('terminal:resize');
    expect(TERMINAL_CHANNELS.INTERRUPT).toBe('terminal:interrupt');
    expect(TERMINAL_CHANNELS.KILL).toBe('terminal:kill');
    expect(TERMINAL_CHANNELS.DESTROY).toBe('terminal:destroy');
    expect(TERMINAL_CHANNELS.LIST_SESSIONS).toBe('terminal:list_sessions');
    expect(TERMINAL_CHANNELS.REMOVE).toBe('terminal:remove');
    expect(TERMINAL_CHANNELS.DATA).toBe('terminal:data');
    expect(TERMINAL_CHANNELS.EXIT).toBe('terminal:exit');
    expect(TERMINAL_CHANNELS.OVERFLOW).toBe('terminal:overflow');
    expect(TERMINAL_CHANNELS.OVERFLOW_RECOVERED).toBe('terminal:overflow-recovered');
    expect(TERMINAL_CHANNELS.SESSIONS_CHANGED).toBe('terminal:sessions_changed');
  });

  it('全部前缀 terminal:', () => {
    for (const v of Object.values(TERMINAL_CHANNELS)) {
      expect(v.startsWith('terminal:')).toBe(true);
    }
  });

  it('值唯一', () => {
    const vals = Object.values(TERMINAL_CHANNELS);
    expect(new Set(vals).size).toBe(vals.length);
  });
});

// ────────────────────────────────────────────────────────────
// schemas
// ────────────────────────────────────────────────────────────

describe('createInputSchema', () => {
  it('全空 → ok(全字段 optional)', () => {
    expect(createInputSchema.safeParse({}).success).toBe(true);
  });
  it('完整 → ok', () => {
    expect(
      createInputSchema.safeParse({
        shell: '/bin/zsh',
        args: ['-l'],
        cwd: '/tmp',
        env: { FOO: 'BAR' },
      }).success,
    ).toBe(true);
  });
  it('未知字段 → fail(strict)', () => {
    expect(createInputSchema.safeParse({ weird: 1 }).success).toBe(false);
  });
});

describe('writeInputSchema', () => {
  it('正常 → ok', () => {
    expect(writeInputSchema.safeParse({ id: 'a', data: 'hi' }).success).toBe(true);
  });
  it('id 空 → fail', () => {
    expect(writeInputSchema.safeParse({ id: '', data: 'hi' }).success).toBe(false);
  });
  it('data 超 2M 字符 → fail', () => {
    const big = 'x'.repeat(2_000_001);
    expect(writeInputSchema.safeParse({ id: 'a', data: big }).success).toBe(false);
  });
});

describe('resizeInputSchema', () => {
  it('正常 → ok', () => {
    expect(
      resizeInputSchema.safeParse({ id: 'a', cols: 80, rows: 24 }).success,
    ).toBe(true);
  });
  it('cols 超范围 → fail', () => {
    expect(
      resizeInputSchema.safeParse({ id: 'a', cols: 0, rows: 24 }).success,
    ).toBe(false);
    expect(
      resizeInputSchema.safeParse({ id: 'a', cols: 1001, rows: 24 }).success,
    ).toBe(false);
  });
  it('rows 超范围 → fail', () => {
    expect(
      resizeInputSchema.safeParse({ id: 'a', cols: 80, rows: 501 }).success,
    ).toBe(false);
  });
  it('非整数 → fail', () => {
    expect(
      resizeInputSchema.safeParse({ id: 'a', cols: 80.5, rows: 24 }).success,
    ).toBe(false);
  });
});

describe('idOnlyInputSchema', () => {
  it('正常', () => {
    expect(idOnlyInputSchema.safeParse({ id: 'x' }).success).toBe(true);
  });
  it('未知字段 → fail', () => {
    expect(idOnlyInputSchema.safeParse({ id: 'x', y: 1 }).success).toBe(false);
  });
});

// ────────────────────────────────────────────────────────────
// shell 白名单
// ────────────────────────────────────────────────────────────

describe('isAllowedShell', () => {
  // 跳过 win32 专属断言(本机非 Windows 跑测时会拒绝 win 路径)
  const skipUnix = process.platform === 'win32';

  if (!skipUnix) {
    it('/bin/zsh / bash / sh / fish 通过', () => {
      expect(isAllowedShell('/bin/zsh')).toBe(true);
      expect(isAllowedShell('/bin/bash')).toBe(true);
      expect(isAllowedShell('/bin/sh')).toBe(true);
      expect(isAllowedShell('/bin/fish')).toBe(true);
    });

    it('/opt/homebrew/bin/fish 通过', () => {
      expect(isAllowedShell('/opt/homebrew/bin/fish')).toBe(true);
    });

    it('/usr/local/bin/zsh 通过', () => {
      expect(isAllowedShell('/usr/local/bin/zsh')).toBe(true);
    });

    it('任意路径 + zsh 不在白名单(防注入)', () => {
      expect(isAllowedShell('/tmp/zsh')).toBe(false);
      expect(isAllowedShell('/home/user/evil/zsh')).toBe(false);
    });

    it('白名单内但名字非 shell → fail', () => {
      expect(isAllowedShell('/bin/ls')).toBe(false);
      expect(isAllowedShell('/usr/bin/python')).toBe(false);
    });
  }
});

describe('getDefaultShell', () => {
  // 不能真改 process.env.SHELL,只能断言返回值是合法 shell
  it('返回值在白名单内', () => {
    const s = getDefaultShell();
    expect(isAllowedShell(s)).toBe(true);
  });
});

// ────────────────────────────────────────────────────────────
// makeCreateHandler(注入 deps,不真 spawn)
// ────────────────────────────────────────────────────────────

describe('makeCreateHandler', () => {
  const fakeWin = { id: 11 } as unknown as import('electron').BrowserWindow;
  const makeService = () => ({
    createTerminal: vi.fn(),
    has: vi.fn(() => false),
    write: vi.fn(),
    resize: vi.fn(),
    interrupt: vi.fn(),
    kill: vi.fn(),
    cleanupAll: vi.fn(),
    safeTruncate: vi.fn(),
    isInPlaceUpdate: vi.fn(),
  });
  const makeSessionStore = () => ({
    add: vi.fn(),
    get: vi.fn(),
    getAll: vi.fn(() => []),
    remove: vi.fn(),
    setExited: vi.fn(),
    nextDefaultTitle: vi.fn(() => 'Terminal 1'),
    subscribe: vi.fn(() => () => {}),
    _reset: vi.fn(),
  });

  it('shell 缺失 → 用 getDefaultShell 结果', () => {
    const service = makeService();
    const sessionStore = makeSessionStore();
    const handler = makeCreateHandler({
      service: service as never,
      sessionStore: sessionStore as never,
      generateId: () => 'fixed-id',
      resolveCwd: () => '/work',
    });
    const r = handler({}, fakeWin);
    expect(r).toEqual({ id: 'fixed-id' });
    expect(service.createTerminal).toHaveBeenCalledOnce();
    const call = service.createTerminal.mock.calls[0]!;
    expect(call[0]).toBe('fixed-id'); // id
    expect(call[2]).toBe(getDefaultShell()); // shell
    expect(call[4]).toBe('/work'); // cwd
  });

  it('shell 不在白名单 → 抛 TERMINAL_FORBIDDEN_SHELL', () => {
    const service = makeService();
    const sessionStore = makeSessionStore();
    const handler = makeCreateHandler({
      service: service as never,
      sessionStore: sessionStore as never,
      generateId: () => 'x',
    });
    expect(() =>
      handler({ shell: '/tmp/evil-shell' }, fakeWin),
    ).toThrowError(/forbidden|allowlist/i);
    expect(service.createTerminal).not.toHaveBeenCalled();
    expect(sessionStore.add).not.toHaveBeenCalled();
  });

  it('args / cwd / env 透传到 service', () => {
    const service = makeService();
    const sessionStore = makeSessionStore();
    const handler = makeCreateHandler({
      service: service as never,
      sessionStore: sessionStore as never,
      generateId: () => 'x',
      resolveCwd: (c) => c ?? '/default',
    });
    handler(
      { shell: '/bin/zsh', args: ['-l'], cwd: '/proj', env: { K: 'V' } },
      fakeWin,
    );
    const call = service.createTerminal.mock.calls[0]!;
    expect(call[3]).toEqual(['-l']);
    expect(call[4]).toBe('/proj');
    expect(call[5]).toEqual({ K: 'V' });
  });

  // ── P1 metadata 入 sessions service ────────────────────────

  it('成功创建 → sessionStore.add 入 metadata', () => {
    const service = makeService();
    const sessionStore = makeSessionStore();
    const handler = makeCreateHandler({
      service: service as never,
      sessionStore: sessionStore as never,
      generateId: () => 'term-x',
      resolveCwd: () => '/work',
    });
    handler({}, fakeWin);
    expect(sessionStore.add).toHaveBeenCalledOnce();
    expect(sessionStore.add.mock.calls[0]![0]).toMatchObject({
      id: 'term-x',
      title: 'Terminal 1',
      cwd: '/work',
      originHint: 'user',
    });
  });

  it('input.name 缺省 → 调 nextDefaultTitle', () => {
    const service = makeService();
    const sessionStore = makeSessionStore();
    const handler = makeCreateHandler({
      service: service as never,
      sessionStore: sessionStore as never,
      generateId: () => 'x',
    });
    handler({}, fakeWin);
    expect(sessionStore.nextDefaultTitle).toHaveBeenCalledOnce();
  });

  it('input.name 给值 → 直接用,不调 nextDefaultTitle', () => {
    const service = makeService();
    const sessionStore = makeSessionStore();
    const handler = makeCreateHandler({
      service: service as never,
      sessionStore: sessionStore as never,
      generateId: () => 'x',
    });
    handler({ name: 'My Terminal' }, fakeWin);
    expect(sessionStore.nextDefaultTitle).not.toHaveBeenCalled();
    expect(sessionStore.add.mock.calls[0]![0].title).toBe('My Terminal');
  });

  it('originHint / agentLabel 透传(P2 MCP create_session 用)', () => {
    const service = makeService();
    const sessionStore = makeSessionStore();
    const handler = makeCreateHandler({
      service: service as never,
      sessionStore: sessionStore as never,
      generateId: () => 'x',
    });
    handler(
      { originHint: 'agent', agentLabel: 'codex', name: 'codex' },
      fakeWin,
    );
    expect(sessionStore.add.mock.calls[0]![0]).toMatchObject({
      originHint: 'agent',
      agentLabel: 'codex',
      title: 'codex',
    });
  });

  it('originHint 缺省默认 user', () => {
    const service = makeService();
    const sessionStore = makeSessionStore();
    const handler = makeCreateHandler({
      service: service as never,
      sessionStore: sessionStore as never,
      generateId: () => 'x',
    });
    handler({}, fakeWin);
    expect(sessionStore.add.mock.calls[0]![0].originHint).toBe('user');
  });

  // ── Issue #28 Phase 1:ownerWindowId 从 win 透传 ─────────────

  it('sessionStore.add 入参附 ownerWindowId = win.id', () => {
    const service = makeService();
    const sessionStore = makeSessionStore();
    const handler = makeCreateHandler({
      service: service as never,
      sessionStore: sessionStore as never,
      generateId: () => 'x',
    });
    handler({}, fakeWin); // win.id === 11
    expect(sessionStore.add.mock.calls[0]![0].ownerWindowId).toBe(11);
  });

  it('不同 win 调同 handler → 各自 owner 进 sessionStore.add', () => {
    const service = makeService();
    const sessionStore = makeSessionStore();
    let seq = 0;
    const handler = makeCreateHandler({
      service: service as never,
      sessionStore: sessionStore as never,
      generateId: () => `id-${++seq}`,
    });
    handler({}, { id: 11 } as unknown as import('electron').BrowserWindow);
    handler({}, { id: 22 } as unknown as import('electron').BrowserWindow);
    expect(sessionStore.add.mock.calls[0]![0].ownerWindowId).toBe(11);
    expect(sessionStore.add.mock.calls[1]![0].ownerWindowId).toBe(22);
  });
});

// ────────────────────────────────────────────────────────────
// makeListSessionsHandler / makeRemoveHandler(P1 新增)
// ────────────────────────────────────────────────────────────

describe('makeListSessionsHandler', () => {
  it('按 ownerWindowId 调 sessionStore.getAll({ownerWindowId})', async () => {
    const fakeSessions = [
      {
        id: 'a',
        title: 'A',
        cwd: '/',
        originHint: 'user' as const,
        createdAt: 1,
        exitCode: null,
        ownerWindowId: 11,
      },
    ];
    const sessionStore = {
      add: vi.fn(),
      get: vi.fn(),
      getAll: vi.fn(() => fakeSessions),
      remove: vi.fn(),
      removeByOwner: vi.fn(),
      setExited: vi.fn(),
      nextDefaultTitle: vi.fn(),
      subscribe: vi.fn(),
      _reset: vi.fn(),
    };
    const { makeListSessionsHandler } = await import(
      '../../../electron/main/ipc/terminal.ipc'
    );
    const handler = makeListSessionsHandler({ sessionStore: sessionStore as never });
    const r = handler({ ownerWindowId: 11 });
    expect(r).toEqual({ sessions: fakeSessions });
    expect(sessionStore.getAll).toHaveBeenCalledWith({ ownerWindowId: 11 });
  });
});

describe('makeRemoveHandler', () => {
  it('立即删 metadata + 异步 kill PTY(若存在)', async () => {
    const service = {
      createTerminal: vi.fn(),
      has: vi.fn(() => true),
      write: vi.fn(),
      resize: vi.fn(),
      interrupt: vi.fn(),
      kill: vi.fn(),
      cleanupAll: vi.fn(),
      safeTruncate: vi.fn(),
      isInPlaceUpdate: vi.fn(),
    };
    const sessionStore = {
      add: vi.fn(),
      get: vi.fn(),
      getAll: vi.fn(() => []),
      remove: vi.fn(),
      setExited: vi.fn(),
      nextDefaultTitle: vi.fn(),
      subscribe: vi.fn(),
      _reset: vi.fn(),
    };
    const { makeRemoveHandler } = await import(
      '../../../electron/main/ipc/terminal.ipc'
    );
    const handler = makeRemoveHandler({
      service: service as never,
      sessionStore: sessionStore as never,
    });
    handler({ id: 'term-1' });
    expect(sessionStore.remove).toHaveBeenCalledWith('term-1');
    expect(service.kill).toHaveBeenCalledWith('term-1');
  });

  it('PTY 不存在(已 exit)→ 删 metadata 不再调 kill', async () => {
    const service = {
      createTerminal: vi.fn(),
      has: vi.fn(() => false),
      write: vi.fn(),
      resize: vi.fn(),
      interrupt: vi.fn(),
      kill: vi.fn(),
      cleanupAll: vi.fn(),
      safeTruncate: vi.fn(),
      isInPlaceUpdate: vi.fn(),
    };
    const sessionStore = {
      add: vi.fn(),
      get: vi.fn(),
      getAll: vi.fn(() => []),
      remove: vi.fn(),
      setExited: vi.fn(),
      nextDefaultTitle: vi.fn(),
      subscribe: vi.fn(),
      _reset: vi.fn(),
    };
    const { makeRemoveHandler } = await import(
      '../../../electron/main/ipc/terminal.ipc'
    );
    const handler = makeRemoveHandler({
      service: service as never,
      sessionStore: sessionStore as never,
    });
    handler({ id: 'term-dead' });
    expect(sessionStore.remove).toHaveBeenCalledWith('term-dead');
    expect(service.kill).not.toHaveBeenCalled();
  });
});
