// @vitest-environment node
// DebugService:用户接管(pause / 删除断点 / 窗口级用户断点)、程序输出缓冲与 read_output、started 事件。见同目录 README。

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DEBUG_OUTPUT_FLUSH_MS,
  DebugService,
  type DebugDapClientLike,
  type DebugEventSink,
} from '../../../electron/main/services/debug.service';
import * as debugSessions from '../../../electron/main/services/debug-sessions.service';
import type { DapEventMessage, DapJson, DapResponseMessage } from '../../../electron/main/services/dap-client';
import {
  DEBUG_OUTPUT_ENTRIES_MAX,
  type DebugUserBreakpointsEvent,
  type DebugViewEvent,
} from '../../../electron/shared/debug-view-channels';

class FakeClient implements DebugDapClientLike {
  readonly serverPid = 4242;
  readonly requests: Array<{ command: string; args: DapJson }> = [];
  /** setBreakpoints 响应里的行号校正(adapter 把断点挪到最近的可执行行)。 */
  adjustLine: (line: number) => number = (line) => line;
  private readonly handlers = new Map<string, Set<(event: DapEventMessage) => void>>();
  private seq = 1;

  async spawnServer(): Promise<this> {
    return this;
  }
  async connectToServer(): Promise<this> {
    return this;
  }
  createChildSession(): DebugDapClientLike {
    throw new Error('no child sessions in this fake');
  }
  setStartDebuggingHandler(): void {}
  on(eventName: string, callback: (event: DapEventMessage) => void): () => void {
    const set = this.handlers.get(eventName) ?? new Set();
    set.add(callback);
    this.handlers.set(eventName, set);
    return () => set.delete(callback);
  }
  waitForEvent(eventName: string): Promise<DapEventMessage> {
    return new Promise((resolve) => {
      const off = this.on(eventName, (event) => {
        off();
        resolve(event);
      });
    });
  }
  async sendRequest(command: string, args: DapJson = {}): Promise<DapResponseMessage> {
    this.requests.push({ command, args });
    if (command === 'initialize') queueMicrotask(() => this.emit('initialized', {}));
    let body: DapJson = {};
    if (command === 'setBreakpoints') {
      const requested = (args as { breakpoints?: Array<{ line: number }> }).breakpoints ?? [];
      body = { breakpoints: requested.map((bp, i) => ({ id: i + 1, verified: true, line: this.adjustLine(bp.line) })) };
    }
    if (command === 'threads') body = { threads: [{ id: 0, name: 'main' }] };
    return { seq: this.seq++, type: 'response', request_seq: this.seq, success: true, command, body };
  }
  sendRequestNoWait(command: string, args: DapJson = {}): void {
    this.requests.push({ command, args });
  }
  async dispose(): Promise<void> {}
  disposeWhenIdle(): Promise<void> {
    return this.dispose();
  }
  emit(eventName: string, body: DapJson): void {
    const event: DapEventMessage = { seq: this.seq++, type: 'event', event: eventName, body };
    for (const callback of this.handlers.get(eventName) ?? []) callback(event);
  }
  commands(): string[] {
    return this.requests.map((r) => r.command);
  }
}

const PROCESS_OPS = {
  processInfo: async () => ({ pid: 4242, ppid: 1, pgid: 4242, command: 'fake-adapter' }),
  pidsInProcessGroup: async () => [],
  terminateProcessGroup: async () => [],
};

function setup() {
  const clients: FakeClient[] = [];
  const service = new DebugService({
    createDapClient: () => {
      const client = new FakeClient();
      clients.push(client);
      return client;
    },
    processOps: PROCESS_OPS,
    workspace: { getWorkspaceRoot: () => '/', realpath: async (p) => p },
    resolveNodeRuntime: async () => '/usr/bin/node',
  });
  const sessionEvents: Array<{ win: number; event: DebugViewEvent }> = [];
  const windowEvents: Array<{ win: number; event: DebugUserBreakpointsEvent }> = [];
  const sink: DebugEventSink = {
    emit: (win, event) => sessionEvents.push({ win, event }),
    emitWindowEvent: (win, event) => windowEvents.push({ win, event }),
  };
  service.setEventSink(sink);
  const launch = async (win = 7) => {
    const { session_id } = await service.launchSession(
      { program: '/repo/app.js', cwd: '/repo' },
      { ownerWindowId: win, controllerToken: 'agent-a' },
    );
    return { sessionId: session_id, client: clients[clients.length - 1]! };
  };
  return { service, clients, sessionEvents, windowEvents, launch };
}

