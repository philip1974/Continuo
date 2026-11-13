// @vitest-environment node

import { execFile as execFileCb } from 'node:child_process';
import { existsSync } from 'node:fs';
import { copyFile, cp, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  DebugService,
  type DebugDapClientLike,
  type DebugProcessOps,
  type DebugVariable,
  type DebugWorkspaceGuard,
} from '../services/debug.service';
import * as debugSessions from '../services/debug-sessions.service';
import type {
  DapEventMessage,
  DapJson,
  DapRequestMessage,
  DapResponseMessage,
} from '../services/dap-client';
import type { DebugViewEvent } from '../../shared/debug-view-channels';

const execFile = promisify(execFileCb);

class FakeDapClient implements DebugDapClientLike {
  readonly socketPath = `fake-${Math.random().toString(16).slice(2)}.sock`;
  readonly tcpPort = 0;
  readonly serverPid: number;
  readonly requestLog: Array<{ command: string; args: DapJson }> = [];
  readonly children: FakeDapClient[] = [];
  disconnectRequests = 0;
  disposeCalls = 0;
  private seq = 1;
  private startDebuggingHandler:
    | ((
        request: DapRequestMessage,
        client: DebugDapClientLike,
      ) => Promise<DapJson | undefined> | DapJson | undefined)
    | null = null;
  private readonly handlers = new Map<string, Set<(event: DapEventMessage) => void>>();

  constructor(serverPid: number) {
    this.serverPid = serverPid;
  }

  async spawnServer(): Promise<this> {
    return this;
  }

  async connectToServer(): Promise<this> {
    return this;
  }

  createChildSession(): DebugDapClientLike {
    const child = new FakeDapClient(this.serverPid + 100 + this.children.length);
    this.children.push(child);
    return child;
  }

  setStartDebuggingHandler(
    handler:
      | ((
          request: DapRequestMessage,
          client: DebugDapClientLike,
        ) => Promise<DapJson | undefined> | DapJson | undefined)
      | null,
  ): void {
    this.startDebuggingHandler = handler;
  }

  on(eventName: string, callback: (event: DapEventMessage) => void): () => void {
    const callbacks = this.handlers.get(eventName) ?? new Set<(event: DapEventMessage) => void>();
    callbacks.add(callback);
    this.handlers.set(eventName, callbacks);
    return () => callbacks.delete(callback);
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
    this.requestLog.push({ command, args });
    if (command === 'initialize') {
      queueMicrotask(() => this.emit('initialized', {}));
    }
    if (command === 'continue' || command === 'next' || command === 'stepIn' || command === 'stepOut') {
      queueMicrotask(() => this.emit('continued', { allThreadsContinued: true }));
    }
    if (command === 'disconnect') {
      this.disconnectRequests += 1;
    }
    return {
      seq: this.seq++,
      type: 'response',
      request_seq: this.seq,
      success: true,
      command,
      body: this.responseBody(command),
    };
  }

  sendRequestNoWait(command: string, args: DapJson = {}): number {
    this.requestLog.push({ command, args });
    return this.seq++;
  }

  async dispose(): Promise<void> {
    this.disposeCalls += 1;
  }

  async triggerStartDebugging(configuration: DapJson): Promise<void> {
    if (!this.startDebuggingHandler) throw new Error('no startDebugging handler');
    await this.startDebuggingHandler(
      {
        type: 'request',
        command: 'startDebugging',
        arguments: { request: 'launch', configuration },
      },
      this,
    );
  }

  emit(eventName: string, body: DapJson): void {
    const event: DapEventMessage = {
      seq: this.seq++,
      type: 'event',
      event: eventName,
      body,
    };
    for (const callback of this.handlers.get(eventName) ?? []) {
      callback(event);
    }
  }

  private responseBody(command: string): DapJson {
    if (command === 'threads') {
      return { threads: [{ id: 1, name: 'main' }] };
    }
    if (command === 'continue') {
      // js-debug 真实行为:只续单线程,allThreadsContinued=false。
      return { allThreadsContinued: false };
    }
    if (command === 'stackTrace') {
      return {
        stackFrames: [
          { id: 7, name: 'runClosure', source: { path: '/fixture.ts' }, line: 14, column: 1 },
        ],
        totalFrames: 1,
      };
    }
    if (command === 'scopes') {
      return { scopes: [{ name: 'Local', variablesReference: 44, expensive: false }] };
    }
    if (command === 'variables') {
      return {
        variables: [
          { name: 'nested', value: 'Object', variablesReference: 45 },
          { name: 'sum', value: '21', variablesReference: 0 },
        ],
      };
    }
    if (command === 'evaluate') {
      return { result: '42', variablesReference: 0 };
    }
    return {};
  }
}

