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
    awaitStopHook: (input: AwaitStopHookInput) => tool.run(input, ctx),
    getSession: (id: string) => byId.get(id),
  };
}

describe('terminal.await_stop_hook', () => {
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
});