/** 让程序起跑(wait_for_stop 即起跑)并停在一个断点上。 */
async function runAndStop(service: DebugService, sessionId: string, client: FakeClient): Promise<void> {
  const waiting = service.waitForStop(sessionId, { timeoutMs: 5_000 });
  await vi.waitFor(() => expect(client.commands()).toContain('launch'));
  client.emit('stopped', { reason: 'breakpoint', threadId: 0, hitBreakpointIds: [1] });
  await waiting;
}

afterEach(() => {
  debugSessions._reset();
  vi.useRealTimers();
});

describe('会话建立即通知(started)', () => {
  it('launch 完成 → 向 owner 窗口推 started(带会话名),面板 / 工具栏立刻显示运行中的会话', async () => {
    const { sessionEvents, launch } = setup();
    const { sessionId } = await launch(7);
    expect(sessionEvents).toEqual([{ win: 7, event: { type: 'started', sessionId, label: 'app.js' } }]);
  });
});

describe('暂停(VSCode F6)', () => {
  it('运行中 → 对活动线程发 DAP pause(线程 id 0 合法)', async () => {
    const { service, launch } = setup();
    const { sessionId, client } = await launch();
    await service.continue(sessionId, {}); // 起跑
    await expect(service.pause(sessionId)).resolves.toEqual({ paused: true });
    expect(client.requests.find((r) => r.command === 'pause')?.args).toEqual({ threadId: 0 });
  });

  it('已停住 → 无操作;程序还没起跑 → 报错(没有可暂停的线程)', async () => {
    const { service, launch } = setup();
    const { sessionId, client } = await launch();
    await expect(service.pause(sessionId)).rejects.toMatchObject({ code: 'BAD_INPUT' });
    await runAndStop(service, sessionId, client);
    await expect(service.pause(sessionId)).resolves.toEqual({ paused: false });
    expect(client.commands()).not.toContain('pause');
  });
});