// 默认宽松 workspace guard:root='/' → 任意绝对路径在内;realpath 恒等(测试文件不必真实存在)。
const PERMISSIVE_WORKSPACE: DebugWorkspaceGuard = {
  getWorkspaceRoot: () => '/',
  realpath: async (p) => p,
};

function makeFakeService(
  parent = new FakeDapClient(1001),
  workspace: DebugWorkspaceGuard = PERMISSIVE_WORKSPACE,
) {
  const processOps: DebugProcessOps = {
    processInfo: vi.fn(async () => ({ pid: 1001, ppid: process.pid, pgid: 1001, command: 'fake-adapter' })),
    pidsInProcessGroup: vi.fn(async () => [
      { pid: 1001, pgid: 1001, command: 'fake-adapter' },
      { pid: 2002, pgid: 1001, command: 'fake-debuggee' },
    ]),
    terminateProcessGroup: vi.fn(async () => []),
  };
  const service = new DebugService({
    createDapClient: () => parent,
    processOps,
    workspace,
  });
  return { service, parent, processOps };
}

afterEach(() => {
  debugSessions._reset();
});

describe('DebugService fake adapter · launch / 子会话 / 终止 的错误路径', () => {
  const ctx = { ownerWindowId: 8, controllerToken: 'agent-b' };

  it('adapter 启动失败(spawnServer reject)→ 释放 client,不登记 session', async () => {
    const parent = new FakeDapClient(1001);
    parent.spawnServer = async () => {
      throw new Error('DAP server readiness timed out');
    };
    const { service } = makeFakeService(parent);

    await expect(service.launchSession({ program: '/fixture.js', cwd: '/work' }, ctx)).rejects.toThrow(
      /readiness timed out/,
    );
    expect(parent.disposeCalls).toBe(1); // 否则 detached 的 adapter 进程 + socket 文件成孤儿
    expect(service.listSessions()).toEqual([]);
  });

  it('登记之后 initialize 失败 → 拆除该 session(调用方拿不到 session_id,无法自己清)', async () => {
    const parent = new FakeDapClient(1001);
    const original = parent.sendRequest.bind(parent);
    parent.sendRequest = async (command, args) => {
      if (command === 'initialize') throw new Error('initialize timed out');
      return original(command, args);
    };
    const { service, processOps } = makeFakeService(parent);

    await expect(service.launchSession({ program: '/fixture.js', cwd: '/work' }, ctx)).rejects.toThrow(
      /initialize timed out/,
    );
    expect(service.listSessions()).toEqual([]);
    expect(processOps.terminateProcessGroup).toHaveBeenCalled();
  });

  it('子会话建立失败 → activeClient 仍是父 client(后续请求不发给死掉的 child)', async () => {
    const parent = new FakeDapClient(1001);
    const { service } = makeFakeService(parent);
    const { session_id: sessionId } = await service.launchSession(
      { program: '/fixture.js', cwd: '/work' },
      ctx,
    );
    const createChild = parent.createChildSession.bind(parent);
    parent.createChildSession = () => {
      const child = createChild() as FakeDapClient;
      child.connectToServer = async () => {
        throw new Error('connect ECONNREFUSED');
      };
      return child;
    };

    await expect(parent.triggerStartDebugging({ type: 'pwa-node' })).rejects.toThrow(/ECONNREFUSED/);
    parent.emit('stopped', { reason: 'breakpoint', threadId: 1 });
    await service.stackTrace(sessionId, {});
    expect(parent.requestLog.some((r) => r.command === 'stackTrace')).toBe(true);
    expect(parent.children[0]!.requestLog.some((r) => r.command === 'stackTrace')).toBe(false);
  });

  it('一个 child 已结束、另一个 child 握手失败被摘除 → 存活的 child 已全部结束,会话随即判为终止', async () => {
    const parent = new FakeDapClient(1001);
    const { service } = makeFakeService(parent);
    await service.launchSession({ program: '/fixture.js', cwd: '/work' }, ctx);
    await parent.triggerStartDebugging({ type: 'pwa-node' }); // child A
    const createChild = parent.createChildSession.bind(parent);
    let failConnect: (err: Error) => void = () => {};
    parent.createChildSession = () => {
      const child = createChild() as FakeDapClient;
      child.connectToServer = () =>
        new Promise((_resolve, reject) => {
          failConnect = reject;
        });
      return child;
    };
    const secondChild = parent.triggerStartDebugging({ type: 'pwa-node' }); // child B 握手中
    await Promise.resolve();
    parent.children[0]!.emit('terminated', {}); // A 结束;此时 B 还在,不算整体结束
    expect(service.listSessions()[0]?.state).not.toBe('terminated');

    failConnect(new Error('connect ECONNREFUSED')); // B 握手失败 → 被摘除
    await expect(secondChild).rejects.toThrow(/ECONNREFUSED/);
    expect(service.listSessions()[0]?.state).toBe('terminated');
  });

  it('debuggee 已结束(terminated 事件)→ 之后的 wait_for_stop 立即报已终止,不干等到超时;列表状态为 terminated', async () => {
    const parent = new FakeDapClient(1001);
    const { service } = makeFakeService(parent);
    const { session_id: sessionId } = await service.launchSession(
      { program: '/fixture.js', cwd: '/work' },
      ctx,
    );
    parent.emit('terminated', {});

    const startedAt = Date.now();
    await expect(service.waitForStop(sessionId, { timeoutMs: 5_000 })).rejects.toThrow(/terminated/);
    expect(Date.now() - startedAt).toBeLessThan(1_000);
    expect(service.listSessions()[0]?.state).toBe('terminated');

    // 结束后迟到的 stopped / continued 事件不能把状态翻回去
    parent.emit('continued', { allThreadsContinued: true });
    parent.emit('stopped', { reason: 'breakpoint', threadId: 1 });
    expect(service.listSessions()[0]?.state).toBe('terminated');
  });

  it('多个 child 时,其中一个结束不把整个会话判为已终止(worker 先退出)', async () => {
    const parent = new FakeDapClient(1001);
    const { service } = makeFakeService(parent);
    const { session_id: sessionId } = await service.launchSession(
      { program: '/fixture.js', cwd: '/work' },
      ctx,
    );
    await parent.triggerStartDebugging({ type: 'pwa-node' });
    await parent.triggerStartDebugging({ type: 'pwa-node' });

    const waiting = service.waitForStop(sessionId, { timeoutMs: 5_000 });
    parent.children[1]!.emit('terminated', {}); // 在途的等待者也不因此被结算

    expect(service.listSessions()[0]?.state).not.toBe('terminated');
    parent.children[0]!.emit('stopped', { reason: 'breakpoint', threadId: 1 });
    await expect(waiting).resolves.toMatchObject({ reason: 'breakpoint' });

    // 所有 child 都结束 → 整个会话结束(不必等父 client 的 terminated)
    parent.children[0]!.emit('exited', {});
    expect(service.listSessions()[0]?.state).toBe('terminated');
    await expect(service.waitForStop(sessionId, { afterStopSeq: 1, timeoutMs: 5_000 })).rejects.toThrow(
      /exited|terminated/,
    );
  });
});

