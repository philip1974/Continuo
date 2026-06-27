import { describe, it, expect, vi } from 'vitest';
import { TERMINAL_CHANNELS } from '../../../electron/shared/terminal-channels';
import { getDefaultShell } from '@continuo-terminal/server-node';
import {
  createInputSchema,
  idOnlyInputSchema,
  makeCreateHandler,
  resizeInputSchema,
  updateCwdInputSchema,
  writeInputSchema,
} from '../../../electron/main/ipc/terminal.ipc';

// Op4 (topic-12): 用于 cwd 不是断言重点的 makeCreateHandler 用例.
// 显式 cwd 断言用例 (验 createTerminal 被调时的 cwd 参数 / 验 session.cwd) 不要用此 helper.
function makeHandlerWithDefaultCwd(
  extraDeps: Parameters<typeof makeCreateHandler>[0] = {},
) {
  return makeCreateHandler({
    ...extraDeps,
    resolveCwd: extraDeps.resolveCwd ?? (() => '/tmp'),
  });
}

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
  it('workspaceRoot 接受 string(folder isolation tag)', () => {
    expect(
      createInputSchema.safeParse({ workspaceRoot: '/Users/me/proj' }).success,
    ).toBe(true);
  });

  // 边界(E11):args/env/title 等无上限 → 畸形 payload 超大值致 spawn 失败/IPC 卡顿/UI 异常。
  // schema 加合理上限,超限校验失败(走 main BAD_INPUT 拒绝)。
  describe('E11 长度/数量上限', () => {
    it('args 数量超上限 → fail', () => {
      const args = Array.from({ length: 1025 }, () => 'x');
      expect(createInputSchema.safeParse({ args }).success).toBe(false);
    });
    it('单个 arg 超长 → fail', () => {
      expect(
        createInputSchema.safeParse({ args: ['x'.repeat(16385)] }).success,
      ).toBe(false);
    });
    it('title/name/agentLabel 超长 → fail', () => {
      expect(
        createInputSchema.safeParse({ title: 'x'.repeat(513) }).success,
      ).toBe(false);
      expect(
        createInputSchema.safeParse({ name: 'x'.repeat(513) }).success,
      ).toBe(false);
      expect(
        createInputSchema.safeParse({ agentLabel: 'x'.repeat(513) }).success,
      ).toBe(false);
    });
    it('env 条目数 / value 超长 → fail', () => {
      const env: Record<string, string> = {};
      for (let i = 0; i < 1025; i++) env[`K${i}`] = 'v';
      expect(createInputSchema.safeParse({ env }).success).toBe(false);
      expect(
        createInputSchema.safeParse({ env: { FOO: 'x'.repeat(32769) } })
          .success,
      ).toBe(false);
    });
    // 边界(E185):env 改有界早停自定义校验(替代 z.record+refine 的全量遍历)。补 key超长/非对象/
    // 非 string value/合法 env 用例,确认行为等价 + 新增形态守卫。
    it('E185 env key 超长 → fail', () => {
      expect(
        createInputSchema.safeParse({ env: { ['K'.repeat(1025)]: 'v' } })
          .success,
      ).toBe(false);
    });
    it('E185 env 非对象(数组/字符串)→ fail', () => {
      expect(createInputSchema.safeParse({ env: ['a'] }).success).toBe(false);
      expect(createInputSchema.safeParse({ env: 'x' }).success).toBe(false);
      expect(createInputSchema.safeParse({ env: 42 }).success).toBe(false);
    });
    it('E185 env value 非字符串 → fail', () => {
      expect(
        createInputSchema.safeParse({ env: { FOO: 123 } as never }).success,
      ).toBe(false);
    });
    it('E185 合规 env(上限内)→ ok', () => {
      expect(
        createInputSchema.safeParse({ env: { PATH: '/bin', LANG: 'en_US' } })
          .success,
      ).toBe(true);
      expect(createInputSchema.safeParse({ env: {} }).success).toBe(true);
    });
    it('workspaceRoot 超长 → fail', () => {
      expect(
        createInputSchema.safeParse({ workspaceRoot: '/' + 'x'.repeat(8192) })
          .success,
      ).toBe(false);
    });
    it('正常规模 payload 仍 ok(上限远超真实用法)', () => {
      expect(
        createInputSchema.safeParse({
          shell: '/bin/zsh',
          args: ['-l', '--login', '/some/long/path/to/a/file.txt'],
          env: { PATH: '/usr/bin:/bin', LANG: 'en_US.UTF-8' },
          title: 'My Terminal',
          agentLabel: 'codex',
          workspaceRoot: '/Users/me/projects/app',
        }).success,
      ).toBe(true);
    });
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

  // 边界(E219,E125/E127/E129 字节 vs code-unit 族):data 按真实 UTF-8 字节限,非 .max()(code unit)。
  it('E219 多字节 CJK data(byteLength>2M,length≤2M)→ fail(按字节)', () => {
    const cjk = '中'.repeat(700_000); // length 700k ≤ 2M,但 UTF-8 ≈2.1MB > 2M
    expect(writeInputSchema.safeParse({ id: 'a', data: cjk }).success).toBe(false);
  });
  it('E219 上限内 ASCII data(2M 字节)→ ok(边界回归)', () => {
    expect(
      writeInputSchema.safeParse({ id: 'a', data: 'x'.repeat(2_000_000) }).success,
    ).toBe(true);
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
  // 边界(E33):session id 加 256 上限(防超长 id 进会话表/错误消息/广播)。
  it('E33 id 超 256 → fail', () => {
    expect(
      idOnlyInputSchema.safeParse({ id: 'x'.repeat(257) }).success,
    ).toBe(false);
  });
});

// 边界(E33,E11/E23 同族):session:update-cwd 的 id/cwd 此前只 .min(1) 无上限。cwd 写进 session
// metadata 并触发 sessions_changed 广播,超长值让每次快照广播 + Dock 渲染携带巨大字符串;超长 id
// 还拼进错误消息。id .max(256)、cwd .max(PATH_MAX=8192)。同族 id 上限覆盖 write/resize/idOnly。
describe('updateCwdInputSchema (E33)', () => {
  it('正常 id/cwd → ok', () => {
    expect(
      updateCwdInputSchema.safeParse({ id: 'term-1', cwd: '/work' }).success,
    ).toBe(true);
  });
  it('id 超 256 → fail', () => {
    expect(
      updateCwdInputSchema.safeParse({ id: 'x'.repeat(257), cwd: '/work' })
        .success,
    ).toBe(false);
  });
  it('cwd 超 8192 → fail', () => {
    expect(
      updateCwdInputSchema.safeParse({
        id: 'term-1',
        cwd: '/' + 'x'.repeat(8192),
      }).success,
    ).toBe(false);
  });
  it('空 id / 空 cwd → fail(既有 min1)', () => {
    expect(
      updateCwdInputSchema.safeParse({ id: '', cwd: '/work' }).success,
    ).toBe(false);
    expect(
      updateCwdInputSchema.safeParse({ id: 'term-1', cwd: '' }).success,
    ).toBe(false);
  });
});

// 边界(E33):id 上限也覆盖 write/resize 兄弟入口。
describe('write/resize id 上限 (E33)', () => {
  it('writeInputSchema id 超 256 → fail', () => {
    expect(
      writeInputSchema.safeParse({ id: 'x'.repeat(257), data: 'hi' }).success,
    ).toBe(false);
  });
  it('resizeInputSchema id 超 256 → fail', () => {
    expect(
      resizeInputSchema.safeParse({ id: 'x'.repeat(257), cols: 80, rows: 24 })
        .success,
    ).toBe(false);
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
  // race(R31):makeCreateHandler 在 createTerminal resolve 后 get(id) 复查 reservation 是否被
  // 取消(关 tab)。mock 须模型真实 store:add 后 get 返回该 session(否则恒 undefined 会被
  // 误判为「已取消」)。用有状态 map 让 add/get/remove 一致。
  const makeSessionStore = () => {
    const map = new Map<string, { id: string }>();
    return {
      add: vi.fn((input: { id: string }) => {
        map.set(input.id, input);
      }),
      get: vi.fn((id: string) => map.get(id)),
      getAll: vi.fn(() => [...map.values()]),
      remove: vi.fn((id: string) => {
        map.delete(id);
      }),
      setExited: vi.fn(),
      nextDefaultTitle: vi.fn((_windowId: number) => 'Terminal 1'),
      subscribe: vi.fn(() => () => {}),
      _reset: vi.fn(() => map.clear()),
    };
  };

  it('shell 缺失 → 用 getDefaultShell 结果', async () => {
    const service = makeService();
    const sessionStore = makeSessionStore();
    const handler = makeCreateHandler({
      service: service as never,
      sessionStore: sessionStore as never,
      generateId: () => 'fixed-id',
      resolveCwd: () => '/work',
    });
    const r = await handler({}, fakeWin);
    expect(r).toEqual({ id: 'fixed-id' });
    expect(service.createTerminal).toHaveBeenCalledOnce();
    const call = service.createTerminal.mock.calls[0]!;
    expect(call[0]).toBe('fixed-id'); // id
    expect(call[2]).toBe(getDefaultShell()); // shell
    expect(call[4]).toBe('/work'); // cwd
  });

  it('shell 不在白名单 → 抛 TERMINAL_FORBIDDEN_SHELL', async () => {
    const service = makeService();
    const sessionStore = makeSessionStore();
    const handler = makeHandlerWithDefaultCwd({
      service: service as never,
      sessionStore: sessionStore as never,
      generateId: () => 'x',
    });
    await expect(
      handler({ shell: '/tmp/evil-shell' }, fakeWin),
    ).rejects.toThrowError(/forbidden|allowlist/i);
    expect(service.createTerminal).not.toHaveBeenCalled();
    expect(sessionStore.add).not.toHaveBeenCalled();
  });

  it('args / cwd / env 透传到 service', async () => {
    const service = makeService();
    const sessionStore = makeSessionStore();
    const handler = makeCreateHandler({
      service: service as never,
      sessionStore: sessionStore as never,
      generateId: () => 'x',
      resolveCwd: (c) => c ?? '/default',
    });
    await handler(
      { shell: '/bin/zsh', args: ['-l'], cwd: '/proj', env: { K: 'V' } },
      fakeWin,
    );
    const call = service.createTerminal.mock.calls[0]!;
    expect(call[3]).toEqual(['-l']);
    expect(call[4]).toBe('/proj');
    expect(call[5]).toEqual({ K: 'V' });
  });

  // ── P1 metadata 入 sessions service ────────────────────────

  it('成功创建 → sessionStore.add 入 metadata', async () => {
    const service = makeService();
    const sessionStore = makeSessionStore();
    const handler = makeCreateHandler({
      service: service as never,
      sessionStore: sessionStore as never,
      generateId: () => 'term-x',
      resolveCwd: () => '/work',
    });
    await handler({}, fakeWin);
    expect(sessionStore.add).toHaveBeenCalledOnce();
    expect(sessionStore.add.mock.calls[0]![0]).toMatchObject({
      id: 'term-x',
      title: 'Terminal 1',
      cwd: '/work',
      originHint: 'user',
    });
  });

  it('input.workspaceRoot → sessionStore.add 透传(folder isolation)', async () => {
    const service = makeService();
    const sessionStore = makeSessionStore();
    const handler = makeCreateHandler({
      service: service as never,
      sessionStore: sessionStore as never,
      generateId: () => 'term-w',
      resolveCwd: () => '/work',
    });
    await handler({ workspaceRoot: '/Users/me/proj-a' }, fakeWin);
    expect(sessionStore.add.mock.calls[0]![0]).toMatchObject({
      id: 'term-w',
      workspaceRoot: '/Users/me/proj-a',
    });
  });

  it('未传 workspaceRoot → sessionStore.add 不带该字段(全局会话)', async () => {
    const service = makeService();
    const sessionStore = makeSessionStore();
    const handler = makeCreateHandler({
      service: service as never,
      sessionStore: sessionStore as never,
      generateId: () => 'term-g',
      resolveCwd: () => '/work',
    });
    await handler({}, fakeWin);
    const added = sessionStore.add.mock.calls[0]![0];
    expect('workspaceRoot' in added).toBe(false);
  });

  it('input.name 缺省 → 调 nextDefaultTitle', async () => {
    const service = makeService();
    const sessionStore = makeSessionStore();
    const handler = makeHandlerWithDefaultCwd({
      service: service as never,
      sessionStore: sessionStore as never,
      generateId: () => 'x',
    });
    await handler({}, fakeWin);
    expect(sessionStore.nextDefaultTitle).toHaveBeenCalledOnce();
  });

  it('input.name 给值 → 直接用,不调 nextDefaultTitle', async () => {
    const service = makeService();
    const sessionStore = makeSessionStore();
    const handler = makeHandlerWithDefaultCwd({
      service: service as never,
      sessionStore: sessionStore as never,
      generateId: () => 'x',
    });
    await handler({ name: 'My Terminal' }, fakeWin);
    expect(sessionStore.nextDefaultTitle).not.toHaveBeenCalled();
    expect(sessionStore.add.mock.calls[0]![0].title).toBe('My Terminal');
  });

  it('originHint / agentLabel 透传(P2 MCP create_session 用)', async () => {
    const service = makeService();
    const sessionStore = makeSessionStore();
    const handler = makeHandlerWithDefaultCwd({
      service: service as never,
      sessionStore: sessionStore as never,
      generateId: () => 'x',
    });
    await handler(
      { originHint: 'agent', agentLabel: 'codex', name: 'codex' },
      fakeWin,
    );
    expect(sessionStore.add.mock.calls[0]![0]).toMatchObject({
      originHint: 'agent',
      agentLabel: 'codex',
      title: 'codex',
    });
  });

  it('originHint 缺省默认 user', async () => {
    const service = makeService();
    const sessionStore = makeSessionStore();
    const handler = makeHandlerWithDefaultCwd({
      service: service as never,
      sessionStore: sessionStore as never,
      generateId: () => 'x',
    });
    await handler({}, fakeWin);
    expect(sessionStore.add.mock.calls[0]![0].originHint).toBe('user');
  });

  // ── Issue #28 Phase 1:ownerWindowId 从 win 透传 ─────────────

  it('sessionStore.add 入参附 ownerWindowId = win.id', async () => {
    const service = makeService();
    const sessionStore = makeSessionStore();
    const handler = makeHandlerWithDefaultCwd({
      service: service as never,
      sessionStore: sessionStore as never,
      generateId: () => 'x',
    });
    await handler({}, fakeWin); // win.id === 11
    expect(sessionStore.add.mock.calls[0]![0].ownerWindowId).toBe(11);
  });

  it('不同 win 调同 handler → 各自 owner 进 sessionStore.add', async () => {
    const service = makeService();
    const sessionStore = makeSessionStore();
    let seq = 0;
    const handler = makeHandlerWithDefaultCwd({
      service: service as never,
      sessionStore: sessionStore as never,
      generateId: () => `id-${++seq}`,
    });
    await handler({}, { id: 11 } as unknown as import('electron').BrowserWindow);
    await handler({}, { id: 22 } as unknown as import('electron').BrowserWindow);
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
      nextDefaultTitle: vi.fn((_windowId: number) => 'Terminal 1'),
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
  const fakeWin = { id: 11 } as unknown as import('electron').BrowserWindow;

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
      get: vi.fn(() => ({ id: 'term-1', ownerWindowId: 11 })),
      getAll: vi.fn(() => []),
      remove: vi.fn(),
      setExited: vi.fn(),
      nextDefaultTitle: vi.fn((_windowId: number) => 'Terminal 1'),
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
    handler({ id: 'term-1' }, fakeWin);
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
      get: vi.fn(() => ({ id: 'term-dead', ownerWindowId: 11 })),
      getAll: vi.fn(() => []),
      remove: vi.fn(),
      setExited: vi.fn(),
      nextDefaultTitle: vi.fn((_windowId: number) => 'Terminal 1'),
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
    handler({ id: 'term-dead' }, fakeWin);
    expect(sessionStore.remove).toHaveBeenCalledWith('term-dead');
    expect(service.kill).not.toHaveBeenCalled();
  });

  it('非 owner window remove → 抛 TERMINAL_NOT_FOUND 且不删 metadata', async () => {
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
      get: vi.fn(() => ({ id: 'term-1', ownerWindowId: 11 })),
      getAll: vi.fn(() => []),
      remove: vi.fn(),
      setExited: vi.fn(),
      nextDefaultTitle: vi.fn((_windowId: number) => 'Terminal 1'),
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
    expect(() =>
      handler(
        { id: 'term-1' },
        { id: 22 } as unknown as import('electron').BrowserWindow,
      ),
    ).toThrow(/terminal not found/);
    expect(sessionStore.remove).not.toHaveBeenCalled();
    expect(service.kill).not.toHaveBeenCalled();
  });
});