describe('窗口级用户断点(编辑器 gutter)', () => {
  it('无会话时设的断点 → 记下并推 user-breakpoints-changed;下一个 launch 在程序起跑前下发', async () => {
    const { service, windowEvents, launch } = setup();
    await service.setUserBreakpoint(7, { file: '/repo/app.js', line: 3, enabled: true });
    expect(windowEvents).toEqual([
      { win: 7, event: { type: 'user-breakpoints-changed', breakpoints: [{ file: '/repo/app.js', line: 3 }] } },
    ]);
    expect(service.userBreakpointSnapshot(7)).toEqual([{ file: '/repo/app.js', line: 3 }]);
    expect(service.userBreakpointSnapshot(8)).toEqual([]);

    const { client } = await launch(7);
    const commands = client.commands();
    const set = client.requests.find((r) => r.command === 'setBreakpoints');
    expect(set?.args).toMatchObject({ source: { path: '/repo/app.js' }, breakpoints: [{ line: 3 }] });
    // 起跑(configurationDone / launch)推迟到 wait_for_stop / continue:断点先于程序就位
    expect(commands).not.toContain('launch');
    expect(commands).not.toContain('configurationDone');
  });

  it('别的窗口的用户断点不下发给本窗口的会话', async () => {
    const { service, launch } = setup();
    await service.setUserBreakpoint(9, { file: '/repo/app.js', line: 3, enabled: true });
    const { client } = await launch(7);
    expect(client.commands()).not.toContain('setBreakpoints');
  });

  it('已有会话(含 agent 启动的)→ 即时下发;删除时连同 adapter 校正到该行的断点一起删,并从用户断点里移除', async () => {
    const { service, sessionEvents, launch } = setup();
    const { sessionId, client } = await launch(7);
    client.adjustLine = (line) => (line === 4 ? 5 : line); // 空行 4 → 校正到 5
    await service.setUserBreakpoint(7, { file: '/repo/app.js', line: 4, enabled: true });
    expect(sessionEvents.at(-1)?.event).toMatchObject({
      type: 'breakpoints-changed',
      sessionId,
      breakpoints: [{ file: '/repo/app.js', line: 5, verified: true }],
    });

    // 用户点的是红点所在的校正后行 5
    client.requests.length = 0;
    await service.setUserBreakpoint(7, { file: '/repo/app.js', line: 5, enabled: false });
    expect(client.requests.find((r) => r.command === 'setBreakpoints')?.args).toMatchObject({ breakpoints: [] });
    expect(sessionEvents.at(-1)?.event).toMatchObject({ type: 'breakpoints-changed', breakpoints: [] });
    expect(service.userBreakpointSnapshot(7)).toEqual([]);
  });

  it('删除 agent 设的断点:只发剩余集合(同文件其它断点保留)', async () => {
    const { service, launch } = setup();
    const { sessionId, client } = await launch(7);
    await service.setBreakpoints(sessionId, { file: '/repo/app.js', line: 2 });
    await service.setBreakpoints(sessionId, { file: '/repo/app.js', line: 8 });
    await expect(service.removeBreakpoint(sessionId, { file: '/repo/app.js', line: 2 })).resolves.toEqual({
      removedLines: [2],
    });
    expect(client.requests.at(-1)).toMatchObject({ command: 'setBreakpoints', args: { breakpoints: [{ line: 8 }] } });
  });

  it('只有 JS / TS 文件能设(VSCode allowBreakpointsEverywhere=false):别的文件 BAD_INPUT、不记、不推;删除照常', async () => {
    const { service, windowEvents } = setup();
    await expect(service.setUserBreakpoint(7, { file: '/repo/README.md', line: 1, enabled: true })).rejects.toMatchObject({
      code: 'BAD_INPUT',
    });
    expect(service.userBreakpointSnapshot(7)).toEqual([]);
    expect(windowEvents).toEqual([]);
    await expect(service.setUserBreakpoint(7, { file: '/repo/README.md', line: 1, enabled: false })).resolves.toBeUndefined();
    await service.setUserBreakpoint(7, { file: '/repo/lib.mts', line: 2, enabled: true });
    expect(service.userBreakpointSnapshot(7)).toEqual([{ file: '/repo/lib.mts', line: 2 }]);
  });

  it('launch 只下发能设断点的文件的用户断点(列表里万一有别的文件也不发给 adapter)', async () => {
    const { service, launch } = setup();
    await service.setUserBreakpoint(7, { file: '/repo/app.js', line: 3, enabled: true });
    (service as unknown as { userBreakpoints: Map<number, unknown[]> }).userBreakpoints
      .get(7)!
      .push({ file: '/repo/notes.md', line: 1 });
    const { client } = await launch(7);
    const sets = client.requests.filter((r) => r.command === 'setBreakpoints');
    expect(sets).toHaveLength(1);
    expect(sets[0]!.args).toMatchObject({ source: { path: '/repo/app.js' } });
  });

  it('关窗(killByOwner)清掉该窗口的用户断点', async () => {
    const { service } = setup();
    await service.setUserBreakpoint(7, { file: '/repo/app.js', line: 3, enabled: true });
    await service.killByOwner(7, 'window-closed');
    expect(service.userBreakpointSnapshot(7)).toEqual([]);
  });
});