describe('DebugService fake adapter · teardown 与 wait 状态机', () => {
  it('cleanupAll / killByOwner / killByController 同 tick 并发只执行一次 teardown, waiter 只 reject 一次', async () => {
    const { service, parent, processOps } = makeFakeService();
    const { session_id: sessionId } = await service.launchSession(
      { program: '/fixture.js', cwd: '/work' },
      { ownerWindowId: 7, controllerToken: 'agent-a' },
    );
    parent.emit('process', { systemProcessId: 2002 });

    let rejectCount = 0;
    const waiter = service
      .waitForStop(sessionId, { afterStopSeq: 0, timeoutMs: 30_000 })
      .catch((err: Error) => {
        rejectCount += 1;
        return err;
      });

    const [byOwner, byController, all] = await Promise.all([
      service.killByOwner(7, 'window-closed'),
      service.killByController('agent-a', 'auth-revoked'),
      service.cleanupAll('before-quit'),
    ]);

    const waitResult = await waiter;
    expect(waitResult).toBeInstanceOf(Error);
    expect(rejectCount).toBe(1);
    expect(byOwner).toEqual([sessionId]);
    expect(byController).toEqual([sessionId]);
    expect(all).toEqual([sessionId]);
    expect(parent.disconnectRequests).toBe(1);
    expect(parent.disposeCalls).toBe(1);
    expect(processOps.terminateProcessGroup).toHaveBeenCalledTimes(1);
    expect(service.listSessions()).toEqual([]);
  });

  it('stopped 递增 stopSeq 并即时返回; continue 递增 runSeq 后旧 stop 不串话; disconnect reject waiter', async () => {
    const { service, parent } = makeFakeService();
    const { session_id: sessionId } = await service.launchSession(
      { program: '/fixture.js', cwd: '/work' },
      { ownerWindowId: 8, controllerToken: 'agent-b' },
    );

    const waiting = service.waitForStop(sessionId, { afterStopSeq: 0, timeoutMs: 30_000 });
    parent.emit('stopped', { reason: 'breakpoint', threadId: 1 });
    await expect(waiting).resolves.toMatchObject({
      session_id: sessionId,
      stop_seq: 1,
      reason: 'breakpoint',
      thread_id: 1,
    });
    await expect(
      service.waitForStop(sessionId, { afterStopSeq: 0, timeoutMs: 30_000 }),
    ).resolves.toMatchObject({ stop_seq: 1 });

    await expect(service.continue(sessionId, { threadId: 1 })).resolves.toMatchObject({
      continued: true,
    });
    const waiter = service.waitForStop(sessionId, { afterStopSeq: 1, timeoutMs: 30_000 });
    await service.disconnect(sessionId, { terminateDebuggee: true });
    await expect(waiter).rejects.toThrow(/disconnected/i);
  });

  it('stackTrace 省略 thread_id 时用 stopped 记录的线程(含 0),不再撞 min(1) 也不多发 threads (#1)', async () => {
    const { service, parent } = makeFakeService();
    const { session_id: sessionId } = await service.launchSession(
      { program: '/fixture.js', cwd: '/work' },
      { ownerWindowId: 9, controllerToken: 'agent-thr' },
    );
    parent.emit('stopped', { reason: 'breakpoint', threadId: 0 });

    const stack = await service.stackTrace(sessionId, { startFrame: 0, levels: 1 });
    expect(stack.frames[0]).toMatchObject({ id: 7 });

    // 用 currentThreadId=0(stopped 记录),不发 threads 请求
    expect(parent.requestLog.some((r) => r.command === 'threads')).toBe(false);
    const stackReq = parent.requestLog.find((r) => r.command === 'stackTrace');
    expect(stackReq?.args).toMatchObject({ threadId: 0 });
  });

  it('stopped 未带 threadId 时省略 thread_id 回退 threads 请求解析首个线程', async () => {
    const { service, parent } = makeFakeService();
    const { session_id: sessionId } = await service.launchSession(
      { program: '/fixture.js', cwd: '/work' },
      { ownerWindowId: 14, controllerToken: 'agent-fallback' },
    );
    parent.emit('stopped', { reason: 'breakpoint' });

    await service.stackTrace(sessionId, { startFrame: 0, levels: 1 });
    expect(parent.requestLog.some((r) => r.command === 'threads')).toBe(true);
    const stackReq = parent.requestLog.find((r) => r.command === 'stackTrace');
    expect(stackReq?.args).toMatchObject({ threadId: 1 });
  });

  it('threadId 0 是合法的(js-debug Node 线程=0),显式透传不再被拒、直接传给 adapter', async () => {
    const { service, parent } = makeFakeService();
    const { session_id: sessionId } = await service.launchSession(
      { program: '/fixture.js', cwd: '/work' },
      { ownerWindowId: 10, controllerToken: 'agent-thr0' },
    );
    parent.emit('stopped', { reason: 'breakpoint', threadId: 0 });

    await service.stepOver(sessionId, { threadId: 0 });
    const nextReq = parent.requestLog.find((r) => r.command === 'next');
    expect(nextReq?.args).toMatchObject({ threadId: 0 });
    // 省略 thread_id 才走 threads 解析(此处不应发 threads 请求)
    expect(parent.requestLog.some((r) => r.command === 'threads')).toBe(false);
  });

  it('continue 请求成功即 continued:true,原始 allThreadsContinued:false 仅放 all_threads_continued (修误导返回值 #3)', async () => {
    const { service, parent } = makeFakeService();
    const { session_id: sessionId } = await service.launchSession(
      { program: '/fixture.js', cwd: '/work' },
      { ownerWindowId: 12, controllerToken: 'agent-cont' },
    );
    parent.emit('stopped', { reason: 'breakpoint', threadId: 1 });

    await expect(service.continue(sessionId, { threadId: 1 })).resolves.toMatchObject({
      continued: true,
      all_threads_continued: false,
    });
  });

  it('scopes(frameId) 返回带 variables_reference 的作用域 (debug.scopes 工具补全 stack→scopes→variables 链 #5)', async () => {
    const { service, parent } = makeFakeService();
    const { session_id: sessionId } = await service.launchSession(
      { program: '/fixture.js', cwd: '/work' },
      { ownerWindowId: 13, controllerToken: 'agent-scope' },
    );
    parent.emit('stopped', { reason: 'breakpoint', threadId: 1 });

    const { scopes } = await service.scopes(sessionId, { frameId: 7 });
    expect(scopes[0]).toMatchObject({ name: 'Local', variables_reference: 44 });
  });

  it('reason 归一:js-debug 命中断点发 reason:entry + hitBreakpointIds → wait_for_stop 报 breakpoint (#2)', async () => {
    const { service, parent } = makeFakeService();
    const { session_id } = await service.launchSession(
      { program: '/fixture.js', cwd: '/work' },
      { ownerWindowId: 30, controllerToken: 'agent-r2' },
    );
    const waiting = service.waitForStop(session_id, { afterStopSeq: 0, timeoutMs: 5_000 });
    // js-debug parent/child 实测 body:reason 恒 entry,真实信号在 hitBreakpointIds + description。
    parent.emit('stopped', {
      reason: 'entry',
      description: 'Paused on breakpoint',
      threadId: 0,
      hitBreakpointIds: [1],
    });
    await expect(waiting).resolves.toMatchObject({
      reason: 'breakpoint',
      description: 'Paused on breakpoint',
    });
  });

  it('reason 归一:无 hitBreakpointIds 时保留原 reason(step / 真 entry)', async () => {
    const { service, parent } = makeFakeService();
    const { session_id } = await service.launchSession(
      { program: '/fixture.js', cwd: '/work' },
      { ownerWindowId: 31, controllerToken: 'agent-r3' },
    );
    const stepped = service.waitForStop(session_id, { afterStopSeq: 0, timeoutMs: 5_000 });
    parent.emit('stopped', { reason: 'step', threadId: 0 });
    await expect(stepped).resolves.toMatchObject({ reason: 'step' });
  });

  it('安全:program 在 workspace 外 → 拒绝且不 spawn adapter (program-workspace 锁)', async () => {
    const parent = new FakeDapClient(1001);
    const { service } = makeFakeService(parent, {
      getWorkspaceRoot: () => '/repo',
      realpath: async (p) => p,
    });
    await expect(
      service.launchSession(
        { program: '/etc/evil.js', cwd: '/repo' },
        { ownerWindowId: 20, controllerToken: 'agent-sec' },
      ),
    ).rejects.toMatchObject({ code: 'DEBUG_PROGRAM_OUTSIDE_WORKSPACE' });
    expect(parent.requestLog.length).toBe(0);
  });

  it('安全:cwd 在 workspace 外 → 拒绝', async () => {
    const { service } = makeFakeService(new FakeDapClient(1001), {
      getWorkspaceRoot: () => '/repo',
      realpath: async (p) => p,
    });
    await expect(
      service.launchSession(
        { program: '/repo/app.js', cwd: '/tmp' },
        { ownerWindowId: 21, controllerToken: 'agent-sec2' },
      ),
    ).rejects.toMatchObject({ code: 'DEBUG_PROGRAM_OUTSIDE_WORKSPACE' });
  });

  it('安全:`..` 穿越 program(规范化后逃出 root)→ 拒绝', async () => {
    const { service } = makeFakeService(new FakeDapClient(1001), {
      getWorkspaceRoot: () => '/repo',
      realpath: async (p) => p,
    });
    await expect(
      service.launchSession(
        { program: '/repo/../secrets/app.js', cwd: '/repo' },
        { ownerWindowId: 22, controllerToken: 'agent-sec3' },
      ),
    ).rejects.toMatchObject({ code: 'DEBUG_PROGRAM_OUTSIDE_WORKSPACE' });
  });

  it('安全:窗口无 workspace 记录 → fail-closed 拒绝', async () => {
    const { service } = makeFakeService(new FakeDapClient(1001), {
      getWorkspaceRoot: () => null,
      realpath: async (p) => p,
    });
    await expect(
      service.launchSession(
        { program: '/repo/app.js', cwd: '/repo' },
        { ownerWindowId: 23, controllerToken: 'agent-sec4' },
      ),
    ).rejects.toMatchObject({ code: 'DEBUG_PROGRAM_OUTSIDE_WORKSPACE' });
  });

  it('安全:cwd 省略 → 默认 workspace root(不回退 main 进程 cwd)', async () => {
    const { service } = makeFakeService(new FakeDapClient(1001), {
      getWorkspaceRoot: () => '/repo',
      realpath: async (p) => p,
    });
    const { session_id } = await service.launchSession(
      { program: '/repo/app.js' },
      { ownerWindowId: 24, controllerToken: 'agent-sec5' },
    );
    expect(debugSessions.get(session_id)?.cwd).toBe('/repo');
  });

  it('向注入式 event sink 发状态事件,terminated 在 remove session 前发出', async () => {
    const { service, parent } = makeFakeService();
    const events: Array<{
      ownerWindowId: number;
      event: DebugViewEvent;
      sessionVisibleAtEmit: boolean;
    }> = [];
    service.setEventSink({
      emit(ownerWindowId, event) {
        events.push({
          ownerWindowId,
          event,
          sessionVisibleAtEmit: debugSessions.get(event.sessionId) !== undefined,
        });
      },
    });
    const { session_id: sessionId } = await service.launchSession(
      { program: '/fixture.js', cwd: '/work' },
      { ownerWindowId: 11, controllerToken: 'agent-events' },
    );

    await service.setBreakpoints(sessionId, { file: '/fixture.ts', line: 14 });
    parent.emit('stopped', { reason: 'breakpoint', threadId: 3 });
    await service.continue(sessionId, { threadId: 3 });
    await service.killByOwner(11, 'window-closed');

    expect(events.map((entry) => entry.ownerWindowId)).toEqual([11, 11, 11, 11]);
    expect(events.map((entry) => entry.event.type)).toEqual([
      'breakpoints-changed',
      'stopped',
      'continued',
      'terminated',
    ]);
    expect(events[0]!.event).toMatchObject({
      type: 'breakpoints-changed',
      sessionId,
      breakpoint: { file: '/fixture.ts', line: 14, verified: true },
    });
    expect(events[1]!.event).toMatchObject({
      type: 'stopped',
      sessionId,
      stopSeq: 1,
      reason: 'breakpoint',
      threadId: 3,
    });
    expect(events[2]!.event).toMatchObject({
      type: 'continued',
      sessionId,
      runSeq: 2,
    });
    expect(events[3]).toMatchObject({
      event: { type: 'terminated', sessionId, reason: 'window-closed' },
      sessionVisibleAtEmit: true,
    });
    expect(debugSessions.get(sessionId)).toBeUndefined();
  });
});

