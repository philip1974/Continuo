// BDD: agent-terminal-mcp-await-stop-hook
// terminal.await_stop_hook MCP tool 契约层。

import { mkdtemp, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  awaitStopHookInputSchema,
  awaitStopHookOutputSchema,
  createSessionInputSchema,
  MCP_TOOL_AWAIT_STOP_HOOK,
} from '../../../electron/shared/mcp-terminal-schemas';
import {
  createAwaitStopHookTool,
  createHookFileBroker,
  type HookFileBroker,
} from '../../../electron/main/services/mcp-tools-hook-bridge';

const DONE_BUFFER_CAP = 500;
const DONE_ENTRY_MAX_AGE_MS = 10 * 60 * 1000;
const ctx = { ownerWindowId: 4 };

type Runner = 'cc' | 'codex';

interface FakeSession {
  readonly id: string;
  readonly windowId: number;
  readonly runner: Runner;
  readonly cwd: string;
}

interface AwaitStopHookInput {
  readonly session_id: string;
  readonly timeout_sec?: number;
  readonly include_raw?: boolean;
}

const tmpRoots: string[] = [];
const brokers: HookFileBroker[] = [];

afterEach(async () => {
  await Promise.all(brokers.splice(0).map((broker) => broker.stop()));
  vi.useRealTimers();
  await Promise.all(
    tmpRoots.splice(0).map((root) =>
      rm(root, { recursive: true, force: true }),
    ),
  );
});

async function makeDoneDir(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'continuo-await-stop-hook-'));
  tmpRoots.push(root);
  return root;
}

async function writeFixture(
  doneDir: string,
  opts: {
    readonly runner: Runner;
    readonly windowId: number;
    readonly cliSessionId?: string;
    readonly ns: string;
    readonly payload: Record<string, unknown>;
    readonly old?: boolean;
  },
): Promise<string> {
  const file =
    opts.runner === 'cc'
      ? `${opts.runner}_${opts.windowId}_${opts.cliSessionId}_${opts.ns}.jsonl`
      : `${opts.runner}_${opts.windowId}_${opts.ns}.jsonl`;
  const fullPath = join(doneDir, file);
  await writeFile(fullPath, `${JSON.stringify(opts.payload)}\n`, 'utf8');
  if (opts.old === true) {
    const old = new Date(Date.now() - DONE_ENTRY_MAX_AGE_MS - 1_000);
    await utimes(fullPath, old, old);
  }
  return fullPath;
}

async function makeDriver(doneDir: string, sessions: readonly FakeSession[]) {
  const byId = new Map(sessions.map((session) => [session.id, session]));
  const broker = createHookFileBroker(doneDir, {
    maxEntries: DONE_BUFFER_CAP,
    maxAgeMs: DONE_ENTRY_MAX_AGE_MS,
    cleanupIntervalMs: 60_000,
  });
  await broker.start();
  brokers.push(broker);

  const tool = createAwaitStopHookTool({
    broker,
    getSessionMeta: (sessionId, callCtx) => {
      const session = byId.get(sessionId);
      if (session === undefined || session.windowId !== callCtx.ownerWindowId) {
        return null;
      }
      return {
        id: session.id,
        cwd: session.cwd,
        agentLabel: session.runner === 'cc' ? 'claude' : 'codex',
      };
    },
  });

  return {
    tool,
    awaitStopHook: (input: AwaitStopHookInput) =>
      tool.run(awaitStopHookInputSchema.parse(input), ctx),
    getSession: (id: string) => byId.get(id),
  };
}

