// @vitest-environment node
// BDD: debug-adapter-crash / adapter 意外退出或连接意外断开 → DebugService 结束会话、结算在途调用、通知 renderer。见同目录 README。

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DebugService,
  type DebugDapClientLike,
} from '../../../electron/main/services/debug.service';
import * as debugSessions from '../../../electron/main/services/debug-sessions.service';
import type {
  DapEventMessage,
  DapJson,
  DapResponseMessage,
  DapServerExit,
} from '../../../electron/main/services/dap-client';
import type { DebugViewEvent } from '../../../electron/shared/debug-view-channels';

class FakeClient implements DebugDapClientLike {
  readonly serverPid = 4242;
  serverExited = false;
  readonly requests: string[] = [];
  private readonly handlers = new Map<string, Set<(event: DapEventMessage) => void>>();
  private readonly exitListeners: Array<(exit: DapServerExit) => void> = [];
  private readonly lostListeners = new Set<() => void>();
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
  onServerExit(listener: (exit: DapServerExit) => void): void {
    this.exitListeners.push(listener);
  }
  onConnectionLost(listener: () => void): () => void {
    this.lostListeners.add(listener);
    return () => this.lostListeners.delete(listener);
  }
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
  async sendRequest(command: string): Promise<DapResponseMessage> {
    this.requests.push(command);
    if (command === 'initialize') queueMicrotask(() => this.emit('initialized', {}));
    const body: DapJson = command === 'threads' ? { threads: [{ id: 0, name: 'main' }] } : {};
    return { seq: this.seq++, type: 'response', request_seq: this.seq, success: true, command, body };
  }
  sendRequestNoWait(command: string): void {
    this.requests.push(command);
  }
  async dispose(): Promise<void> {}
  disposeWhenIdle(): Promise<void> {
    return this.dispose();
  }
  emit(eventName: string, body: DapJson): void {
    const event: DapEventMessage = { seq: this.seq++, type: 'event', event: eventName, body };
    for (const callback of this.handlers.get(eventName) ?? []) callback(event);
  }
  /** 模拟 adapter 进程退出。 */
  exit(code: number | null, signal: string | null): void {
    this.serverExited = true;
    for (const l of this.exitListeners.splice(0)) l({ code, signal });
  }
  /** 模拟连接意外断开。 */
  loseConnection(): void {
    for (const l of [...this.lostListeners]) l();
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
  const events: DebugViewEvent[] = [];
  service.setEventSink({ emit: (_win, event) => events.push(event) });
  const launch = async () => {
    const { session_id } = await service.launchSession(
      { program: '/repo/app.js', cwd: '/repo' },
      { ownerWindowId: 7, controllerToken: 'agent-a' },
    );
    return { sessionId: session_id, client: clients[clients.length - 1]! };
  };
  const terminatedEvents = () => events.filter((e) => e.type === 'terminated');
  return { service, launch, events, terminatedEvents };
}

afterEach(() => {
  debugSessions._reset();
});

describe('adapter 意外退出 → 结束会话', () => {
  it('被信号杀掉:在途 wait_for_stop 明确失败,list_sessions 标 terminated,renderer 收到带说明的 terminated', async () => {
    const { service, launch, terminatedEvents } = setup();
    const { sessionId, client } = await launch();
    const waiting = service.waitForStop(sessionId, { timeoutMs: 30_000 });
    await vi.waitFor(() => expect(client.requests).toContain('launch'));

    client.exit(null, 'SIGKILL');

    await expect(waiting).rejects.toThrow(/debug adapter process has terminated unexpectedly \(signal: SIGKILL\)/);
    await expect(service.waitForStop(sessionId, { timeoutMs: 30_000 })).rejects.toThrow(/terminated unexpectedly/);
    expect(service.listSessions().find((s) => s.session_id === sessionId)?.state).toBe('terminated');
    expect(terminatedEvents()).toEqual([{ type: 'terminated', sessionId, adapterCrashed: 'signal: SIGKILL' }]);
  });

  it('非 0 退出码 → 说明带 exit code', async () => {
    const { launch, terminatedEvents } = setup();
    const { sessionId, client } = await launch();
    client.exit(3, null);
    expect(terminatedEvents()).toEqual([{ type: 'terminated', sessionId, adapterCrashed: 'exit code: 3' }]);
  });

  it('连接意外断开(早于进程 exit 到达)→ 同样结束;随后的 exit 不再重复推送', async () => {
    const { service, launch, terminatedEvents } = setup();
    const { sessionId, client } = await launch();
    client.loseConnection();
    client.exit(null, 'SIGKILL');
    expect(terminatedEvents()).toEqual([{ type: 'terminated', sessionId, adapterCrashed: 'connection closed' }]);
    expect(service.listSessions()[0]?.state).toBe('terminated');
  });

  it('0 退出 → 会话结束但不提示(VSCode:正常退出)', async () => {
    const { service, launch, terminatedEvents } = setup();
    const { sessionId, client } = await launch();
    client.exit(0, null);
    expect(terminatedEvents()).toEqual([{ type: 'terminated', sessionId }]);
    expect(service.listSessions()[0]?.state).toBe('terminated');
  });

  it('会话已正常结束(terminated 事件之后)adapter 再退出 → 不当作意外', async () => {
    const { launch, terminatedEvents } = setup();
    const { sessionId, client } = await launch();
    client.emit('terminated', {});
    client.loseConnection();
    client.exit(null, 'SIGTERM');
    expect(terminatedEvents()).toEqual([{ type: 'terminated', sessionId }]);
  });

  it('本端 disconnect 拆除会话时杀 adapter → 不当作意外', async () => {
    const { service, launch, terminatedEvents } = setup();
    const { sessionId, client } = await launch();
    const done = service.disconnect(sessionId);
    client.loseConnection();
    client.exit(null, 'SIGTERM');
    await done;
    expect(terminatedEvents().some((e) => 'adapterCrashed' in e)).toBe(false);
  });

  it('adapter 没了但 debuggee 未必结束 → 其 pid 记录保留给 teardown 回收', async () => {
    const { launch } = setup();
    const { sessionId, client } = await launch();
    client.emit('process', { systemProcessId: 5555 });
    client.exit(null, 'SIGKILL');
    expect(debugSessions.get(sessionId)?.systemProcessIds).toEqual([5555]);
  });
});