const root = process.cwd();
const spikeDir = path.join(root, 'scripts/debug-spike');
const adapterPath = path.join(spikeDir, '.adapter/js-debug/src/dapDebugServer.js');
const program = path.join(spikeDir, '.out/fixture.js');
const breakpointFile = path.join(spikeDir, 'fixture.ts');
const adapterExists = existsSync(adapterPath);

async function prepareCommonJsAdapter() {
  const dir = await mkdtemp(path.join(tmpdir(), 'continuo-debug-service-cjs-'));
  await cp(path.dirname(adapterPath), dir, { recursive: true });
  const runnablePath = path.join(dir, 'dapDebugServer.js');
  await copyFile(adapterPath, runnablePath);
  await writeFile(path.join(dir, 'package.json'), '{"type":"commonjs"}\n');
  return { dir, adapterPath: runnablePath };
}

async function processInfo(pid: number | undefined) {
  if (!pid || process.platform === 'win32') return null;
  try {
    const { stdout } = await execFile('ps', [
      '-o',
      'pid=,ppid=,pgid=,command=',
      '-p',
      String(pid),
    ]);
    const match = /^(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/.exec(stdout.trim());
    if (!match) return null;
    return {
      pid: Number(match[1]),
      ppid: Number(match[2]),
      pgid: Number(match[3]),
      command: match[4] ?? '',
    };
  } catch {
    return null;
  }
}

async function pidsInProcessGroup(pgid: number) {
  if (!pgid || process.platform === 'win32') return [];
  try {
    const { stdout } = await execFile('ps', ['-axo', 'pid=,pgid=,command=']);
    return stdout
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const match = /^(\d+)\s+(\d+)\s+(.*)$/.exec(line);
        return match
          ? {
              pid: Number(match[1]),
              pgid: Number(match[2]),
              command: match[3] ?? '',
            }
          : null;
      })
      .filter((entry): entry is { pid: number; pgid: number; command: string } => entry !== null)
      .filter((entry) => entry.pgid === pgid);
  } catch {
    return [];
  }
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function waitForDead(pids: readonly number[], timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const alive = pids.filter(pidAlive);
    if (alive.length === 0) return [];
    await sleep(100);
  }
  return pids.filter(pidAlive);
}