describe('terminal.await_stop_hook', () => {
  // 边界(E83,E82/E30 数量上限族):hook 目录文件数上限。start 扫描经 opendir 惰性枚举,累计到
  // 上限(maxDirEntries,可注入)即停 + 告警,畸形/堆积目录不整目录读入。注入低上限 + 少量真文件验证。
  it('E83 hook 目录文件数超 maxDirEntries → start 扫描截断 + 告警', async () => {
    const doneDir = await makeDoneDir();
    for (let i = 0; i < 8; i += 1) {
      await writeFile(
        join(doneDir, `cc_1_s_${i}.jsonl`),
        '{"session_id":"s"}\n',
        'utf8',
      );
    }
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const broker = createHookFileBroker(doneDir, {
      maxEntries: 10,
      maxAgeMs: 60_000,
      cleanupIntervalMs: 60_000,
      maxDirEntries: 5, // 注入低上限:8 文件 > 5 → 截断
    });
    brokers.push(broker);
    await broker.start();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('truncated to 5'));
    warn.mockRestore();
  });

  it('should expose schema in tools/list with session_id timeout_sec include_raw and output fields', async () => {
    expect(createSessionInputSchema.safeParse({}).success).toBe(true);
    const doneDir = await makeDoneDir();
    const driver = await makeDriver(doneDir, [
      { id: 'term-1', windowId: 4, runner: 'cc', cwd: '/repo' },
    ]);

    expect(driver.tool.name).toBe(MCP_TOOL_AWAIT_STOP_HOOK);
    expect(
      awaitStopHookInputSchema.safeParse({ session_id: 'term-1' }).success,
    ).toBe(true);
    expect(awaitStopHookInputSchema.parse({ session_id: 'term-1' })).toMatchObject(
      {
        timeout_sec: 60,
        include_raw: false,
      },
    );
    expect(awaitStopHookInputSchema.safeParse({ session_id: '' }).success).toBe(
      false,
    );
    expect(
      awaitStopHookInputSchema.safeParse({
        session_id: 'term-1',
        timeout_sec: 601,
      }).success,
    ).toBe(false);
    // 边界(E203):tool.inputSchema 是 session_id 加 .max(SESSION_ID_MAX) 的 bounded 版(协议原 schema 无上限)。
    const longId = 'term-' + 'x'.repeat(300);
    expect(driver.tool.inputSchema.safeParse({ session_id: longId }).success).toBe(
      false,
    );
    expect(driver.tool.inputSchema.safeParse({ session_id: 'term-1' }).success).toBe(
      true,
    );
    expect(awaitStopHookInputSchema.safeParse({ session_id: longId }).success).toBe(
      true,
    ); // 协议原 schema 仍接受(本工具刻意收窄)
    // 边界(E204):公开 jsonSchema 同步声明 maxLength:256。
    expect(JSON.stringify(driver.tool.jsonSchema)).toContain('"maxLength":256');
    expect(
      awaitStopHookOutputSchema.safeParse({
        status: 'timeout',
        session_id: 'term-1',
        cli_session_id: null,
        turn_id: null,
        cwd: null,
        transcript_path: null,
        last_assistant_message: null,
        elapsed_ms: 0,
        raw: null,
      }).success,
    ).toBe(true);
  });

  it('should resolve cc and codex stop hooks, map fields, handle raw, unlink files, cap buffer, and cleanup old entries', async () => {
    const capDir = await makeDoneDir();
    for (let i = 0; i < DONE_BUFFER_CAP + 1; i += 1) {
      await writeFixture(capDir, {
        runner: 'cc',
        windowId: 99,
        cliSessionId: `cli-${i}`,
        ns: `${i}`,
        payload: { session_id: `cli-${i}`, cwd: '/other', event: 'stop' },
      });
    }
    const capBroker = createHookFileBroker(capDir, {
      maxEntries: DONE_BUFFER_CAP,
      maxAgeMs: DONE_ENTRY_MAX_AGE_MS,
    });
    await capBroker.start();
    brokers.push(capBroker);

    const doneDir = await makeDoneDir();
    const stale = await writeFixture(doneDir, {
      runner: 'cc',
      windowId: 4,
      cliSessionId: 'stale',
      ns: 'old',
      payload: { session_id: 'stale', cwd: '/repo', event: 'stop' },
      old: true,
    });
    const ccDefault = await writeFixture(doneDir, {
      runner: 'cc',
      windowId: 4,
      cliSessionId: 'claude-cli-1',
      ns: 'default',
      payload: {
        session_id: 'claude-cli-1',
        turn_id: 'turn-1',
        cwd: '/repo',
        event: 'stop',
        transcript_path: '/tmp/claude.jsonl',
        last_assistant_message: 'done',
      },
    });
    await writeFixture(doneDir, {
      runner: 'cc',
      windowId: 4,
      cliSessionId: 'claude-cli-2',
      ns: 'raw',
      payload: { session_id: 'claude-cli-2', cwd: '/repo', event: 'stop' },
    });
    await writeFixture(doneDir, {
      runner: 'codex',
      windowId: 4,
      ns: 'stop',
      payload: {
        session_id: 'codex-cli-1',
        cwd: '/repo',
        event: 'stop',
      },
    });

    const driver = await makeDriver(doneDir, [
      { id: 'term-cc', windowId: 4, runner: 'cc', cwd: '/repo' },
      { id: 'term-codex', windowId: 4, runner: 'codex', cwd: '/repo' },
    ]);

    const ccOut = await driver.awaitStopHook({ session_id: 'term-cc' });
    expect(ccOut).toMatchObject({
      status: 'stop',
      session_id: 'term-cc',
      cli_session_id: 'claude-cli-1',
      turn_id: 'turn-1',
      cwd: '/repo',
      transcript_path: '/tmp/claude.jsonl',
      last_assistant_message: 'done',
    });
    expect('raw' in ccOut).toBe(false);

    const rawOut = await driver.awaitStopHook({
      session_id: 'term-cc',
      include_raw: true,
    });
    expect(rawOut.raw).toMatchObject({ session_id: 'claude-cli-2' });

    await expect(
      driver.awaitStopHook({ session_id: 'term-codex' }),
    ).resolves.toMatchObject({
      status: 'stop',
      cli_session_id: 'codex-cli-1',
    });

    await vi.waitFor(async () => {
      await expect(readFile(ccDefault, 'utf8')).rejects.toThrow();
      await expect(readFile(stale, 'utf8')).rejects.toThrow();
    });
  });

  it('should return timeout after timeout_sec without throwing when no fixture arrives', async () => {
    vi.useFakeTimers();
    const doneDir = await makeDoneDir();
    const driver = await makeDriver(doneDir, [
      { id: 'term-timeout', windowId: 4, runner: 'cc', cwd: '/repo' },
    ]);

    const pending = driver.awaitStopHook({
      session_id: 'term-timeout',
      timeout_sec: 2,
    });
    await vi.advanceTimersByTimeAsync(2000);

    await expect(pending).resolves.toMatchObject({
      status: 'timeout',
      cli_session_id: null,
      elapsed_ms: 2000,
    });
  });

  // race(R3):start() 改为先 attach watcher 再补扫存量,关闭「扫描完成→watch 注册」之间写入
  // 的事件文件被漏掉的窗口。本例守护重排后存量文件(watch 前已存在)仍被 ingest(scan 路径未断)。
  it('R3 start() 先 watcher 后补扫:存量 stop-hook 文件(watch 前已存在)仍被 ingest', async () => {
    const doneDir = await makeDoneDir();
    await writeFixture(doneDir, {
      runner: 'cc',
      windowId: 4,
      cliSessionId: 'cli-preexist',
      ns: 'preexist',
      payload: {
        session_id: 'cli-preexist',
        turn_id: 'turn-pre',
        cwd: '/repo',
        event: 'stop',
        transcript_path: '/tmp/pre.jsonl',
        last_assistant_message: 'pre',
      },
    });
    const driver = await makeDriver(doneDir, [
      { id: 'term-1', windowId: 4, runner: 'cc', cwd: '/repo' },
    ]);
    await expect(
      driver.awaitStopHook({ session_id: 'term-1' }),
    ).resolves.toMatchObject({
      status: 'stop',
      cli_session_id: 'cli-preexist',
      cwd: '/repo',
    });
  });

  it('should throw TERMINAL_SESSION_NOT_FOUND for an unregistered session_id', async () => {
    const doneDir = await makeDoneDir();
    const driver = await makeDriver(doneDir, []);
    expect(driver.getSession('missing')).toBeUndefined();

    await expect(
      driver.awaitStopHook({ session_id: 'missing' }),
    ).rejects.toMatchObject({
      code: 'TERMINAL_SESSION_NOT_FOUND',
    });
  });

  it('should isolate waiters by windowId so a windowId=5 fixture does not unlock windowId=4', async () => {
    vi.useFakeTimers();
    const doneDir = await makeDoneDir();
    await writeFixture(doneDir, {
      runner: 'cc',
      windowId: 5,
      cliSessionId: 'wrong-window',
      ns: 'stop',
      payload: { session_id: 'wrong-window', cwd: '/repo', event: 'stop' },
    });
    const driver = await makeDriver(doneDir, [
      { id: 'term-w4', windowId: 4, runner: 'cc', cwd: '/repo' },
    ]);

    const pending = driver.awaitStopHook({
      session_id: 'term-w4',
      timeout_sec: 2,
    });
    await vi.advanceTimersByTimeAsync(2000);

    await expect(pending).resolves.toMatchObject({
      status: 'timeout',
      cli_session_id: null,
    });
  });

  it('should reject a second pending waiter for the same windowId runner and cwd with AWAIT_STOP_HOOK_ALREADY_PENDING', async () => {
    vi.useFakeTimers();
    const doneDir = await makeDoneDir();
    const driver = await makeDriver(doneDir, [
      { id: 'term-a', windowId: 4, runner: 'cc', cwd: '/repo' },
      { id: 'term-b', windowId: 4, runner: 'cc', cwd: '/repo' },
    ]);
    const first = driver.awaitStopHook({ session_id: 'term-a', timeout_sec: 2 });
    const second = driver.awaitStopHook({ session_id: 'term-b', timeout_sec: 2 });

    await expect(second).rejects.toMatchObject({
      code: 'AWAIT_STOP_HOOK_ALREADY_PENDING',
    });
    await vi.advanceTimersByTimeAsync(2000);
    await expect(first).resolves.toBeDefined();
  });

  it('should allow concurrent waiters for the same windowId and cwd when runner differs', async () => {
    vi.useFakeTimers();
    const doneDir = await makeDoneDir();
    const driver = await makeDriver(doneDir, [
      { id: 'term-cc', windowId: 4, runner: 'cc', cwd: '/repo' },
      { id: 'term-codex', windowId: 4, runner: 'codex', cwd: '/repo' },
    ]);

    const cc = driver.awaitStopHook({ session_id: 'term-cc', timeout_sec: 2 });
    const codex = driver.awaitStopHook({
      session_id: 'term-codex',
      timeout_sec: 2,
    });
    await vi.advanceTimersByTimeAsync(2000);

    await expect(Promise.all([cc, codex])).resolves.toHaveLength(2);
  });

  it('preserves a fresh unparseable hook file (possible incomplete write) instead of deleting it', async () => {
    const doneDir = await makeDoneDir();
    // 模拟 `cat >` 写入尚未完成:文件已创建但内容是截断的非法 JSON。
    const partial = join(doneDir, 'cc_4_partial_stop.jsonl');
    await writeFile(partial, '{ "session_id": "claude', 'utf8');

    const broker = createHookFileBroker(doneDir, {
      maxEntries: DONE_BUFFER_CAP,
      maxAgeMs: DONE_ENTRY_MAX_AGE_MS,
      cleanupIntervalMs: 60_000,
    });
    await broker.start(); // start 的 readdir 会 ingest 这个文件
    brokers.push(broker);

    // 解析失败的新文件必须被保留(等内容写完后由后续 watch 事件重试),
    // 不能在内容到达前被删除 → 否则真实 stop 事件永久丢失(审计 P1)。
    await expect(readFile(partial, 'utf8')).resolves.toBe('{ "session_id": "claude');
  });

  // 边界(E26,E18/E20/E24 兄弟):超大 hook 文件(畸形/异常 CLI 输出)绝不整块读入。
  // ingestFile 在 stat 后按 size 拦截 → 标 processed + unlink 隔离,不读不解析不缓冲。
  // 该上限反向钳住下游 raw / last_assistant_message / include_raw 字节数。
  it('E26 超大 hook 文件(>1MiB)被隔离丢弃:从不投递且从磁盘删除', async () => {
    vi.useFakeTimers();
    const doneDir = await makeDoneDir();
    const oversizePath = join(doneDir, 'cc_4_oversize_stop.jsonl');
    // 合法 JSON 但 last_assistant_message 灌到 >1MiB,模拟异常/畸形 CLI 输出。
    const oversize = JSON.stringify({
      session_id: 'cli-oversize',
      cwd: '/repo',
      last_assistant_message: 'x'.repeat(1024 * 1024 + 1024),
    });
    expect(oversize.length).toBeGreaterThan(1024 * 1024);
    await writeFile(oversizePath, oversize, 'utf8');

    const driver = await makeDriver(doneDir, [
      { id: 'term-1', windowId: 4, runner: 'cc', cwd: '/repo' },
    ]);

    const pending = driver.awaitStopHook({
      session_id: 'term-1',
      timeout_sec: 2,
    });
    await vi.advanceTimersByTimeAsync(2000);
    // 超大文件被隔离 → 从不进 buffered → await 超时(而非 status:'stop' 带 cli-oversize)。
    await expect(pending).resolves.toMatchObject({
      status: 'timeout',
      cli_session_id: null,
    });
    // 隔离文件最终被 unlink 删除(标 processed,不重试)。
    await expect(readFile(oversizePath, 'utf8')).rejects.toThrow();
  });

  // 边界(E150,E26/E83 数量上限族):buffered 数组按"条数"上限(maxEntries=500)钳制,但每条可
  // 持近 1MiB 原始 JSON → 仅按条数封顶最坏 ~500MiB 常驻。补"总字节"上限(maxBufferedBytes,可注入),
  // 与条数上限同一 while 循环双闸 FIFO 淘汰。注入极小字节预算 + 多条大 entry 验证:仅最近一条幸存。
  it('E150 buffered 总字节超 maxBufferedBytes → FIFO 淘汰旧 entry(仅 1 条幸存)', async () => {
    vi.useFakeTimers();
    const doneDir = await makeDoneDir();
    // 3 条匹配 term-cc 的大 entry,各 ~2KiB;预算 3000 字节 → 任意两条即超 → 始终只保 1 条。
    const pad = 'y'.repeat(2000);
    for (const ns of ['a', 'b', 'c']) {
      await writeFixture(doneDir, {
        runner: 'cc',
        windowId: 4,
        cliSessionId: `cli-${ns}`,
        ns,
        payload: { session_id: `cli-${ns}`, cwd: '/repo', last_assistant_message: pad },
      });
    }

    const byId = new Map([
      ['term-cc', { id: 'term-cc', windowId: 4, cwd: '/repo', agentLabel: 'claude' }],
    ]);
    const broker = createHookFileBroker(doneDir, {
      maxEntries: DONE_BUFFER_CAP, // 条数远未触及 → 字节预算是唯一约束
      maxAgeMs: DONE_ENTRY_MAX_AGE_MS,
      cleanupIntervalMs: 60_000,
      maxBufferedBytes: 3000,
    });
    await broker.start(); // start 扫描即 ingest 3 条 → 字节淘汰至 1 条
    brokers.push(broker);
    const tool = createAwaitStopHookTool({
      broker,
      getSessionMeta: (sessionId, callCtx) => {
        const s = byId.get(sessionId);
        return s !== undefined && s.windowId === callCtx.ownerWindowId
          ? { id: s.id, cwd: s.cwd, agentLabel: s.agentLabel }
          : null;
      },
    });
    const run = (input: AwaitStopHookInput) =>
      tool.run(awaitStopHookInputSchema.parse(input), ctx);

    // 第一次 await:幸存的那 1 条立即兑付(status:'stop')。
    const first = await run({ session_id: 'term-cc', timeout_sec: 5 });
    expect(first).toMatchObject({ status: 'stop' });

    // 第二次 await:buffer 已空(只有 1 条幸存,已被上一次消费)→ 超时。
    // 若无字节淘汰,3 条全部缓冲 → 此处会再次命中 status:'stop'。
    const second = run({ session_id: 'term-cc', timeout_sec: 1 });
    await vi.advanceTimersByTimeAsync(1000);
    await expect(second).resolves.toMatchObject({ status: 'timeout' });
  });

  // 边界(E151,E148 兄弟入口):await_stop_hook 的 session_id 仅 minLength;not-found 时不可把
  // 超长原串原样拼进错误消息(放大 JSON-RPC error/日志/内存)。复用共享 truncateSessionIdForEcho。
  it('E151 超长 session_id not-found → 错误消息截断(不回显超长原串)', async () => {
    const doneDir = await makeDoneDir();
    const driver = await makeDriver(doneDir, [
      { id: 'term-1', windowId: 4, runner: 'cc', cwd: '/repo' },
    ]);
    const longId = 'z'.repeat(5000);
    const err = await driver
      .awaitStopHook({ session_id: longId })
      .catch((e: unknown) => e as Error);
    expect((err as { code?: string }).code).toBe('TERMINAL_SESSION_NOT_FOUND');
    expect(err.message).toContain('…');
    expect(err.message.length).toBeLessThan(400);
    expect(err.message).not.toContain('z'.repeat(300));
  });
});