describe('程序输出:环形缓冲 + 合批推送 + read_output', () => {
  it('output 事件去 ANSI、telemetry 不收、category 缺省 console;50ms 合批成一个 output 事件推给 renderer', async () => {
    const { sessionEvents, launch, service } = setup();
    const { sessionId, client } = await launch(7);
    vi.useFakeTimers();
    client.emit('output', { category: 'stdout', output: '\u001b[32mhello\u001b[0m\n' });
    client.emit('output', { category: 'telemetry', output: '{"x":1}' });
    client.emit('output', { output: 'adapter note\n' });
    client.emit('output', { category: 'stderr', output: 'boom\n' });
    expect(sessionEvents.filter((e) => e.event.type === 'output')).toEqual([]);
    vi.advanceTimersByTime(DEBUG_OUTPUT_FLUSH_MS);
    const outputs = sessionEvents.filter((e) => e.event.type === 'output');
    expect(outputs).toEqual([
      {
        win: 7,
        event: {
          type: 'output',
          sessionId,
          entries: [
            { seq: 0, category: 'stdout', output: 'hello\n' },
            { seq: 1, category: 'console', output: 'adapter note\n' },
            { seq: 2, category: 'stderr', output: 'boom\n' },
          ],
        },
      },
    ]);
    expect(service.readOutput(sessionId, { sinceSeq: 0, maxBytes: 65536 })).toEqual({
      entries: [
        { seq: 0, category: 'stdout', output: 'hello\n' },
        { seq: 1, category: 'console', output: 'adapter note\n' },
        { seq: 2, category: 'stderr', output: 'boom\n' },
      ],
      next_seq: 3,
      truncated: false,
      has_more: false,
    });
  });

  it('read_output:since_seq 增量读、max_bytes 截断(至少一条,单条超限截短)、has_more', async () => {
    const { service, launch } = setup();
    const { sessionId, client } = await launch(7);
    for (const text of ['aaaa', 'bbbb', 'cccc']) client.emit('output', { category: 'stdout', output: text });
    const first = service.readOutput(sessionId, { sinceSeq: 0, maxBytes: 9 });
    expect(first).toEqual({
      entries: [
        { seq: 0, category: 'stdout', output: 'aaaa' },
        { seq: 1, category: 'stdout', output: 'bbbb' },
      ],
      next_seq: 2,
      truncated: false,
      has_more: true,
    });
    expect(service.readOutput(sessionId, { sinceSeq: first.next_seq, maxBytes: 2 })).toEqual({
      entries: [{ seq: 2, category: 'stdout', output: 'cc' }],
      next_seq: 3,
      truncated: false,
      has_more: false,
    });
    // 读到末尾:没有新输出时 next_seq 不动
    expect(service.readOutput(sessionId, { sinceSeq: 3, maxBytes: 100 })).toEqual({
      entries: [],
      next_seq: 3,
      truncated: false,
      has_more: false,
    });
  });

  it('超过条数上限丢最旧:从被丢弃的位置读 → truncated', async () => {
    const { service, launch } = setup();
    const { sessionId, client } = await launch(7);
    for (let i = 0; i <= DEBUG_OUTPUT_ENTRIES_MAX; i += 1) client.emit('output', { category: 'stdout', output: 'x' });
    const page = service.readOutput(sessionId, { sinceSeq: 0, maxBytes: 4 });
    expect(page.truncated).toBe(true);
    expect(page.entries[0]?.seq).toBe(1);
    expect(service.readOutput(sessionId, { sinceSeq: 1, maxBytes: 4 }).truncated).toBe(false);
  });

  it('程序结束:未推的输出先推完再推 terminated;结束后仍可 read_output', async () => {
    const { service, sessionEvents, launch } = setup();
    const { sessionId, client } = await launch(7);
    client.emit('output', { category: 'stdout', output: 'last words\n' });
    client.emit('terminated', {});
    expect(sessionEvents.slice(-2).map((e) => e.event.type)).toEqual(['output', 'terminated']);
    expect(service.readOutput(sessionId, { sinceSeq: 0, maxBytes: 100 }).entries).toEqual([
      { seq: 0, category: 'stdout', output: 'last words\n' },
    ]);
  });

  it('subscribe 快照带最近的输出(重载后控制台不清空)', async () => {
    const { service, launch } = setup();
    const { sessionId, client } = await launch(7);
    client.emit('output', { category: 'stdout', output: 'hi\n' });
    expect(service.viewSnapshot(7)).toEqual([
      expect.objectContaining({ session_id: sessionId, output: [{ seq: 0, category: 'stdout', output: 'hi\n' }] }),
    ]);
  });
});