function findVariable(
  variables: readonly DebugVariable[],
  name: string,
): DebugVariable | undefined {
  return variables.find((variable) => variable.name === name);
}

function childVariable(parent: DebugVariable | undefined, name: string): DebugVariable | undefined {
  return parent?.children?.find((variable) => variable.name === name);
}

describe.skipIf(!adapterExists)('DebugService real adapter', () => {
  it(
    'launch→breakpoint→variables/evaluate→continue; killByOwner 反收 adapter/debuggee 树',
    async () => {
      const adapterCopy = await prepareCommonJsAdapter();
      const teardownSnapshots: Array<{
        pgid: number;
        watchedPids: readonly number[];
        groupBefore: Awaited<ReturnType<typeof pidsInProcessGroup>>;
        alive: readonly number[];
        groupAfter: Awaited<ReturnType<typeof pidsInProcessGroup>>;
      }> = [];
      const processOps: DebugProcessOps = {
        processInfo,
        pidsInProcessGroup,
        terminateProcessGroup: async (pgid, watchedPids) => {
          const groupBefore = await pidsInProcessGroup(pgid);
          if (process.platform !== 'win32') {
            try {
              process.kill(-pgid, 'SIGTERM');
            } catch {
              // The adapter may have exited after DAP disconnect.
            }
          } else {
            for (const pid of watchedPids) {
              try {
                process.kill(pid, 'SIGKILL');
              } catch {
                // ignore process-exit races
              }
            }
          }
          let alive = await waitForDead(watchedPids, 1_500);
          if (alive.length > 0 && process.platform !== 'win32') {
            try {
              process.kill(-pgid, 'SIGKILL');
            } catch {
              // group may already be gone
            }
            alive = await waitForDead(alive, 3_000);
          }
          const groupAfter = await pidsInProcessGroup(pgid);
          teardownSnapshots.push({ pgid, watchedPids, groupBefore, alive, groupAfter });
          return alive;
        },
      };
      const service = new DebugService({
        adapterPath: adapterCopy.adapterPath,
        processOps,
        requestTimeoutMs: 30_000,
        // program/cwd 都在 spikeDir 下;identity realpath(无 symlink)即可通过 workspace 闸。
        workspace: { getWorkspaceRoot: () => spikeDir, realpath: async (p) => p },
      });
      try {
        const { session_id: sessionId } = await service.launchSession(
          { program, cwd: spikeDir, name: 'debug-service fixture' },
          { ownerWindowId: 9, controllerToken: 'agent-real' },
        );
        await service.setBreakpoints(sessionId, {
          file: breakpointFile,
          line: 14,
        });
        const stopped = await service.waitForStop(sessionId, {
          afterStopSeq: 0,
          timeoutMs: 40_000,
        });
        expect(stopped.reason).toBe('breakpoint');

        const stoppedSession = debugSessions.get(sessionId);
        expect(stoppedSession?.adapterPid).toBeGreaterThan(0);
        expect(stoppedSession?.adapterPgid).toBeGreaterThan(0);
        expect(stoppedSession?.childSessionCount).toBeGreaterThanOrEqual(1);

        const groupWhileStopped = await pidsInProcessGroup(stoppedSession!.adapterPgid!);
        expect(groupWhileStopped.map((entry) => entry.pid)).toContain(
          stoppedSession!.adapterPid,
        );
        expect(groupWhileStopped.some((entry) => entry.pid !== stoppedSession!.adapterPid)).toBe(
          true,
        );

        const stack = await service.stackTrace(sessionId, {
          threadId: stopped.thread_id ?? 1,
          startFrame: 0,
          levels: 1,
        });
        expect(stack.frames[0]).toMatchObject({
          source_path: breakpointFile,
          line: 14,
        });

        const scopes = await service.scopes(sessionId, { frameId: stack.frames[0]!.id });
        const local = scopes.scopes.find((scope) => scope.name === 'Local') ?? scopes.scopes[0];
        expect(local?.variables_reference).toBeGreaterThan(0);

        const variableSets = await Promise.all(
          scopes.scopes
            .filter((scope) => !scope.expensive && scope.name !== 'Global')
            .map((scope) =>
              service.variables(sessionId, {
                variablesReference: scope.variables_reference,
                start: 0,
                count: 50,
                maxDepth: 3,
                maxStringBytes: 65536,
              }),
            ),
        );
        expect(variableSets.every((set) => !set.truncated)).toBe(true);
        const allVariables = variableSets.flatMap((set) => set.variables);
        const nested = findVariable(allVariables, 'nested');
        const arr = findVariable(allVariables, 'arr');
        const sum = findVariable(allVariables, 'sum');
        expect(childVariable(nested, 'answer')?.value).toBe('42');
        expect(childVariable(childVariable(nested, 'inner'), 'k')?.value).toMatch(/^['"]v['"]$/);
        expect(childVariable(arr, '0')?.value).toBe('1');
        expect(childVariable(arr, '2')?.value).toBe('3');
        expect(sum?.value).toBe('21');

        const evaluated = await service.evaluate(sessionId, {
          expression: 'nested.answer',
          frameId: stack.frames[0]!.id,
          context: 'watch',
          maxResultBytes: 65536,
        });
        expect(evaluated).toMatchObject({ result: '42', truncated: false });
        await expect(
          service.evaluate(sessionId, {
            expression: 'nested.inner.k',
            frameId: stack.frames[0]!.id,
            context: 'watch',
            maxResultBytes: 65536,
          }),
        ).resolves.toMatchObject({ result: expect.stringMatching(/^['"]v['"]$/), truncated: false });
        await expect(
          service.evaluate(sessionId, {
            expression: 'arr.length',
            frameId: stack.frames[0]!.id,
            context: 'watch',
            maxResultBytes: 65536,
          }),
        ).resolves.toMatchObject({ result: '3', truncated: false });

        await service.continue(sessionId, { threadId: stopped.thread_id ?? 1 });
        // 真 adapter:程序继续后跑完 → wait_for_stop 报已终止(不是干等到超时)
        const endedAt = Date.now();
        await expect(
          service.waitForStop(sessionId, { afterStopSeq: stopped.stop_seq, timeoutMs: 25_000 }),
        ).rejects.toThrow(/terminated|exited/);
        expect(Date.now() - endedAt).toBeLessThan(20_000);
        await expect(
          service.waitForStop(sessionId, { afterStopSeq: stopped.stop_seq, timeoutMs: 25_000 }),
        ).rejects.toThrow(/terminated|exited/);
        await expect(service.killByOwner(9, 'test cleanup')).resolves.toEqual([
          sessionId,
        ]);
        expect(teardownSnapshots).toHaveLength(1);
        expect(teardownSnapshots[0]!.watchedPids).toContain(stoppedSession!.adapterPid);
        expect(teardownSnapshots[0]!.groupBefore.length).toBeGreaterThanOrEqual(1);
        expect(teardownSnapshots[0]!.alive).toEqual([]);
        expect(teardownSnapshots[0]!.groupAfter).toEqual([]);
      } finally {
        await service.cleanupAll('test finally').catch(() => undefined);
        await rm(adapterCopy.dir, { recursive: true, force: true });
      }
    },
    130_000,
  );
});
