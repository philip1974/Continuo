// @vitest-environment node

import { execFile as execFileCb } from 'node:child_process';
import { existsSync } from 'node:fs';
import { copyFile, cp, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  DEBUG_VARIABLES_EXPAND_MAX_NODES,
  DEBUG_VARIABLES_EXPAND_MAX_REQUESTS,
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

// 模拟 Windows 平台(debug.service 经 node:os 的 platform() 判平台)。
const platformMock = vi.hoisted(() => ({ value: null as NodeJS.Platform | null }));
vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  return { ...actual, platform: () => platformMock.value ?? actual.platform() };
});

// 观察默认 processOps 在 Windows 上是否走共享的进程树强杀(默认透传真实实现)。
vi.mock('../lib/kill-with-grace', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/kill-with-grace')>();
  return { ...actual, processTreeKillable: vi.fn(actual.processTreeKillable) };
});

class FakeDapClient implements DebugDapClientLike {
  readonly socketPath = `fake-${Math.random().toString(16).slice(2)}.sock`;
  readonly tcpPort = 0;
  readonly serverPid: number;
  readonly requestLog: Array<{ command: string; args: DapJson }> = [];
  readonly children: FakeDapClient[] = [];
  readonly timeoutLog: Array<{ command: string; timeoutMs: number | undefined }> = [];
  disconnectRequests = 0;
  disposeCalls = 0;
  /**
   * 响应返回之前执行(可在里面 emit 事件 / 挂起)。真实 DapClient 在一次 data 回调里同步处理同一 chunk 的
   * 全部消息,排在响应后面的事件会先于调用方的 await 续体被处理 —— 用它复现这种时序。设置后不再自动发
   * continued。
   */
  beforeResponse: ((command: string) => void | Promise<void>) | null = null;
  /** setBreakpoints 响应里的行号校正(模拟 adapter 把断点挪到最近的可执行行)。 */
  adjustBreakpointLine: (line: number) => number = (line) => line;
  /** 置位时 setBreakpoints 响应的 breakpoints 为空数组(模拟 adapter 对未变化的集合不逐项回报)。 */
  emptyBreakpointsResponse = false;
  /** 这些请求行回报 verified:false + message(模拟 adapter 暂不能绑定的断点)。 */
  unverifiedLines = new Set<number>();
  /** 最近一次 setBreakpoints 响应各项的 id(真实 js-debug:每次响应重新编号,且按连接各自编号)。 */
  lastBreakpointIds: number[] = [];
  /** 下一个分配的断点 id(按连接各自编号)。 */
  nextBreakpointId = 1;
  private seq = 1;
  /**
   * beforeResponse 挂起中的在途请求的 reject。dispose 时以 socket closed 结算 —— 同真实 DapClient:关 socket
   * 后 rejectAllPending,响应尚未到达的请求全部失败。
   */
  private readonly inFlightRejects = new Set<(err: Error) => void>();
  /** 等在途请求清空后再 dispose 的回调(disposeWhenIdle)。 */
  private readonly idleWaiters: Array<() => void> = [];
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

  async sendRequest(
    command: string,
    args: DapJson = {},
    timeoutMs?: number,
  ): Promise<DapResponseMessage> {
    this.requestLog.push({ command, args });
    this.timeoutLog.push({ command, timeoutMs });
    if (command === 'initialize') {
      queueMicrotask(() => this.emit('initialized', {}));
    }
    if (this.beforeResponse) {
      const hook = this.beforeResponse;
      try {
        await new Promise<void>((resolve, reject) => {
          this.inFlightRejects.add(reject);
          Promise.resolve(hook(command)).then(
            () => {
              this.inFlightRejects.delete(reject);
              resolve();
            },
            (err: unknown) => {
              this.inFlightRejects.delete(reject);
              reject(err);
            },
          );
        });
      } finally {
        if (this.inFlightRejects.size === 0) {
          for (const resume of this.idleWaiters.splice(0)) resume();
        }
      }
    } else if (
      command === 'continue' ||
      command === 'next' ||
      command === 'stepIn' ||
      command === 'stepOut'
    ) {
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
      body: this.responseBody(command, args),
    };
  }

  sendRequestNoWait(command: string, args: DapJson = {}): number {
    this.requestLog.push({ command, args });
    return this.seq++;
  }

  async dispose(): Promise<void> {
    this.disposeCalls += 1;
    const inFlight = [...this.inFlightRejects];
    this.inFlightRejects.clear();
    for (const reject of inFlight) reject(new Error('DAP socket closed'));
  }

  disposeWhenIdle(): Promise<void> {
    if (this.inFlightRejects.size === 0) return this.dispose();
    return new Promise<void>((resolve) => this.idleWaiters.push(resolve)).then(() => this.dispose());
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

  private responseBody(command: string, args: DapJson): DapJson {
    if (command === 'setBreakpoints') {
      // 按请求逐个回显(DAP:响应的 breakpoints 与请求一一对应)。
      const requested = (args as { breakpoints?: Array<{ line: number }> }).breakpoints ?? [];
      if (this.emptyBreakpointsResponse) return { breakpoints: [] };
      this.lastBreakpointIds = requested.map(() => this.nextBreakpointId++);
      return {
        breakpoints: requested.map((bp, i): DapJson => {
          const line = this.adjustBreakpointLine(bp.line);
          const id = this.lastBreakpointIds[i]!;
          return this.unverifiedLines.has(bp.line)
            ? { id, verified: false, line, message: 'pending' }
            : { id, verified: true, line };
        }),
      };
    }
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
  platformMock.value = null;
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

  it('调用方在 spawn 之前已断开(signal 已 abort)→ 不 spawn adapter,以取消错误结束', async () => {
    const parent = new FakeDapClient(1001);
    const spawn = vi.spyOn(parent, 'spawnServer');
    const { service } = makeFakeService(parent);
    const aborter = new AbortController();
    aborter.abort();

    await expect(
      service.launchSession({ program: '/fixture.js', cwd: '/work' }, { ...ctx, signal: aborter.signal }),
    ).rejects.toMatchObject({ code: 'AGENT_NOT_AUTHORIZED' });
    expect(spawn).not.toHaveBeenCalled();
    expect(service.listSessions()).toEqual([]);
  });

  it('调用方在 spawn 期间断开 → 释放 adapter、不登记 session,以取消错误结束', async () => {
    const parent = new FakeDapClient(1001);
    const aborter = new AbortController();
    parent.spawnServer = async function (this: FakeDapClient) {
      aborter.abort();
      return this;
    };
    const { service } = makeFakeService(parent);

    await expect(
      service.launchSession({ program: '/fixture.js', cwd: '/work' }, { ...ctx, signal: aborter.signal }),
    ).rejects.toMatchObject({ code: 'AGENT_NOT_AUTHORIZED' });
    expect(parent.disposeCalls).toBe(1);
    expect(service.listSessions()).toEqual([]);
  });

  it('调用方在 initialize 期间断开 → 立即拆除已登记的 session 并 dispose client,以取消错误结束', async () => {
    const parent = new FakeDapClient(1001);
    const aborter = new AbortController();
    const original = parent.sendRequest.bind(parent);
    let releaseInitialize!: () => void;
    parent.sendRequest = async (command, args, timeoutMs) => {
      if (command === 'initialize') {
        // adapter 迟迟不应答 initialize:断连必须即时回收,不能等到请求超时。
        await new Promise<void>((resolve) => {
          releaseInitialize = resolve;
        });
      }
      return original(command, args, timeoutMs);
    };
    const { service, processOps } = makeFakeService(parent);

    const launched = service.launchSession(
      { program: '/fixture.js', cwd: '/work' },
      { ...ctx, signal: aborter.signal },
    );
    const settled = launched.catch((err: unknown) => err);
    await vi.waitFor(() => expect(service.listSessions()).toHaveLength(1));

    aborter.abort();
    await vi.waitFor(() => expect(service.listSessions()).toEqual([]));
    expect(parent.disposeCalls).toBe(1);
    expect(processOps.terminateProcessGroup).toHaveBeenCalled();

    releaseInitialize();
    await expect(settled).resolves.toMatchObject({ code: 'AGENT_NOT_AUTHORIZED' });
    expect(service.listSessions()).toEqual([]);
  });

  it('initialize 完成后才发现调用方已断开 → 拆除 session,不返回 session_id', async () => {
    const parent = new FakeDapClient(1001);
    const aborter = new AbortController();
    const original = parent.sendRequest.bind(parent);
    parent.sendRequest = async (command, args, timeoutMs) => {
      const res = await original(command, args, timeoutMs);
      if (command === 'initialize') aborter.abort();
      return res;
    };
    const { service } = makeFakeService(parent);

    await expect(
      service.launchSession({ program: '/fixture.js', cwd: '/work' }, { ...ctx, signal: aborter.signal }),
    ).rejects.toMatchObject({ code: 'AGENT_NOT_AUTHORIZED' });
    expect(service.listSessions()).toEqual([]);
    expect(parent.disposeCalls).toBe(1);
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

  it('程序跑起来之后再设断点 → 也同步给已建立的 child session', async () => {
    const parent = new FakeDapClient(1001);
    const { service } = makeFakeService(parent);
    const { session_id: sessionId } = await service.launchSession(
      { program: '/fixture.js', cwd: '/work' },
      ctx,
    );
    await parent.triggerStartDebugging({ type: 'pwa-node' });
    const child = parent.children[0]!;
    child.requestLog.length = 0;

    await service.setBreakpoints(sessionId, { file: '/fixture.js', line: 5 });
    expect(child.requestLog).toContainEqual(
      expect.objectContaining({
        command: 'setBreakpoints',
        args: expect.objectContaining({ breakpoints: [{ line: 5 }] }),
      }),
    );
  });

  it('嵌套目标(worker)的 startDebugging 来自 child 连接 → 同样建 child session(不回 unsupported)', async () => {
    const parent = new FakeDapClient(1001);
    const { service } = makeFakeService(parent);
    await service.launchSession({ program: '/fixture.js', cwd: '/work' }, ctx);
    await parent.triggerStartDebugging({ type: 'pwa-node' });
    const main = parent.children[0]!;

    await main.triggerStartDebugging({ type: 'pwa-node', name: '[worker 1]' });
    expect(main.children).toHaveLength(1);
    expect(main.children[0]!.requestLog.map((r) => r.command)).toEqual(
      expect.arrayContaining(['initialize', 'configurationDone', 'launch']),
    );
  });

  it('停在哪条连接上,后续请求就发给哪条连接(worker 停住 → 查 worker 的栈)', async () => {
    const parent = new FakeDapClient(1001);
    const { service } = makeFakeService(parent);
    const { session_id: sessionId } = await service.launchSession(
      { program: '/fixture.js', cwd: '/work' },
      ctx,
    );
    await parent.triggerStartDebugging({ type: 'pwa-node' });
    const main = parent.children[0]!;
    await main.triggerStartDebugging({ type: 'pwa-node', name: '[worker 1]' });
    const worker = main.children[0]!;

    // worker 出现后活动连接仍是主目标
    main.emit('stopped', { reason: 'breakpoint', threadId: 0 });
    await service.stackTrace(sessionId, {});
    expect(main.requestLog.some((r) => r.command === 'stackTrace')).toBe(true);
    expect(worker.requestLog.some((r) => r.command === 'stackTrace')).toBe(false);

    await service.continue(sessionId, {});
    worker.emit('stopped', { reason: 'breakpoint', threadId: 1 });
    await service.stackTrace(sessionId, {});
    expect(worker.requestLog.some((r) => r.command === 'stackTrace')).toBe(true);
  });

  // 多条连接各自停住(主线程 + worker 各命中一个断点):会话一次只呈现一个停点,其余排队;
  // 当前停点恢复后下一个停点接着呈现 —— 否则后停的把先停的顶掉,先停的那条连接再也没法被继续,程序挂住。
  async function launchWithWorker() {
    const parent = new FakeDapClient(1001);
    const { service } = makeFakeService(parent);
    const { session_id: sessionId } = await service.launchSession(
      { program: '/fixture.js', cwd: '/work' },
      ctx,
    );
    await parent.triggerStartDebugging({ type: 'pwa-node' });
    const main = parent.children[0]!;
    await main.triggerStartDebugging({ type: 'pwa-node', name: '[worker 1]' });
    const worker = main.children[0]!;
    return { service, sessionId, main, worker };
  }

  it('两条连接先后停住 → 先呈现先停的;继续后接着呈现后停的,请求发给对应连接', async () => {
    const { service, sessionId, main, worker } = await launchWithWorker();
    main.emit('stopped', { reason: 'breakpoint', threadId: 0 });
    worker.emit('stopped', { reason: 'breakpoint', threadId: 7 });

    const first = await service.waitForStop(sessionId, { afterStopSeq: 0, timeoutMs: 1_000 });
    expect(first.thread_id).toBe(0);
    await service.stackTrace(sessionId, {});
    expect(main.requestLog.some((r) => r.command === 'stackTrace')).toBe(true);
    expect(worker.requestLog.some((r) => r.command === 'stackTrace')).toBe(false);

    await service.continue(sessionId, {});
    expect(main.requestLog.some((r) => r.command === 'continue')).toBe(true);
    expect(worker.requestLog.some((r) => r.command === 'continue')).toBe(false);

    const second = await service.waitForStop(sessionId, {
      afterStopSeq: first.stop_seq,
      timeoutMs: 1_000,
    });
    expect(second.thread_id).toBe(7);
    await service.stackTrace(sessionId, {});
    expect(worker.requestLog.some((r) => r.command === 'stackTrace')).toBe(true);
    await service.continue(sessionId, {});
    expect(worker.requestLog.some((r) => r.command === 'continue')).toBe(true);
    expect(service.listSessions()[0]?.state).toBe('running');
  });

  it('别的连接发来 continued 不清掉当前停点', async () => {
    const { service, sessionId, main, worker } = await launchWithWorker();
    main.emit('stopped', { reason: 'breakpoint', threadId: 0 });
    worker.emit('continued', { threadId: 7, allThreadsContinued: false });

    expect(service.listSessions()[0]?.state).toBe('stopped');
    await expect(
      service.waitForStop(sessionId, { afterStopSeq: 0, timeoutMs: 1_000 }),
    ).resolves.toMatchObject({ thread_id: 0 });
  });

  it('当前停点所在的连接结束(worker 退出)而其它连接还在 → 停点作废,后续请求回到仍存活的连接', async () => {
    const { service, sessionId, main, worker } = await launchWithWorker();
    worker.emit('stopped', { reason: 'breakpoint', threadId: 7 });
    worker.emit('terminated', {});

    expect(service.listSessions()[0]?.state).toBe('running');
    // main 没有停住过:活动连接必须已经从结束的 worker 换回 main,而不是靠下一次 stopped 顺带切换
    worker.requestLog.length = 0;
    await service.stackTrace(sessionId, { threadId: 0 });
    expect(main.requestLog.some((r) => r.command === 'stackTrace')).toBe(true);
    expect(worker.requestLog).toEqual([]);
  });

  // 真实 js-debug:被调试程序跑完时,continue 的响应可能排在同一连接的 continued / terminated 事件之后、落在
  // 下一个 chunk。结束的 child 若当即 dispose(关 socket),这个在途请求就以「DAP socket closed」失败。
  it('唯一的 child 结束时 continue 的响应尚未到达 → continue 照常返回,连接在响应之后才回收;会话判为结束', async () => {
    const parent = new FakeDapClient(1001);
    const { service } = makeFakeService(parent);
    const { session_id: sessionId } = await service.launchSession(
      { program: '/fixture.js', cwd: '/work' },
      ctx,
    );
    await parent.triggerStartDebugging({ type: 'pwa-node' });
    const main = parent.children[0]!;
    main.emit('stopped', { reason: 'breakpoint', threadId: 0 });
    const stopped = await service.waitForStop(sessionId, { afterStopSeq: 0, timeoutMs: 1_000 });
    let disposedBeforeResponse: number | undefined;
    main.beforeResponse = async (command) => {
      if (command !== 'continue') return;
      main.emit('continued', { threadId: 0, allThreadsContinued: false });
      main.emit('terminated', {});
      await new Promise((resolve) => setTimeout(resolve, 0)); // 响应在下一个 chunk
      disposedBeforeResponse = main.disposeCalls;
    };

    await expect(service.continue(sessionId, {})).resolves.toMatchObject({ continued: true });
    expect(disposedBeforeResponse).toBe(0);
    await vi.waitFor(() => expect(main.disposeCalls).toBe(1)); // 在途请求结算之后照样回收
    await expect(
      service.waitForStop(sessionId, { afterStopSeq: stopped.stop_seq, timeoutMs: 1_000 }),
    ).rejects.toThrow(/terminated/);
  });

  it('worker 结束时发给它的请求尚未应答 → 请求照常返回,之后 worker 才被回收;主线程连接不受影响', async () => {
    const { service, sessionId, main, worker } = await launchWithWorker();
    worker.emit('stopped', { reason: 'breakpoint', threadId: 7 });
    await service.waitForStop(sessionId, { afterStopSeq: 0, timeoutMs: 1_000 });
    worker.beforeResponse = async (command) => {
      if (command !== 'stackTrace') return;
      worker.emit('terminated', {});
      await new Promise((resolve) => setTimeout(resolve, 0));
    };

    await expect(service.stackTrace(sessionId, { threadId: 7 })).resolves.toMatchObject({
      frames: [expect.objectContaining({ line: 14 })],
    });
    await vi.waitFor(() => expect(worker.disposeCalls).toBe(1));
    expect(main.disposeCalls).toBe(0);
    expect(service.listSessions()[0]?.state).toBe('running');
    await service.stackTrace(sessionId, { threadId: 0 });
    expect(main.requestLog.some((r) => r.command === 'stackTrace')).toBe(true);
  });

  // 真实 DapClient 一次 read 里读到「单步的响应 + continued + stopped」时,两个事件先于 resume 的续体处理。
  it('单步的响应与随后的 stopped 同批到达 → 新停点不被迟到的清理抹掉', async () => {
    const { service, sessionId, main } = await launchWithWorker();
    main.emit('stopped', { reason: 'breakpoint', threadId: 0 });
    const first = await service.waitForStop(sessionId, { afterStopSeq: 0, timeoutMs: 1_000 });
    main.beforeResponse = (command) => {
      if (command !== 'next') return;
      main.emit('continued', { threadId: 0, allThreadsContinued: false });
      main.emit('stopped', { reason: 'step', threadId: 0 });
    };

    await service.stepOver(sessionId, {});
    expect(service.listSessions()[0]?.state).toBe('stopped');
    await expect(
      service.waitForStop(sessionId, { afterStopSeq: first.stop_seq, timeoutMs: 1_000 }),
    ).resolves.toMatchObject({ reason: 'step', thread_id: 0 });
  });

  it('同上,且另一条连接有排队停点 → 单步后的新停点入队,不被迟到的清理删掉', async () => {
    const { service, sessionId, main, worker } = await launchWithWorker();
    main.emit('stopped', { reason: 'breakpoint', threadId: 0 });
    worker.emit('stopped', { reason: 'breakpoint', threadId: 7 });
    const first = await service.waitForStop(sessionId, { afterStopSeq: 0, timeoutMs: 1_000 });
    main.beforeResponse = (command) => {
      if (command !== 'next') return;
      main.emit('continued', { threadId: 0, allThreadsContinued: false });
      main.emit('stopped', { reason: 'step', threadId: 0 });
    };

    await service.stepOver(sessionId, {});
    const second = await service.waitForStop(sessionId, {
      afterStopSeq: first.stop_seq,
      timeoutMs: 1_000,
    });
    expect(second.thread_id).toBe(7);

    await service.continue(sessionId, {});
    await expect(
      service.waitForStop(sessionId, { afterStopSeq: second.stop_seq, timeoutMs: 1_000 }),
    ).resolves.toMatchObject({ reason: 'step', thread_id: 0 });
  });

  it('设断点:已结束的 child 不再同步', async () => {
    const { service, sessionId, main, worker } = await launchWithWorker();
    worker.emit('terminated', {});
    main.requestLog.length = 0;
    worker.requestLog.length = 0;

    await service.setBreakpoints(sessionId, { file: '/fixture.js', line: 9 });
    expect(main.requestLog.some((r) => r.command === 'setBreakpoints')).toBe(true);
    expect(worker.requestLog.some((r) => r.command === 'setBreakpoints')).toBe(false);
  });

  it('设断点:各 child 并行发送(一个不应答不拖住其它),且用较短的超时', async () => {
    const { service, sessionId, main, worker } = await launchWithWorker();
    worker.requestLog.length = 0;
    let release!: () => void;
    const hung = new Promise<void>((resolve) => {
      release = resolve;
    });
    main.beforeResponse = (command) => (command === 'setBreakpoints' ? hung : undefined);

    const pending = service.setBreakpoints(sessionId, { file: '/fixture.js', line: 9 });
    await vi.waitFor(() =>
      expect(worker.requestLog.some((r) => r.command === 'setBreakpoints')).toBe(true),
    );
    release();
    await pending;

    const timeoutOf = (client: FakeDapClient) =>
      client.timeoutLog.filter((r) => r.command === 'setBreakpoints').at(-1)?.timeoutMs;
    expect(timeoutOf(main)).toBe(3_000);
    expect(timeoutOf(worker)).toBe(3_000);
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
  // Windows 没有进程组可枚举:只直杀 adapter 与已记录的 debuggee pid,未记录的后代(debuggee 再 spawn
  // 的子进程等)会存活。默认 processOps 须对这些 pid 走 taskkill /T /F 整树强杀(复用 kill-with-grace)。
  it('Windows:默认 processOps 的 teardown 对 adapter 与 debuggee pid 走进程树强杀', async () => {
    platformMock.value = 'win32';
    const killGrace = await import('../lib/kill-with-grace');
    const treeKill = vi.mocked(killGrace.processTreeKillable);
    const killedPids: Array<{ pid: number | undefined; signal: unknown }> = [];
    treeKill.mockImplementation((target) => ({
      kill: (signal) => {
        killedPids.push({ pid: target.pid, signal });
        return true;
      },
    }));
    try {
      // 取不存在的 pid:强杀被替换后,teardown 的存活探测立即判定已退出。
      const parent = new FakeDapClient(3_999_901);
      const service = new DebugService({ createDapClient: () => parent, workspace: PERMISSIVE_WORKSPACE });
      await service.launchSession(
        { program: 'C:\\repo\\fixture.js', cwd: 'C:\\repo' },
        { ownerWindowId: 41, controllerToken: 'agent-win' },
      );
      parent.emit('process', { systemProcessId: 3_999_902 });

      await service.killByOwner(41, 'window-closed');

      expect(killedPids).toEqual(
        expect.arrayContaining([
          { pid: 3_999_901, signal: 'SIGTERM' },
          { pid: 3_999_902, signal: 'SIGTERM' },
        ]),
      );
    } finally {
      treeKill.mockReset();
      const actual = await vi.importActual<typeof import('../lib/kill-with-grace')>('../lib/kill-with-grace');
      treeKill.mockImplementation(actual.processTreeKillable);
    }
  });

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
    await service.disconnect(sessionId);
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

  // 起跑推迟到 wait_for_stop:校验后、起跑前把工作区内软链改指工作区外,launch 不得跟着新目标走。
  it('安全:launch 参数用校验时的 realpath(program/cwd),校验后软链改指工作区外不生效', async () => {
    const parent = new FakeDapClient(1001);
    const links = new Map([
      ['/repo/link.js', '/repo/real/app.js'],
      ['/repo/cwd-link', '/repo/real'],
    ]);
    const { service } = makeFakeService(parent, {
      getWorkspaceRoot: () => '/repo',
      realpath: async (p) => links.get(p) ?? p,
    });
    const { session_id } = await service.launchSession(
      { program: '/repo/link.js', cwd: '/repo/cwd-link' },
      { ownerWindowId: 25, controllerToken: 'agent-sec6' },
    );
    links.set('/repo/link.js', '/etc/evil.js');
    links.set('/repo/cwd-link', '/etc');

    void service.waitForStop(session_id, { timeoutMs: 5_000 }).catch(() => undefined);
    await vi.waitFor(() => expect(parent.requestLog.some((r) => r.command === 'launch')).toBe(true));
    const launch = parent.requestLog.find((r) => r.command === 'launch')!.args as Record<string, unknown>;
    expect(launch['program']).toBe('/repo/real/app.js');
    expect(launch['cwd']).toBe('/repo/real');
    await service.killByOwner(25, 'test');
  });

  // 只钉住 launch 用真实路径不够:校验后、起跑前把该真实路径文件改名,原位换成指向工作区外的软链,
  // Node 起跑时重新解析 → 发 launch 前必须复验。
  it('安全:起跑前真实路径被换成指向工作区外的软链 → 不发 launch,以既有错误码报告并拆除会话', async () => {
    const parent = new FakeDapClient(1001);
    const links = new Map<string, string>();
    const { service, processOps } = makeFakeService(parent, {
      getWorkspaceRoot: () => '/repo',
      realpath: async (p) => links.get(p) ?? p,
    });
    const { session_id } = await service.launchSession(
      { program: '/repo/real/app.js', cwd: '/repo' },
      { ownerWindowId: 26, controllerToken: 'agent-sec7' },
    );
    links.set('/repo/real/app.js', '/etc/evil.js');

    await expect(service.waitForStop(session_id, { timeoutMs: 5_000 })).rejects.toMatchObject({
      code: 'DEBUG_PROGRAM_OUTSIDE_WORKSPACE',
    });
    expect(parent.requestLog.some((r) => r.command === 'launch')).toBe(false);
    await vi.waitFor(() => expect(service.listSessions()).toEqual([]));
    expect(processOps.terminateProcessGroup).toHaveBeenCalled();
  });

  it('安全:continue 触发起跑时同样复验(cwd 被换到工作区外 → 拒绝起跑)', async () => {
    const parent = new FakeDapClient(1001);
    const links = new Map<string, string>();
    const { service } = makeFakeService(parent, {
      getWorkspaceRoot: () => '/repo',
      realpath: async (p) => links.get(p) ?? p,
    });
    const { session_id } = await service.launchSession(
      { program: '/repo/app.js', cwd: '/repo/sub' },
      { ownerWindowId: 27, controllerToken: 'agent-sec8' },
    );
    links.set('/repo/sub', '/etc');

    await expect(service.continue(session_id, {})).rejects.toMatchObject({
      code: 'DEBUG_PROGRAM_OUTSIDE_WORKSPACE',
    });
    expect(parent.requestLog.some((r) => r.command === 'launch')).toBe(false);
    await vi.waitFor(() => expect(service.listSessions()).toEqual([]));
  });

  // 真正起 Node 的是 child 连接上的 launch(js-debug 的 startDebugging),父 launch 之后仍有窗口。
  it('安全:startDebugging 建 child 时复验,路径已出工作区 → child 不发 launch,拆除会话', async () => {
    const parent = new FakeDapClient(1001);
    const links = new Map<string, string>();
    const { service } = makeFakeService(parent, {
      getWorkspaceRoot: () => '/repo',
      realpath: async (p) => links.get(p) ?? p,
    });
    const { session_id } = await service.launchSession(
      { program: '/repo/app.js', cwd: '/repo' },
      { ownerWindowId: 28, controllerToken: 'agent-sec9' },
    );
    void service.waitForStop(session_id, { timeoutMs: 5_000 }).catch(() => undefined);
    await vi.waitFor(() => expect(parent.requestLog.some((r) => r.command === 'launch')).toBe(true));
    links.set('/repo/app.js', '/etc/evil.js');

    await expect(parent.triggerStartDebugging({ type: 'pwa-node' })).rejects.toMatchObject({
      code: 'DEBUG_PROGRAM_OUTSIDE_WORKSPACE',
    });
    expect(parent.children[0]!.requestLog.some((r) => r.command === 'launch')).toBe(false);
    await vi.waitFor(() => expect(service.listSessions()).toEqual([]));
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

  // program/cwd 锁在工作区内,但 env 原样交给 Node:NODE_OPTIONS=--require=/tmp/x.js 等会在目标程序前
  // 加载工作区外代码 → 这类变量(大小写不敏感,覆盖 Windows)一律拒绝,且不 spawn adapter。
  it.each([
    'NODE_OPTIONS',
    'NODE_PATH',
    'NODE_REPL_EXTERNAL_MODULE',
    'LD_PRELOAD',
    'LD_LIBRARY_PATH',
    'DYLD_INSERT_LIBRARIES',
    'DYLD_LIBRARY_PATH',
    'node_options',
    'Ld_Preload',
  ])('安全:env 含会加载额外代码的变量 %s → 拒绝且不 spawn adapter', async (name) => {
    const parent = new FakeDapClient(1001);
    const spawn = vi.spyOn(parent, 'spawnServer');
    const { service } = makeFakeService(parent, {
      getWorkspaceRoot: () => '/repo',
      realpath: async (p) => p,
    });
    await expect(
      service.launchSession(
        { program: '/repo/app.js', cwd: '/repo', env: [{ name, value: '--require=/tmp/payload.js' }] },
        { ownerWindowId: 29, controllerToken: 'agent-sec10' },
      ),
    ).rejects.toMatchObject({ code: 'DEBUG_PROGRAM_OUTSIDE_WORKSPACE', message: expect.stringContaining(name) });
    expect(spawn).not.toHaveBeenCalled();
    expect(service.listSessions()).toEqual([]);
  });

  it('普通 env 照常传给 launch', async () => {
    const parent = new FakeDapClient(1001);
    const { service } = makeFakeService(parent, {
      getWorkspaceRoot: () => '/repo',
      realpath: async (p) => p,
    });
    const { session_id } = await service.launchSession(
      { program: '/repo/app.js', cwd: '/repo', env: [{ name: 'FOO', value: 'bar' }, { name: 'NODE_ENV', value: 'test' }] },
      { ownerWindowId: 30, controllerToken: 'agent-sec11' },
    );
    void service.waitForStop(session_id, { timeoutMs: 5_000 }).catch(() => undefined);
    await vi.waitFor(() => expect(parent.requestLog.some((r) => r.command === 'launch')).toBe(true));
    const launch = parent.requestLog.find((r) => r.command === 'launch')!.args as Record<string, unknown>;
    expect(launch['env']).toEqual({ FOO: 'bar', NODE_ENV: 'test' });
    await service.killByOwner(30, 'test');
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
    // 程序在第一个 wait_for_stop 时才起跑(launch 后 runSeq=1),之后才可能停住
    const waiting = service.waitForStop(sessionId, { timeoutMs: 5_000 });
    await vi.waitFor(() => expect(parent.requestLog.some((r) => r.command === 'launch')).toBe(true));
    parent.emit('stopped', { reason: 'breakpoint', threadId: 3 });
    await waiting;
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
      file: '/fixture.ts',
      breakpoints: [{ file: '/fixture.ts', line: 14, verified: true }],
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

// 审计修复(codex):会话上限、未设断点时程序不启动、同文件多断点。
describe('DebugService fake adapter · 会话上限 / 程序起跑时机 / 按 source 的断点集合', () => {
  const ctx = { ownerWindowId: 40, controllerToken: 'agent-audit' };

  function fillWindow(ownerWindowId: number, count: number, prefix = 'pre'): void {
    for (let i = 0; i < count; i += 1) {
      debugSessions.add({
        id: `${prefix}-${ownerWindowId}-${i}`,
        ownerWindowId,
        controllerToken: 'other',
        program: '/p.js',
        cwd: '/',
      });
    }
  }

  function runtimeCount(service: DebugService): number {
    return (service as unknown as { runtimes: Map<string, unknown> }).runtimes.size;
  }

  it('窗口会话数已达上限 → 拒绝且不 spawn adapter', async () => {
    fillWindow(ctx.ownerWindowId, 8);
    const parent = new FakeDapClient(1001);
    const spawn = vi.spyOn(parent, 'spawnServer');
    const { service } = makeFakeService(parent);

    await expect(service.launchSession({ program: '/fixture.js', cwd: '/work' }, ctx)).rejects.toThrow(
      /limit/,
    );
    expect(spawn).not.toHaveBeenCalled();
    expect(runtimeCount(service)).toBe(0);
  });

  it('spawn 期间并发 launch 占满上限 → 登记失败时释放 adapter,不残留 runtime', async () => {
    fillWindow(ctx.ownerWindowId, 7);
    const parent = new FakeDapClient(1001);
    parent.spawnServer = async function (this: FakeDapClient) {
      fillWindow(ctx.ownerWindowId, 1, 'racer');
      return this;
    };
    const { service } = makeFakeService(parent);

    await expect(service.launchSession({ program: '/fixture.js', cwd: '/work' }, ctx)).rejects.toThrow(
      /limit/,
    );
    expect(parent.disposeCalls).toBe(1);
    expect(runtimeCount(service)).toBe(0);
  });

  // stdio 连接断开后其 subject 失效(main 经 onCallerClosed → killByController 回收):名额释放,
  // 别的调用方的会话不受影响。
  it('killByController 回收失效调用方的全部会话 → 窗口名额释放,其它调用方会话保留', async () => {
    let pid = 3000;
    const { processOps } = makeFakeService();
    const service = new DebugService({
      createDapClient: () => new FakeDapClient((pid += 1)),
      processOps,
      workspace: PERMISSIVE_WORKSPACE,
    });
    const dead = { ownerWindowId: ctx.ownerWindowId, controllerToken: 'stdio:dead' };
    const alive = { ownerWindowId: ctx.ownerWindowId, controllerToken: 'stdio:alive' };
    for (let i = 0; i < 6; i += 1) await service.launchSession({ program: '/fixture.js', cwd: '/work' }, dead);
    const kept = await service.launchSession({ program: '/fixture.js', cwd: '/work' }, alive);
    await service.launchSession({ program: '/fixture.js', cwd: '/work' }, alive);
    await expect(service.launchSession({ program: '/fixture.js', cwd: '/work' }, alive)).rejects.toThrow(/limit/);

    const killed = await service.killByController('stdio:dead', 'caller-disconnected');

    expect(killed).toHaveLength(6);
    expect(debugSessions.byController('stdio:dead')).toHaveLength(0);
    expect(debugSessions.get(kept.session_id)).toBeDefined();
    await expect(service.launchSession({ program: '/fixture.js', cwd: '/work' }, alive)).resolves.toBeDefined();
    await service.killByOwner(ctx.ownerWindowId, 'test');
  });

  // 程序自然退出只把会话标成 terminated(保留给 list_sessions / wait_for_stop 看),父 adapter 不会自己退出;
  // 若仍计入名额,连续调试 8 个自然结束的程序后第 9 次 launch 永久报上限。名额满时回收最旧的 terminated 会话。
  it('名额被自然结束的会话占满 → 回收最旧的 terminated 会话(拆 adapter),新 launch 成功', async () => {
    let pid = 4000;
    const clients: FakeDapClient[] = [];
    const { processOps } = makeFakeService();
    const service = new DebugService({
      createDapClient: () => {
        const client = new FakeDapClient((pid += 1));
        clients.push(client);
        return client;
      },
      processOps,
      workspace: PERMISSIVE_WORKSPACE,
    });
    const ids: string[] = [];
    for (let i = 0; i < 8; i += 1) {
      const { session_id } = await service.launchSession({ program: '/fixture.js', cwd: '/work' }, ctx);
      ids.push(session_id);
      clients[i]!.emit('terminated', {});
    }
    // terminated 会话仍可见,wait_for_stop 仍按既有语义立即报已终止
    expect(service.listSessions().map((s) => s.state)).toEqual(Array(8).fill('terminated'));
    await expect(service.waitForStop(ids[1]!, { timeoutMs: 5_000 })).rejects.toThrow(/terminated/);

    const ninth = await service.launchSession({ program: '/fixture.js', cwd: '/work' }, ctx);

    expect(ninth.state).toBe('starting');
    expect(clients[0]!.disposeCalls).toBe(1);
    expect(debugSessions.get(ids[0]!)).toBeUndefined();
    expect(clients.slice(1, 8).every((client) => client.disposeCalls === 0)).toBe(true);
    await expect(service.waitForStop(ids[1]!, { timeoutMs: 5_000 })).rejects.toThrow(/terminated/);
    await service.killByOwner(ctx.ownerWindowId, 'test');
  });

  it('名额满且没有 terminated 会话 → 仍报上限,不回收运行中的会话', async () => {
    let pid = 5000;
    const clients: FakeDapClient[] = [];
    const { processOps } = makeFakeService();
    const service = new DebugService({
      createDapClient: () => {
        const client = new FakeDapClient((pid += 1));
        clients.push(client);
        return client;
      },
      processOps,
      workspace: PERMISSIVE_WORKSPACE,
    });
    for (let i = 0; i < 8; i += 1) await service.launchSession({ program: '/fixture.js', cwd: '/work' }, ctx);
    // 别的窗口的 terminated 会话不能顶替本窗口的名额
    await service.launchSession({ program: '/fixture.js', cwd: '/work' }, { ...ctx, ownerWindowId: 41 });
    clients[8]!.emit('terminated', {});

    await expect(service.launchSession({ program: '/fixture.js', cwd: '/work' }, ctx)).rejects.toThrow(/limit/);
    expect(clients.every((client) => client.disposeCalls === 0)).toBe(true);
    expect(service.listSessions()).toHaveLength(9);
    await service.cleanupAll('test');
  });

  it('launch 后未起跑:返回 starting,不发 configurationDone / launch', async () => {
    const { service, parent } = makeFakeService();
    const launched = await service.launchSession({ program: '/fixture.js', cwd: '/work' }, ctx);

    expect(launched.state).toBe('starting');
    expect(service.listSessions()[0]?.state).toBe('starting');
    const commands = parent.requestLog.map((r) => r.command);
    expect(commands).not.toContain('configurationDone');
    expect(commands).not.toContain('launch');
  });

  it('不设断点直接 wait_for_stop → 先 configurationDone 再 launch,程序真正起跑', async () => {
    const { service, parent } = makeFakeService();
    const { session_id: sessionId } = await service.launchSession(
      { program: '/fixture.js', cwd: '/work', stopOnEntry: true },
      ctx,
    );

    const waiting = service.waitForStop(sessionId, { timeoutMs: 5_000 });
    await vi.waitFor(() => expect(parent.requestLog.some((r) => r.command === 'launch')).toBe(true));
    const commands = parent.requestLog.map((r) => r.command);
    expect(commands.indexOf('configurationDone')).toBeGreaterThanOrEqual(0);
    expect(commands.indexOf('configurationDone')).toBeLessThan(commands.indexOf('launch'));
    expect(service.listSessions()[0]?.state).toBe('running');

    parent.emit('stopped', { reason: 'entry', threadId: 0 });
    await expect(waiting).resolves.toMatchObject({ reason: 'entry' });
  });

  it('尚无停点时 continue → 让程序起跑并返回 continued,不发 continue / threads', async () => {
    const { service, parent } = makeFakeService();
    const { session_id: sessionId } = await service.launchSession(
      { program: '/fixture.js', cwd: '/work' },
      ctx,
    );

    await expect(service.continue(sessionId, {})).resolves.toMatchObject({ continued: true });
    const commands = parent.requestLog.map((r) => r.command);
    expect(commands).toContain('launch');
    expect(commands).not.toContain('continue');
    expect(commands).not.toContain('threads');
  });

  it('并发 wait_for_stop 与 continue 只起跑一次', async () => {
    const { service, parent } = makeFakeService();
    const { session_id: sessionId } = await service.launchSession(
      { program: '/fixture.js', cwd: '/work' },
      ctx,
    );

    const waiting = service.waitForStop(sessionId, { timeoutMs: 5_000 });
    waiting.catch(() => undefined);
    await service.continue(sessionId, {});
    await vi.waitFor(() => expect(parent.requestLog.some((r) => r.command === 'launch')).toBe(true));
    expect(parent.requestLog.filter((r) => r.command === 'configurationDone')).toHaveLength(1);
    expect(parent.requestLog.filter((r) => r.command === 'launch')).toHaveLength(1);
    await service.disconnect(sessionId);
  });

  it('起跑前连设多个断点 → 全部在 launch 之前发出(设断点本身不让程序起跑)', async () => {
    const { service, parent } = makeFakeService();
    const { session_id: sessionId } = await service.launchSession(
      { program: '/fixture.js', cwd: '/work' },
      ctx,
    );

    await service.setBreakpoints(sessionId, { file: '/a.js', line: 3 });
    await service.setBreakpoints(sessionId, { file: '/a.js', line: 7 });
    expect(parent.requestLog.some((r) => r.command === 'launch')).toBe(false);

    const waiting = service.waitForStop(sessionId, { timeoutMs: 5_000 });
    waiting.catch(() => undefined);
    await vi.waitFor(() => expect(parent.requestLog.some((r) => r.command === 'launch')).toBe(true));
    const commands = parent.requestLog.map((r) => r.command);
    expect(commands.lastIndexOf('setBreakpoints')).toBeLessThan(commands.indexOf('launch'));
    await service.disconnect(sessionId);
  });

  function setBreakpointRequests(client: FakeDapClient) {
    return client.requestLog
      .filter((r) => r.command === 'setBreakpoints')
      .map((r) => r.args as { source: { path: string }; breakpoints: Array<{ line: number }> });
  }

  it('同一文件第二个断点 → 发该 source 的完整集合(不覆盖第一个),返回本次新设的那个', async () => {
    const { service, parent } = makeFakeService();
    const { session_id: sessionId } = await service.launchSession(
      { program: '/fixture.js', cwd: '/work' },
      ctx,
    );

    await service.setBreakpoints(sessionId, { file: '/a.js', line: 3 });
    const second = await service.setBreakpoints(sessionId, { file: '/a.js', line: 7 });

    expect(setBreakpointRequests(parent).at(-1)).toMatchObject({
      source: { path: '/a.js' },
      breakpoints: [{ line: 3 }, { line: 7 }],
    });
    expect(second).toMatchObject({ verified: true, line: 7 });
  });

  it('同 file+line 去重;不同文件各自一组', async () => {
    const { service, parent } = makeFakeService();
    const { session_id: sessionId } = await service.launchSession(
      { program: '/fixture.js', cwd: '/work' },
      ctx,
    );

    await service.setBreakpoints(sessionId, { file: '/a.js', line: 3 });
    await service.setBreakpoints(sessionId, { file: '/b.js', line: 5 });
    const again = await service.setBreakpoints(sessionId, { file: '/a.js', line: 3 });

    const requests = setBreakpointRequests(parent);
    expect(requests[1]).toMatchObject({ source: { path: '/b.js' }, breakpoints: [{ line: 5 }] });
    expect(requests.at(-1)).toMatchObject({ source: { path: '/a.js' }, breakpoints: [{ line: 3 }] });
    expect(again).toMatchObject({ line: 3 });
  });

  // adapter 拒绝 / 超时:调用方拿到的是失败,该断点不得留在 runtime 集合里 —— 否则之后同文件再设断点
  // (发完整集合)或 child 建立时重放,会悄悄下发调用方以为没设上的断点。
  it('setBreakpoints 请求失败 → 回滚本次新增,后续完整集合 / child 重放不含它', async () => {
    const { service, parent } = makeFakeService();
    const { session_id: sessionId } = await service.launchSession(
      { program: '/fixture.js', cwd: '/work' },
      ctx,
    );
    await service.setBreakpoints(sessionId, { file: '/a.js', line: 3 });
    parent.beforeResponse = (command) =>
      command === 'setBreakpoints' ? Promise.reject(new Error('adapter rejected')) : undefined;
    await expect(service.setBreakpoints(sessionId, { file: '/a.js', line: 7 })).rejects.toThrow(
      'adapter rejected',
    );
    parent.beforeResponse = null;

    await service.setBreakpoints(sessionId, { file: '/a.js', line: 9 });
    expect(setBreakpointRequests(parent).at(-1)).toMatchObject({
      source: { path: '/a.js' },
      breakpoints: [{ line: 3 }, { line: 9 }],
    });
    await parent.triggerStartDebugging({ type: 'pwa-node' });
    expect(setBreakpointRequests(parent.children[0]!)).toEqual([
      expect.objectContaining({ source: { path: '/a.js' }, breakpoints: [{ line: 3 }, { line: 9 }] }),
    ]);
  });

  it('setBreakpoints 替换已有同行断点失败 → 恢复旧记录(不删掉原断点)', async () => {
    const { service, parent } = makeFakeService();
    const { session_id: sessionId } = await service.launchSession(
      { program: '/fixture.js', cwd: '/work' },
      ctx,
    );
    await service.setBreakpoints(sessionId, { file: '/a.js', line: 3 });
    parent.beforeResponse = (command) =>
      command === 'setBreakpoints' ? Promise.reject(new Error('timeout')) : undefined;
    await expect(
      service.setBreakpoints(sessionId, { file: '/a.js', line: 3, column: 5 }),
    ).rejects.toThrow('timeout');
    parent.beforeResponse = null;

    await service.setBreakpoints(sessionId, { file: '/a.js', line: 8 });
    expect(setBreakpointRequests(parent).at(-1)).toMatchObject({
      breakpoints: [{ line: 3 }, { line: 8 }],
    });
    expect(
      (setBreakpointRequests(parent).at(-1)!.breakpoints[0] as { column?: number }).column,
    ).toBeUndefined();
  });

  // 断点事件携带该 source 的完整集合(adapter 校正后的行),renderer 整组替换:同一逻辑断点第二次被校正到
  // 不同行时不留旧红点。
  it('breakpoints-changed 携带该 source 完整集合(校正后行号)', async () => {
    const { service, parent } = makeFakeService();
    const events: DebugViewEvent[] = [];
    service.setEventSink({ emit: (_owner, event) => events.push(event) });
    const { session_id: sessionId } = await service.launchSession(
      { program: '/fixture.js', cwd: '/work' },
      ctx,
    );
    await service.setBreakpoints(sessionId, { file: '/a.js', line: 3 });
    parent.adjustBreakpointLine = (line) => (line === 3 ? 4 : line);
    await service.setBreakpoints(sessionId, { file: '/a.js', line: 7 });

    expect(events.at(-1)).toEqual({
      type: 'breakpoints-changed',
      sessionId,
      file: '/a.js',
      breakpoints: [
        { file: '/a.js', line: 4, verified: true },
        { file: '/a.js', line: 7, verified: true },
      ],
    });
  });

  it('child session 建立时重放全部 source 的完整断点集合', async () => {
    const { service, parent } = makeFakeService();
    const { session_id: sessionId } = await service.launchSession(
      { program: '/fixture.js', cwd: '/work' },
      ctx,
    );
    await service.setBreakpoints(sessionId, { file: '/a.js', line: 3 });
    await service.setBreakpoints(sessionId, { file: '/a.js', line: 7 });
    await service.setBreakpoints(sessionId, { file: '/b.js', line: 5 });

    await parent.triggerStartDebugging({ type: 'pwa-node' });
    const childRequests = setBreakpointRequests(parent.children[0]!);
    expect(childRequests).toHaveLength(2);
    expect(childRequests).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ source: { path: '/a.js' }, breakpoints: [{ line: 3 }, { line: 7 }] }),
        expect.objectContaining({ source: { path: '/b.js' }, breakpoints: [{ line: 5 }] }),
      ]),
    );
  });

  /** 让 client 的前 N 次 setBreakpoints 响应挂起,由测试逐个放行 / 拒绝。 */
  function holdSetBreakpoints(client: FakeDapClient) {
    const held: Array<{ resolve: () => void; reject: (err: Error) => void }> = [];
    client.beforeResponse = (command) => {
      if (command !== 'setBreakpoints') return undefined;
      return new Promise<void>((resolve, reject) => held.push({ resolve, reject }));
    };
    return held;
  }

  // 同 session 同 source 的并发设置必须串行:否则 B 捕获的完整集合含未完成的 A,A 失败回滚时 B 已把 A
  // 设进 adapter。
  it('同 source 并发 setBreakpoints 串行:前一个失败回滚后,后一个下发的集合不含它', async () => {
    const { service, parent } = makeFakeService();
    const { session_id: sessionId } = await service.launchSession(
      { program: '/fixture.js', cwd: '/work' },
      ctx,
    );
    await service.setBreakpoints(sessionId, { file: '/a.js', line: 3 });
    const held = holdSetBreakpoints(parent);
    const a = service.setBreakpoints(sessionId, { file: '/a.js', line: 7 });
    const b = service.setBreakpoints(sessionId, { file: '/a.js', line: 9 });
    await vi.waitFor(() => expect(held.length).toBeGreaterThanOrEqual(1));
    // A 在途时 B 还没发。
    expect(setBreakpointRequests(parent)).toHaveLength(2);
    parent.beforeResponse = null;
    held[0]!.reject(new Error('adapter rejected'));
    await expect(a).rejects.toThrow('adapter rejected');
    await b;
    expect(setBreakpointRequests(parent).at(-1)).toMatchObject({
      source: { path: '/a.js' },
      breakpoints: [{ line: 3 }, { line: 9 }],
    });
  });

  it('同 source 并发 setBreakpoints:响应乱序也不会让旧快照事件覆盖新断点', async () => {
    const { service, parent } = makeFakeService();
    const events: DebugViewEvent[] = [];
    service.setEventSink({ emit: (_owner, event) => events.push(event) });
    const { session_id: sessionId } = await service.launchSession(
      { program: '/fixture.js', cwd: '/work' },
      ctx,
    );
    const held = holdSetBreakpoints(parent);
    const a = service.setBreakpoints(sessionId, { file: '/a.js', line: 3 });
    const b = service.setBreakpoints(sessionId, { file: '/a.js', line: 7 });
    await vi.waitFor(() => expect(held.length).toBeGreaterThanOrEqual(1));
    // 未串行时 B 此时也已在途,先放行 B 再放行 A 即构成乱序。
    held.at(-1)!.resolve();
    held[0]!.resolve();
    await vi.waitFor(() => expect(held).toHaveLength(2));
    held[1]!.resolve();
    await Promise.all([a, b]);
    const last = events.filter((e) => e.type === 'breakpoints-changed').at(-1);
    expect(last).toMatchObject({
      file: '/a.js',
      breakpoints: [
        { file: '/a.js', line: 3 },
        { file: '/a.js', line: 7 },
      ],
    });
  });

  // 超时 ≠ adapter 没应用:失败回滚后要把回滚后的完整集合补发给父连接与存活的 child,尽力而为。
  it('setBreakpoints 失败回滚后向父连接与存活 child 补发回滚后的集合;补发失败不改变原错误', async () => {
    const { service, parent } = makeFakeService();
    const { session_id: sessionId } = await service.launchSession(
      { program: '/fixture.js', cwd: '/work' },
      ctx,
    );
    await parent.triggerStartDebugging({ type: 'pwa-node' });
    const child = parent.children[0]!;
    await service.setBreakpoints(sessionId, { file: '/a.js', line: 3 });
    let calls = 0;
    parent.beforeResponse = (command) => {
      if (command !== 'setBreakpoints') return undefined;
      calls += 1;
      // 首发超时;补发也失败(连接已坏)→ 忽略。
      return Promise.reject(new Error(calls === 1 ? 'timeout' : 'resync failed'));
    };
    await expect(service.setBreakpoints(sessionId, { file: '/a.js', line: 7 })).rejects.toThrow(
      'timeout',
    );
    const parentRequests = setBreakpointRequests(parent);
    expect(parentRequests.at(-2)).toMatchObject({ breakpoints: [{ line: 3 }, { line: 7 }] });
    expect(parentRequests.at(-1)).toMatchObject({
      source: { path: '/a.js' },
      breakpoints: [{ line: 3 }],
    });
    expect(setBreakpointRequests(child).at(-1)).toMatchObject({
      source: { path: '/a.js' },
      breakpoints: [{ line: 3 }],
    });
    expect(
      parent.timeoutLog.filter((r) => r.command === 'setBreakpoints').at(-1)?.timeoutMs,
    ).toBeLessThanOrEqual(3_000);
  });

  // adapter 把多个请求校正到同一行:快照按校正后的位置去重(保留首个),renderer 不出现重复 file:line。
  it('breakpoints-changed 快照按校正后的位置去重', async () => {
    const { service, parent } = makeFakeService();
    const events: DebugViewEvent[] = [];
    service.setEventSink({ emit: (_owner, event) => events.push(event) });
    const { session_id: sessionId } = await service.launchSession(
      { program: '/fixture.js', cwd: '/work' },
      ctx,
    );
    parent.adjustBreakpointLine = (line) => (line === 3 || line === 4 ? 5 : line);
    await service.setBreakpoints(sessionId, { file: '/a.js', line: 3 });
    const second = await service.setBreakpoints(sessionId, { file: '/a.js', line: 4 });
    expect(second).toMatchObject({ line: 5 });
    expect(events.at(-1)).toEqual({
      type: 'breakpoints-changed',
      sessionId,
      file: '/a.js',
      breakpoints: [{ file: '/a.js', line: 5, verified: true }],
    });
  });

  // adapter 对未变化的完整集合可能返回空 / 短 breakpoints:缺项沿用该记录上次的校正结果,不回退到请求行。
  it('adapter 未回报某项 → 快照沿用上次校正行(去重照常)', async () => {
    const { service, parent } = makeFakeService();
    const events: DebugViewEvent[] = [];
    service.setEventSink({ emit: (_owner, event) => events.push(event) });
    const { session_id: sessionId } = await service.launchSession(
      { program: '/fixture.js', cwd: '/work' },
      ctx,
    );
    parent.adjustBreakpointLine = (line) => (line === 3 || line === 4 ? 5 : line);
    await service.setBreakpoints(sessionId, { file: '/a.js', line: 3 });
    await service.setBreakpoints(sessionId, { file: '/a.js', line: 4 });
    parent.emptyBreakpointsResponse = true;
    await service.setBreakpoints(sessionId, { file: '/a.js', line: 3 });
    expect(events.at(-1)).toEqual({
      type: 'breakpoints-changed',
      sessionId,
      file: '/a.js',
      breakpoints: [{ file: '/a.js', line: 5, verified: true }],
    });
    // 从未得到回报的新记录才用请求行。
    await service.setBreakpoints(sessionId, { file: '/a.js', line: 9 });
    expect(events.at(-1)).toMatchObject({
      breakpoints: [
        { file: '/a.js', line: 5 },
        { file: '/a.js', line: 9 },
      ],
    });
  });

  // 工具返回值与快照同源:缺项时也沿用上次回报,而不是伪报 {verified:true} 并丢掉校正行 / message。
  it('adapter 未回报本次那项 → 返回值沿用上次的校正行、verified 与 message', async () => {
    const { service, parent } = makeFakeService();
    const { session_id: sessionId } = await service.launchSession(
      { program: '/fixture.js', cwd: '/work' },
      ctx,
    );
    parent.adjustBreakpointLine = (line) => (line === 3 ? 5 : line);
    parent.unverifiedLines.add(3);
    const first = await service.setBreakpoints(sessionId, { file: '/a.js', line: 3 });
    expect(first).toEqual({ verified: false, line: 5, message: 'pending' });
    parent.emptyBreakpointsResponse = true;
    const again = await service.setBreakpoints(sessionId, { file: '/a.js', line: 3 });
    expect(again).toEqual({ verified: false, line: 5, message: 'pending' });
  });

  // Windows:编辑器 tab 路径来自原生对话框 / listDir(反斜杠)。首次以正斜杠拼写设断点时,发给 adapter 与
  // 推给 renderer 的路径须归一成反斜杠,否则 renderer 按路径匹配 tab 失败、gutter 不显示红点。
  it('Windows:首次拼写为正斜杠 → 发送与推送的路径归一为反斜杠', async () => {
    platformMock.value = 'win32';
    const { service, parent } = makeFakeService();
    const events: DebugViewEvent[] = [];
    service.setEventSink({ emit: (_owner, event) => events.push(event) });
    const { session_id: sessionId } = await service.launchSession(
      { program: 'C:\\repo\\fixture.js', cwd: 'C:\\repo' },
      ctx,
    );
    await service.setBreakpoints(sessionId, { file: 'C:/repo/a.js', line: 3 });
    expect(setBreakpointRequests(parent).at(-1)).toMatchObject({
      source: { path: 'C:\\repo\\a.js' },
    });
    expect(events.at(-1)).toMatchObject({
      file: 'C:\\repo\\a.js',
      breakpoints: [{ file: 'C:\\repo\\a.js', line: 3 }],
    });
  });

  // Windows 路径大小写不敏感、`/` 与 `\` 等价:js-debug 视为同一 source,这里也必须合并成一个完整集合,
  // 否则第二次整组替换会删掉第一个断点。
  it('Windows:同一 source 的不同拼写合并为一个集合,沿用首次拼写', async () => {
    platformMock.value = 'win32';
    const { service, parent } = makeFakeService();
    const events: DebugViewEvent[] = [];
    service.setEventSink({ emit: (_owner, event) => events.push(event) });
    const { session_id: sessionId } = await service.launchSession(
      { program: 'C:\\repo\\fixture.js', cwd: 'C:\\repo' },
      ctx,
    );
    await service.setBreakpoints(sessionId, { file: 'C:\\repo\\a.js', line: 3 });
    await service.setBreakpoints(sessionId, { file: 'c:/repo/a.js', line: 7 });
    expect(setBreakpointRequests(parent).at(-1)).toMatchObject({
      source: { path: 'C:\\repo\\a.js' },
      breakpoints: [{ line: 3 }, { line: 7 }],
    });
    expect(events.at(-1)).toMatchObject({
      file: 'C:\\repo\\a.js',
      breakpoints: [
        { file: 'C:\\repo\\a.js', line: 3 },
        { file: 'C:\\repo\\a.js', line: 7 },
      ],
    });
    await parent.triggerStartDebugging({ type: 'pwa-node' });
    expect(setBreakpointRequests(parent.children[0]!)).toEqual([
      expect.objectContaining({
        source: { path: 'C:\\repo\\a.js' },
        breakpoints: [{ line: 3 }, { line: 7 }],
      }),
    ]);
  });

  // 分组键与记录拼写同一规则(normalize):含 `..` / `.` / 重复分隔符的拼写是同一真实文件,必须合并为
  // 一个集合,否则第二次整组替换会删掉第一个断点。
  // adapter 之后用 `breakpoint` 事件(reason:changed)把 pending 断点更新为 verified / 校正行:须按 id 更新
  // 记录并推快照,否则之后对未变化集合的空响应 fallback 返回过期的 pending,renderer 红点也不更新。
  it('breakpoint changed 事件 → 更新记录并推快照;之后空响应重设返回最新状态', async () => {
    const { service, parent } = makeFakeService();
    const events: DebugViewEvent[] = [];
    service.setEventSink({ emit: (_owner, event) => events.push(event) });
    const { session_id: sessionId } = await service.launchSession(
      { program: '/fixture.js', cwd: '/work' },
      ctx,
    );
    parent.unverifiedLines.add(3);
    expect(await service.setBreakpoints(sessionId, { file: '/a.js', line: 3 })).toEqual({
      verified: false,
      line: 3,
      message: 'pending',
    });
    const id = parent.lastBreakpointIds[0]!;
    parent.emit('breakpoint', { reason: 'changed', breakpoint: { id, verified: true, line: 4 } });
    const changed = {
      type: 'breakpoints-changed',
      sessionId,
      file: '/a.js',
      breakpoints: [{ file: '/a.js', line: 4, verified: true }],
    };
    expect(events.at(-1)).toEqual(changed);

    parent.emptyBreakpointsResponse = true;
    expect(await service.setBreakpoints(sessionId, { file: '/a.js', line: 3 })).toEqual({
      verified: true,
      line: 4,
    });
    expect(events.at(-1)).toEqual(changed);
  });

  // 真实 js-debug:id 按连接各自编号(父连接 [2,3] 与 child 重放 [1,2] 指同一组断点),changed 事件来自 child。
  // 必须按「哪条连接 + id」找记录,不能跨连接串号。
  it('child 连接的 breakpoint changed 事件按该连接的 id 更新(不与父连接的 id 串号);new / removed / 未知 id 忽略', async () => {
    const { service, parent } = makeFakeService();
    const events: DebugViewEvent[] = [];
    service.setEventSink({ emit: (_owner, event) => events.push(event) });
    const { session_id: sessionId } = await service.launchSession(
      { program: '/fixture.js', cwd: '/work' },
      ctx,
    );
    await service.setBreakpoints(sessionId, { file: '/a.js', line: 3 });
    await service.setBreakpoints(sessionId, { file: '/a.js', line: 7 });
    expect(parent.lastBreakpointIds).toEqual([2, 3]);
    await parent.triggerStartDebugging({ type: 'pwa-node' });
    const child = parent.children[0]!;
    expect(child.lastBreakpointIds).toEqual([1, 2]);
    const before = events.length;
    child.emit('breakpoint', { reason: 'new', breakpoint: { id: 2, verified: true, line: 99 } });
    child.emit('breakpoint', { reason: 'removed', breakpoint: { id: 2, verified: true, line: 99 } });
    child.emit('breakpoint', { reason: 'changed', breakpoint: { id: 42, verified: true, line: 99 } });
    expect(events.length).toBe(before);

    // child 的 id 2 = 第 7 行(父连接的 id 2 是第 3 行)。
    child.emit('breakpoint', { reason: 'changed', breakpoint: { id: 2, verified: true, line: 9 } });
    expect(events.at(-1)).toEqual({
      type: 'breakpoints-changed',
      sessionId,
      file: '/a.js',
      breakpoints: [
        { file: '/a.js', line: 3, verified: true },
        { file: '/a.js', line: 9, verified: true },
      ],
    });
  });

  // 真实 js-debug(纯 JS、无 source map):父连接回 pending,绑定结果只在 child 自己的 setBreakpoints 响应里,
  // 且不发 changed 事件。回报须按连接分别记录、聚合:任一存活连接 verified 即 verified。
  it('父连接回 pending、child 回 verified → 快照与返回值为 verified(child 重放后也推快照)', async () => {
    const { service, parent } = makeFakeService();
    const events: DebugViewEvent[] = [];
    service.setEventSink({ emit: (_owner, event) => events.push(event) });
    const { session_id: sessionId } = await service.launchSession(
      { program: '/fixture.js', cwd: '/work' },
      ctx,
    );
    parent.unverifiedLines.add(3);
    parent.unverifiedLines.add(7);
    parent.adjustBreakpointLine = (line) => line + 100; // 父连接未绑定时的行不可信
    expect(await service.setBreakpoints(sessionId, { file: '/a.js', line: 3 })).toEqual({
      verified: false,
      line: 103,
      message: 'pending',
    });
    // child 建立时重放:child 绑定成功 → 推快照,红点不再停在 pending。
    await parent.triggerStartDebugging({ type: 'pwa-node' });
    const child = parent.children[0]!;
    child.adjustBreakpointLine = (line) => (line === 3 ? 4 : line);
    expect(events.at(-1)).toEqual({
      type: 'breakpoints-changed',
      sessionId,
      file: '/a.js',
      breakpoints: [{ file: '/a.js', line: 3, verified: true }],
    });
    // 程序运行后新设断点:父 pending、child verified → 返回值取 child 的回报。
    expect(await service.setBreakpoints(sessionId, { file: '/a.js', line: 7 })).toEqual({
      verified: true,
      line: 7,
    });
    expect(events.at(-1)).toEqual({
      type: 'breakpoints-changed',
      sessionId,
      file: '/a.js',
      breakpoints: [
        { file: '/a.js', line: 4, verified: true },
        { file: '/a.js', line: 7, verified: true },
      ],
    });
  });

  it('运行后对同一 source 重设:父连接回 Unbound 不覆盖 child 上已 verified 的状态', async () => {
    const { service, parent } = makeFakeService();
    const events: DebugViewEvent[] = [];
    service.setEventSink({ emit: (_owner, event) => events.push(event) });
    const { session_id: sessionId } = await service.launchSession(
      { program: '/fixture.js', cwd: '/work' },
      ctx,
    );
    await service.setBreakpoints(sessionId, { file: '/a.js', line: 3 });
    await parent.triggerStartDebugging({ type: 'pwa-node' });
    parent.unverifiedLines.add(3);
    expect(await service.setBreakpoints(sessionId, { file: '/a.js', line: 3 })).toEqual({
      verified: true,
      line: 3,
    });
    expect(events.at(-1)).toMatchObject({
      breakpoints: [{ file: '/a.js', line: 3, verified: true }],
    });
  });

  it('verified 的 child 结束 → 它的回报不再参与聚合,快照与返回值回落到父连接的回报', async () => {
    const { service, parent } = makeFakeService();
    const events: DebugViewEvent[] = [];
    service.setEventSink({ emit: (_owner, event) => events.push(event) });
    const { session_id: sessionId } = await service.launchSession(
      { program: '/fixture.js', cwd: '/work' },
      ctx,
    );
    parent.unverifiedLines.add(3);
    await service.setBreakpoints(sessionId, { file: '/a.js', line: 3 });
    await parent.triggerStartDebugging({ type: 'pwa-node' });
    await parent.triggerStartDebugging({ type: 'pwa-node' });
    const [main, worker] = parent.children as [FakeDapClient, FakeDapClient];
    worker.unverifiedLines.add(3);
    expect(await service.setBreakpoints(sessionId, { file: '/a.js', line: 3 })).toMatchObject({
      verified: true,
    });
    main.emit('terminated', {}); // worker 仍在:会话未结束
    expect(events.at(-1)).toEqual({
      type: 'breakpoints-changed',
      sessionId,
      file: '/a.js',
      breakpoints: [{ file: '/a.js', line: 3, verified: false, message: 'pending' }],
    });
    expect(await service.setBreakpoints(sessionId, { file: '/a.js', line: 3 })).toEqual({
      verified: false,
      line: 3,
      message: 'pending',
    });
  });

  // 真实 js-debug(纯 JS、起跑前设的断点):父连接与 child 重放都回 provisional,也不发 changed 事件,
  // 唯一的绑定信号是 stopped 的 hitBreakpointIds。命中即在该连接上已绑定。
  it('stopped 的 hitBreakpointIds → 该连接上对应断点记为 verified 并推快照(按该连接的 id)', async () => {
    const { service, parent } = makeFakeService();
    const events: DebugViewEvent[] = [];
    service.setEventSink({ emit: (_owner, event) => events.push(event) });
    const { session_id: sessionId } = await service.launchSession(
      { program: '/fixture.js', cwd: '/work' },
      ctx,
    );
    await parent.triggerStartDebugging({ type: 'pwa-node' });
    const child = parent.children[0]!;
    parent.nextBreakpointId = 10; // 两条连接编号错开,检验按「连接 + id」找记录
    parent.unverifiedLines.add(3).add(7);
    child.unverifiedLines.add(3).add(7);
    await service.setBreakpoints(sessionId, { file: '/a.js', line: 3 });
    await service.setBreakpoints(sessionId, { file: '/a.js', line: 7 });
    expect(parent.lastBreakpointIds).toEqual([11, 12]);
    expect(child.lastBreakpointIds).toEqual([2, 3]);
    // 父连接上没有 id 2(那是 child 的编号):忽略。
    parent.emit('stopped', { reason: 'entry', threadId: 0, hitBreakpointIds: [2] });
    expect(events.filter((e) => e.type === 'breakpoints-changed').at(-1)).toMatchObject({
      breakpoints: [{ line: 3, verified: false }, { line: 7, verified: false }],
    });
    // child 的 id 2 = 第 3 行。
    child.emit('stopped', { reason: 'entry', threadId: 0, hitBreakpointIds: [2] });
    expect(events.filter((e) => e.type === 'breakpoints-changed').at(-1)).toEqual({
      type: 'breakpoints-changed',
      sessionId,
      file: '/a.js',
      breakpoints: [
        { file: '/a.js', line: 3, verified: true },
        { file: '/a.js', line: 7, verified: false, message: 'pending' },
      ],
    });
  });

  it('Windows:`..` / `.` / 重复分隔符的拼写合并为同一 source', async () => {
    platformMock.value = 'win32';
    const { service, parent } = makeFakeService();
    const { session_id: sessionId } = await service.launchSession(
      { program: 'C:\\repo\\fixture.js', cwd: 'C:\\repo' },
      ctx,
    );
    await service.setBreakpoints(sessionId, { file: 'C:\\repo\\a.js', line: 3 });
    await service.setBreakpoints(sessionId, { file: 'C:\\repo\\sub\\..\\a.js', line: 5 });
    await service.setBreakpoints(sessionId, { file: 'C:\\repo\\.\\a.js', line: 7 });
    await service.setBreakpoints(sessionId, { file: 'c:/repo//a.js', line: 9 });
    expect(setBreakpointRequests(parent).at(-1)).toEqual({
      source: { path: 'C:\\repo\\a.js' },
      breakpoints: [{ line: 3 }, { line: 5 }, { line: 7 }, { line: 9 }],
      sourceModified: false,
    });
  });

  it('非 Windows:`..` / `.` / 重复分隔符的拼写合并为同一 source(发送规范化路径)', async () => {
    platformMock.value = 'darwin';
    const { service, parent } = makeFakeService();
    const { session_id: sessionId } = await service.launchSession(
      { program: '/repo/fixture.js', cwd: '/repo' },
      ctx,
    );
    await service.setBreakpoints(sessionId, { file: '/repo/sub/../a.js', line: 3 });
    await service.setBreakpoints(sessionId, { file: '/repo/./a.js', line: 5 });
    await service.setBreakpoints(sessionId, { file: '/repo//a.js', line: 7 });
    expect(setBreakpointRequests(parent).at(-1)).toEqual({
      source: { path: '/repo/a.js' },
      breakpoints: [{ line: 3 }, { line: 5 }, { line: 7 }],
      sourceModified: false,
    });
  });

  it('Windows:另一种拼写设断点失败 → 回滚补发保留首个断点 [10]', async () => {
    platformMock.value = 'win32';
    const { service, parent } = makeFakeService();
    const { session_id: sessionId } = await service.launchSession(
      { program: 'C:\\repo\\fixture.js', cwd: 'C:\\repo' },
      ctx,
    );
    await service.setBreakpoints(sessionId, { file: 'C:\\repo\\a.js', line: 10 });
    let calls = 0;
    parent.beforeResponse = (command) => {
      if (command !== 'setBreakpoints') return undefined;
      calls += 1;
      return calls === 1 ? Promise.reject(new Error('timeout')) : undefined;
    };
    await expect(
      service.setBreakpoints(sessionId, { file: 'c:/repo/a.js', line: 20 }),
    ).rejects.toThrow('timeout');
    expect(setBreakpointRequests(parent).at(-1)).toMatchObject({
      source: { path: 'C:\\repo\\a.js' },
      breakpoints: [{ line: 10 }],
    });
  });

  // js-debug 按 Node 实际加载的真实路径匹配脚本:软链拼写(macOS /var → /private/var)设的断点在脚本加载后回
  // Unbound。发给 adapter 的 path 与分组键基于 realpath;推给 renderer 的仍是调用方拼写(编辑器 tab 路径来自
  // 用户选的 workspace root,未必是真实路径)。
  it('断点 file 为软链拼写 → 发给 adapter 的是 realpath,推给 renderer 的仍是原拼写;两种拼写同组', async () => {
    const workspace: DebugWorkspaceGuard = {
      getWorkspaceRoot: () => '/',
      realpath: async (p) => p.replace(/^\/link\//, '/real/'),
    };
    const { service, parent } = makeFakeService(new FakeDapClient(1001), workspace);
    const events: DebugViewEvent[] = [];
    service.setEventSink({ emit: (_owner, event) => events.push(event) });
    const { session_id: sessionId } = await service.launchSession(
      { program: '/real/fixture.js', cwd: '/real' },
      ctx,
    );
    await service.setBreakpoints(sessionId, { file: '/link/a.js', line: 3 });
    expect(setBreakpointRequests(parent).at(-1)).toMatchObject({ source: { path: '/real/a.js' } });
    expect(events.at(-1)).toMatchObject({
      type: 'breakpoints-changed',
      file: '/link/a.js',
      breakpoints: [{ file: '/link/a.js', line: 3 }],
    });
    await service.setBreakpoints(sessionId, { file: '/real/a.js', line: 5 });
    expect(setBreakpointRequests(parent).at(-1)).toMatchObject({
      source: { path: '/real/a.js' },
      breakpoints: [{ line: 3 }, { line: 5 }],
    });
  });

  it('断点 file realpath 失败(文件不存在等)→ 沿用原路径,不报错', async () => {
    const workspace: DebugWorkspaceGuard = {
      getWorkspaceRoot: () => '/',
      // launch 的 workspace 闸也走 realpath:只让断点文件失败。
      realpath: async (p) => {
        if (p.startsWith('/missing/')) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
        return p;
      },
    };
    const { service, parent } = makeFakeService(new FakeDapClient(1001), workspace);
    const { session_id: sessionId } = await service.launchSession(
      { program: '/fixture.js', cwd: '/work' },
      ctx,
    );
    await expect(service.setBreakpoints(sessionId, { file: '/missing/a.js', line: 3 })).resolves.toMatchObject({
      verified: true,
    });
    expect(setBreakpointRequests(parent).at(-1)).toMatchObject({ source: { path: '/missing/a.js' } });
  });

  // realpath 须在串行队列内:在队列外 await 时,同一真实文件经不同拼写并发设断点,realpath 慢的旧调用会在
  // 快的新调用之后入队,旧定义覆盖新定义。
  it('同一真实文件不同拼写并发设断点:realpath 慢的旧调用不会覆盖后调用的定义', async () => {
    let releaseSlow!: () => void;
    const slowGate = new Promise<void>((resolve) => {
      releaseSlow = resolve;
    });
    const workspace: DebugWorkspaceGuard = {
      getWorkspaceRoot: () => '/',
      realpath: async (p) => {
        if (p.startsWith('/link/')) {
          await slowGate;
          return p.replace(/^\/link\//, '/real/');
        }
        return p;
      },
    };
    const { service, parent } = makeFakeService(new FakeDapClient(1001), workspace);
    const { session_id: sessionId } = await service.launchSession(
      { program: '/real/fixture.js', cwd: '/real' },
      ctx,
    );
    const older = service.setBreakpoints(sessionId, { file: '/link/a.js', line: 3, column: 1 });
    const newer = service.setBreakpoints(sessionId, { file: '/real/a.js', line: 3, column: 7 });
    // 让快的那次有机会先跑完(未串行 realpath 时它此时已下发)。
    await new Promise((resolve) => setTimeout(resolve, 10));
    releaseSlow();
    await Promise.all([older, newer]);
    expect(setBreakpointRequests(parent).at(-1)).toMatchObject({
      source: { path: '/real/a.js' },
      breakpoints: [{ line: 3, column: 7 }],
    });
  });

  // 文件尚不存在时 realpath 失败按调用方拼写分组;文件创建后同拼写再设断点 realpath 成功按真实路径分组。
  // 两组推给 renderer 的 file 相同,不合并的话第二次只下发自己那组、renderer 整组替换隐藏前一组。
  it('realpath 先失败后成功 → fallback 组并入真实路径组,下发完整集合,快照只有一组', async () => {
    let exists = false;
    const workspace: DebugWorkspaceGuard = {
      getWorkspaceRoot: () => '/',
      realpath: async (p) => {
        if (p.startsWith('/link/')) {
          if (!exists) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
          return p.replace(/^\/link\//, '/real/');
        }
        return p;
      },
    };
    const { service, parent } = makeFakeService(new FakeDapClient(1001), workspace);
    const events: DebugViewEvent[] = [];
    service.setEventSink({ emit: (_owner, event) => events.push(event) });
    const { session_id: sessionId } = await service.launchSession(
      { program: '/real/fixture.js', cwd: '/real' },
      ctx,
    );
    await service.setBreakpoints(sessionId, { file: '/link/a.js', line: 3 });
    exists = true;
    await service.setBreakpoints(sessionId, { file: '/link/a.js', line: 5 });
    expect(setBreakpointRequests(parent).at(-1)).toMatchObject({
      source: { path: '/real/a.js' },
      breakpoints: [{ line: 3 }, { line: 5 }],
    });
    expect(events.filter((e) => e.type === 'breakpoints-changed').at(-1)).toMatchObject({
      file: '/link/a.js',
      breakpoints: [
        { file: '/link/a.js', line: 3 },
        { file: '/link/a.js', line: 5 },
      ],
    });
    // 只剩一组:child 建立时按 source 重放,只应发一次(真实路径)完整集合。
    await parent.triggerStartDebugging({ type: 'pwa-node' });
    const childRequests = setBreakpointRequests(parent.children[0]!);
    expect(childRequests).toHaveLength(1);
    expect(childRequests[0]).toMatchObject({
      source: { path: '/real/a.js' },
      breakpoints: [{ line: 3 }, { line: 5 }],
    });
  });

  // 反方向:先 realpath 成功按真实路径分组,之后目标文件被删 realpath 失败。不得按调用方拼写新建 fallback 组 ——
  // 否则 adapter 只收到新那行,renderer 同显示路径的单项快照整组替换隐藏旧行。
  it('realpath 先成功后失败 → 沿用已关联的真实路径组,下发完整集合,快照只有一组', async () => {
    let exists = true;
    const workspace: DebugWorkspaceGuard = {
      getWorkspaceRoot: () => '/',
      realpath: async (p) => {
        if (p.startsWith('/link/')) {
          if (!exists) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
          return p.replace(/^\/link\//, '/real/');
        }
        return p;
      },
    };
    const { service, parent } = makeFakeService(new FakeDapClient(1001), workspace);
    const events: DebugViewEvent[] = [];
    service.setEventSink({ emit: (_owner, event) => events.push(event) });
    const { session_id: sessionId } = await service.launchSession(
      { program: '/real/fixture.js', cwd: '/real' },
      ctx,
    );
    await service.setBreakpoints(sessionId, { file: '/link/a.js', line: 3 });
    exists = false;
    await service.setBreakpoints(sessionId, { file: '/link/a.js', line: 5 });
    expect(setBreakpointRequests(parent).at(-1)).toMatchObject({
      source: { path: '/real/a.js' },
      breakpoints: [{ line: 3 }, { line: 5 }],
    });
    expect(events.filter((e) => e.type === 'breakpoints-changed').at(-1)).toMatchObject({
      file: '/link/a.js',
      breakpoints: [
        { file: '/link/a.js', line: 3 },
        { file: '/link/a.js', line: 5 },
      ],
    });
    await parent.triggerStartDebugging({ type: 'pwa-node' });
    const childRequests = setBreakpointRequests(parent.children[0]!);
    expect(childRequests).toHaveLength(1);
    expect(childRequests[0]).toMatchObject({
      source: { path: '/real/a.js' },
      breakpoints: [{ line: 3 }, { line: 5 }],
    });
  });

  // 同一行改 column 是新的断点定义:不得继承旧定义在各连接上的回报 / id —— 否则 child 同步失败(被 allSettled
  // 吞掉)时聚合仍用旧 child 的 verified:true。完全相同的重设才继承(见「运行后对同一 source 重设」)。
  it('同一行 column 变化 → 不沿用旧定义的回报;child 同步失败时如实回落到父连接的回报', async () => {
    const { service, parent } = makeFakeService();
    const { session_id: sessionId } = await service.launchSession(
      { program: '/fixture.js', cwd: '/work' },
      ctx,
    );
    await service.setBreakpoints(sessionId, { file: '/a.js', line: 3 });
    await parent.triggerStartDebugging({ type: 'pwa-node' });
    const child = parent.children[0]!;
    child.beforeResponse = (command) => {
      if (command === 'setBreakpoints') throw new Error('child gone');
    };
    parent.unverifiedLines.add(3);
    expect(await service.setBreakpoints(sessionId, { file: '/a.js', line: 3, column: 5 })).toEqual({
      verified: false,
      line: 3,
      message: 'pending',
    });
  });

  // 真实 DapClient 在同一 data 回调里同步处理同一 chunk 的全部消息:先 resolve setBreakpoints 响应、再分发紧随
  // 其后的 breakpoint changed 事件,此时 await 续体还没登记新 id → 事件按 id 查不到。须暂存、登记 id 后补上。
  it('setBreakpoints 响应与 breakpoint changed 同 chunk 到达(事件先于续体)→ 事件不丢,登记 id 后生效', async () => {
    const { service, parent } = makeFakeService();
    const events: DebugViewEvent[] = [];
    service.setEventSink({ emit: (_owner, event) => events.push(event) });
    const { session_id: sessionId } = await service.launchSession(
      { program: '/fixture.js', cwd: '/work' },
      ctx,
    );
    parent.unverifiedLines.add(3);
    const original = parent.sendRequest.bind(parent);
    parent.sendRequest = async (command, args, timeoutMs) => {
      const response = await original(command, args, timeoutMs);
      if (command === 'setBreakpoints') {
        const id = parent.lastBreakpointIds[0]!;
        parent.emit('breakpoint', { reason: 'changed', breakpoint: { id, verified: true, line: 4 } });
      }
      return response;
    };
    expect(await service.setBreakpoints(sessionId, { file: '/a.js', line: 3 })).toEqual({
      verified: true,
      line: 4,
    });
    expect(events.at(-1)).toEqual({
      type: 'breakpoints-changed',
      sessionId,
      file: '/a.js',
      breakpoints: [{ file: '/a.js', line: 4, verified: true }],
    });
  });
});

describe('DebugService fake adapter · 资源上限(结束的 child 回收 / variables 展开预算)', () => {
  const ctx = { ownerWindowId: 21, controllerToken: 'agent-cap' };

  interface RuntimeView {
    readonly childClients: readonly unknown[];
    readonly breakpoints: ReadonlyArray<{
      readonly reportedBy: ReadonlyMap<unknown, unknown>;
      readonly ids: ReadonlyMap<unknown, unknown>;
    }>;
    readonly pendingBreakpointChanges: ReadonlyMap<unknown, unknown>;
  }
  // 内部状态无对外读口:内存是否随 worker 数增长只能看 runtime 本身。
  const runtimeOf = (service: DebugService, sessionId: string): RuntimeView =>
    (service as unknown as { runtimes: Map<string, RuntimeView> }).runtimes.get(sessionId)!;

  it('主线程存活、反复创建并结束 worker → 结束的 child 被移除并 dispose,按连接的断点记录不随次数增长;teardown 不再对它们发 disconnect', async () => {
    const { service, parent } = makeFakeService();
    const { session_id: sessionId } = await service.launchSession(
      { program: '/fixture.js', cwd: '/work' },
      ctx,
    );
    await service.setBreakpoints(sessionId, { file: '/a.js', line: 3 });
    await parent.triggerStartDebugging({ type: 'pwa-node' });
    const main = parent.children[0]!;

    const rounds = 30;
    for (let i = 0; i < rounds; i += 1) {
      await main.triggerStartDebugging({ type: 'pwa-node', name: `[worker ${i}]` });
      const worker = main.children[i]!;
      // 按 id 查不到记录的 changed 事件会暂存在该连接名下。
      worker.emit('breakpoint', { reason: 'changed', breakpoint: { id: 999, verified: true } });
      worker.emit(i % 2 === 0 ? 'terminated' : 'exited', {});
      worker.emit('exited', {}); // terminated 之后的 exited:重复结束无副作用
    }

    const runtime = runtimeOf(service, sessionId);
    expect(runtime.childClients).toEqual([main]);
    expect(debugSessions.get(sessionId)?.childSessionCount).toBe(1);
    for (const bp of runtime.breakpoints) {
      expect(bp.reportedBy.size).toBe(2); // 父连接 + main
      expect(bp.ids.size).toBe(2);
    }
    for (const worker of main.children) {
      expect(runtime.pendingBreakpointChanges.has(worker)).toBe(false);
      expect(worker.disposeCalls).toBe(1);
    }
    expect(service.listSessions()[0]?.state).not.toBe('terminated');

    await service.disconnect(sessionId);
    expect(main.children.every((worker) => worker.disconnectRequests === 0)).toBe(true);
    expect(main.disconnectRequests).toBe(1);
  });

  /** 每个 variables 请求都回满 count 个可展开成员(每个成员一个新的 variablesReference)。 */
  function wideVariablesAdapter(
    parent: FakeDapClient,
    onRequest?: () => void,
  ): { requests: () => number } {
    let requests = 0;
    let nextRef = 1_000;
    const original = parent.sendRequest.bind(parent);
    parent.sendRequest = async (command, args, timeoutMs) => {
      if (command !== 'variables') return original(command, args, timeoutMs);
      requests += 1;
      onRequest?.();
      const count = (args as { count: number }).count;
      return {
        seq: requests,
        type: 'response',
        request_seq: requests,
        success: true,
        command,
        body: {
          variables: Array.from({ length: count }, (_, i): DapJson => ({
            name: `m${i}`,
            value: 'Object',
            variablesReference: nextRef++,
          })),
        },
      };
    };
    return { requests: () => requests };
  }

  function countNodes(variables: readonly DebugVariable[]): number {
    return variables.reduce((sum, variable) => sum + 1 + countNodes(variable.children ?? []), 0);
  }

  it('debug.variables 深度展开有总预算:每层 100 个可展开成员时请求数与节点数封顶,并标 truncated', async () => {
    const { service, parent } = makeFakeService();
    const { session_id: sessionId } = await service.launchSession(
      { program: '/fixture.js', cwd: '/work' },
      ctx,
    );
    parent.emit('stopped', { reason: 'breakpoint', threadId: 1 });
    const adapter = wideVariablesAdapter(parent);

    const result = await service.variables(sessionId, {
      variablesReference: 44,
      count: 100,
      maxDepth: 5,
    });

    expect(adapter.requests()).toBeLessThanOrEqual(DEBUG_VARIABLES_EXPAND_MAX_REQUESTS);
    expect(countNodes(result.variables)).toBeLessThanOrEqual(DEBUG_VARIABLES_EXPAND_MAX_NODES);
    expect(result.truncated).toBe(true);
    // 顶层一页照常完整返回,预算内的节点照常展开;未展开的保留 variables_reference 并标 truncated。
    expect(result.variables).toHaveLength(100);
    expect(result.variables[0]!.children).toHaveLength(100);
    const unexpanded = result.variables.at(-1)!;
    expect(unexpanded.children).toBeUndefined();
    expect(unexpanded.variables_reference).toBeGreaterThan(0);
    expect(unexpanded.truncated).toBe(true);
  });

  it('debug.variables 展开中调用方断连(signal abort)→ 停止继续请求,以取消错误结束', async () => {
    const { service, parent } = makeFakeService();
    const { session_id: sessionId } = await service.launchSession(
      { program: '/fixture.js', cwd: '/work' },
      ctx,
    );
    parent.emit('stopped', { reason: 'breakpoint', threadId: 1 });
    const aborter = new AbortController();
    const adapter = wideVariablesAdapter(parent, () => {
      if (adapter.requests() === 3) aborter.abort();
    });

    await expect(
      service.variables(sessionId, {
        variablesReference: 44,
        count: 10,
        maxDepth: 5,
        signal: aborter.signal,
      }),
    ).rejects.toMatchObject({ code: 'AGENT_NOT_AUTHORIZED' });
    expect(adapter.requests()).toBe(3);
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

// 真实 js-debug adapter 下的两个场景(此前只能读代码推断,列为「需真机验证」):
//  - child session 建立之后再设的断点是否生效;
//  - 带 worker_threads 的程序:worker 先退出不能把整个会话判为终止。
describe.skipIf(!adapterExists)('DebugService real adapter · 晚设断点与 worker', () => {
  async function withRealService<T>(
    files: Record<string, string>,
    run: (ctx: { service: DebugService; dir: string }) => Promise<T>,
  ): Promise<T> {
    const adapterCopy = await prepareCommonJsAdapter();
    // 刻意**不**取真实路径:macOS 的 tmpdir 在 /var(→ /private/var 的软链)下,用户选的 workspace / 编辑器 tab
    // 路径同样可能是软链拼写。js-debug 按 Node 加载的真实路径匹配已加载脚本,DebugService 须自己 realpath 断点
    // file 再发给 adapter(否则运行后再设的断点回 Unbound)。
    const dir = await mkdtemp(path.join(tmpdir(), 'continuo-debug-real-'));
    for (const [name, text] of Object.entries(files)) {
      await writeFile(path.join(dir, name), text);
    }
    const service = new DebugService({
      adapterPath: adapterCopy.adapterPath,
      requestTimeoutMs: 30_000,
      workspace: { getWorkspaceRoot: () => dir, realpath: (p) => realpath(p) },
    });
    try {
      return await run({ service, dir });
    } finally {
      await service.cleanupAll('test finally').catch(() => undefined);
      await rm(adapterCopy.dir, { recursive: true, force: true });
      await rm(dir, { recursive: true, force: true });
    }
  }
  const ctx = { ownerWindowId: 9, controllerToken: 'agent-real' };

  // 真实 js-debug(TS + source map):起跑前的断点先回 provisional(verified:false),child 连接绑定后用
  // breakpoint changed 事件更新为 verified(并可能校正行)。快照须跟上,否则红点一直是 pending。
  it(
    '起跑前的 provisional 断点 → child 的 breakpoint changed 事件把快照更新为 verified',
    async () => {
      const adapterCopy = await prepareCommonJsAdapter();
      const service = new DebugService({
        adapterPath: adapterCopy.adapterPath,
        requestTimeoutMs: 30_000,
        workspace: { getWorkspaceRoot: () => spikeDir, realpath: async (p) => p },
      });
      const events: DebugViewEvent[] = [];
      service.setEventSink({ emit: (_owner, event) => events.push(event) });
      try {
        const { session_id: sessionId } = await service.launchSession(
          { program, cwd: spikeDir },
          ctx,
        );
        await service.setBreakpoints(sessionId, { file: breakpointFile, line: 14 });
        const first = await service.setBreakpoints(sessionId, { file: breakpointFile, line: 16 });
        expect(first.verified).toBe(false);
        await service.waitForStop(sessionId, { afterStopSeq: 0, timeoutMs: 40_000 });
        const last = events.filter((e) => e.type === 'breakpoints-changed').at(-1);
        expect(last).toMatchObject({
          file: breakpointFile,
          breakpoints: [
            { file: breakpointFile, line: 14, verified: true },
            expect.objectContaining({ file: breakpointFile, verified: true }),
          ],
        });
      } finally {
        await service.cleanupAll('test finally').catch(() => undefined);
        await rm(adapterCopy.dir, { recursive: true, force: true });
      }
    },
    120_000,
  );

  it(
    '第一次停住之后再设的断点(此时 child session 已建立)也会命中',
    async () => {
      const source = [
        'function step(n) { return n + 1; }', // 1
        'let x = 0;', // 2
        'x = step(x);', // 3 ← 第一个断点
        'x = step(x);', // 4
        'x = step(x);', // 5 ← 停住之后才设
        'console.log(x);', // 6
        '',
      ].join('\n');
      await withRealService({ 'late.js': source }, async ({ service, dir }) => {
        const file = path.join(dir, 'late.js');
        const { session_id: sessionId } = await service.launchSession(
          { program: file, cwd: dir },
          ctx,
        );
        await service.setBreakpoints(sessionId, { file, line: 3 });
        const first = await service.waitForStop(sessionId, { afterStopSeq: 0, timeoutMs: 40_000 });
        const firstStack = await service.stackTrace(sessionId, { startFrame: 0, levels: 1 });
        expect(firstStack.frames[0]?.line).toBe(3);

        await service.setBreakpoints(sessionId, { file, line: 5 });
        await service.continue(sessionId, {});
        const second = await service.waitForStop(sessionId, {
          afterStopSeq: first.stop_seq,
          timeoutMs: 20_000,
        });
        expect(second.stop_seq).toBeGreaterThan(first.stop_seq);
        const secondStack = await service.stackTrace(sessionId, { startFrame: 0, levels: 1 });
        expect(secondStack.frames[0]?.line).toBe(5);
      });
    },
    120_000,
  );

  // 真实 js-debug 按 Node 加载的真实路径匹配已加载脚本:脚本加载后(child 已建立)用软链拼写设的断点须先 realpath
  // 再发给 adapter,否则回 Unbound、永不命中。另建一层显式软链(Linux 的 tmpdir 不是软链),program / cwd / 断点
  // 都用软链拼写(用户选的 workspace root 即软链时就是这样)。
  it(
    '经软链路径在运行后设断点 → verified 且命中;推给 renderer 的 file 保持软链拼写',
    async () => {
      const adapterCopy = await prepareCommonJsAdapter();
      const realDir = await mkdtemp(path.join(tmpdir(), 'continuo-debug-symlink-'));
      const linkDir = `${realDir}-link`;
      await symlink(realDir, linkDir, 'dir');
      const source = [
        'function step(n) { return n + 1; }', // 1
        'let x = 0;', // 2
        'x = step(x);', // 3 ← 起跑前设
        'x = step(x);', // 4
        'x = step(x);', // 5 ← 停住之后才设
        'console.log(x);', // 6
        '',
      ].join('\n');
      await writeFile(path.join(realDir, 'linked.js'), source);
      const service = new DebugService({
        adapterPath: adapterCopy.adapterPath,
        requestTimeoutMs: 30_000,
        workspace: { getWorkspaceRoot: () => linkDir, realpath: (p) => realpath(p) },
      });
      const events: DebugViewEvent[] = [];
      service.setEventSink({ emit: (_owner, event) => events.push(event) });
      try {
        const file = path.join(linkDir, 'linked.js');
        const { session_id: sessionId } = await service.launchSession({ program: file, cwd: linkDir }, ctx);
        await service.setBreakpoints(sessionId, { file, line: 3 });
        const first = await service.waitForStop(sessionId, { afterStopSeq: 0, timeoutMs: 40_000 });
        expect(await service.setBreakpoints(sessionId, { file, line: 5 })).toMatchObject({
          verified: true,
          line: 5,
        });
        expect(events.filter((e) => e.type === 'breakpoints-changed').at(-1)).toMatchObject({
          file,
          breakpoints: [
            { file, line: 3, verified: true },
            { file, line: 5, verified: true },
          ],
        });
        await service.continue(sessionId, {});
        await service.waitForStop(sessionId, { afterStopSeq: first.stop_seq, timeoutMs: 20_000 });
        expect((await service.stackTrace(sessionId, { startFrame: 0, levels: 1 })).frames[0]?.line).toBe(5);
      } finally {
        await service.cleanupAll('test finally').catch(() => undefined);
        await rm(adapterCopy.dir, { recursive: true, force: true });
        await rm(linkDir, { force: true });
        await rm(realDir, { recursive: true, force: true });
      }
    },
    120_000,
  );

  it(
    '同一文件起跑前设两个断点 → 两个都命中(第二个不覆盖第一个)',
    async () => {
      const source = [
        'function step(n) { return n + 1; }', // 1
        'let x = 0;', // 2
        'x = step(x);', // 3 ← 断点 A
        'x = step(x);', // 4
        'x = step(x);', // 5 ← 断点 B(同文件)
        'console.log(x);', // 6
        '',
      ].join('\n');
      await withRealService({ 'two.js': source }, async ({ service, dir }) => {
        const file = path.join(dir, 'two.js');
        const { session_id: sessionId } = await service.launchSession({ program: file, cwd: dir }, ctx);
        await service.setBreakpoints(sessionId, { file, line: 3 });
        await service.setBreakpoints(sessionId, { file, line: 5 });
        const first = await service.waitForStop(sessionId, { afterStopSeq: 0, timeoutMs: 40_000 });
        expect((await service.stackTrace(sessionId, { startFrame: 0, levels: 1 })).frames[0]?.line).toBe(3);

        await service.continue(sessionId, {});
        await service.waitForStop(sessionId, { afterStopSeq: first.stop_seq, timeoutMs: 20_000 });
        expect((await service.stackTrace(sessionId, { startFrame: 0, levels: 1 })).frames[0]?.line).toBe(5);
      });
    },
    120_000,
  );

  // 真实 js-debug(纯 JS、无 source map):起跑前的断点父连接与 child 重放都回 provisional,停住前没有 changed
  // 事件(命中是唯一的绑定信号);停住后对同一 source 重设,父连接回 Unbound、child 回 verified。快照与返回值
  // 都须按连接聚合为 verified。
  it(
    '纯 JS:停住后快照为 verified;运行后重设同一 source 父连接回 Unbound 也仍为 verified',
    async () => {
      const source = [
        'function step(n) { return n + 1; }', // 1
        'let x = 0;', // 2
        'x = step(x);', // 3 ← 断点 A
        'x = step(x);', // 4
        'x = step(x);', // 5 ← 断点 B
        'console.log(x);', // 6
        '',
      ].join('\n');
      await withRealService({ 'plain.js': source }, async ({ service, dir }) => {
        const file = path.join(dir, 'plain.js');
        const events: DebugViewEvent[] = [];
        service.setEventSink({ emit: (_owner, event) => events.push(event) });
        const { session_id: sessionId } = await service.launchSession({ program: file, cwd: dir }, ctx);
        await service.setBreakpoints(sessionId, { file, line: 3 });
        await service.waitForStop(sessionId, { afterStopSeq: 0, timeoutMs: 40_000 });
        expect(events.filter((e) => e.type === 'breakpoints-changed').at(-1)).toMatchObject({
          file,
          breakpoints: [{ file, line: 3, verified: true }],
        });

        expect(await service.setBreakpoints(sessionId, { file, line: 5 })).toMatchObject({
          verified: true,
          line: 5,
        });
        expect(events.filter((e) => e.type === 'breakpoints-changed').at(-1)).toMatchObject({
          file,
          breakpoints: [
            { file, line: 3, verified: true },
            { file, line: 5, verified: true },
          ],
        });
      });
    },
    120_000,
  );

  it(
    '不设断点:launch 报 starting;stop_on_entry 下直接 wait_for_stop 能让程序起跑并停住',
    async () => {
      await withRealService({ 'entry.js': 'const a = 1;\nconsole.log(a);\n' }, async ({ service, dir }) => {
        const file = path.join(dir, 'entry.js');
        const launched = await service.launchSession(
          { program: file, cwd: dir, stopOnEntry: true },
          ctx,
        );
        expect(launched.state).toBe('starting');
        const stopped = await service.waitForStop(launched.session_id, { afterStopSeq: 0, timeoutMs: 40_000 });
        expect(stopped.stop_seq).toBeGreaterThan(0);
      });
    },
    120_000,
  );

  it(
    'worker 先退出 → 会话不被判为终止,主线程之后的断点仍然命中;主线程跑完才终止',
    async () => {
      const source = [
        "const { Worker, isMainThread } = require('node:worker_threads');", // 1
        'if (isMainThread) {', // 2
        '  const worker = new Worker(__filename);', // 3
        "  worker.on('exit', () => {", // 4
        '    setTimeout(() => {', // 5
        '      const done = 1;', // 6 ← worker 退出之后主线程才执行到
        "      console.log('main done', done);", // 7
        '    }, 300);', // 8
        '  });', // 9
        '}', // 10
        '',
      ].join('\n');
      await withRealService({ 'worker.js': source }, async ({ service, dir }) => {
        const file = path.join(dir, 'worker.js');
        const { session_id: sessionId } = await service.launchSession(
          { program: file, cwd: dir },
          ctx,
        );
        await service.setBreakpoints(sessionId, { file, line: 6 });
        const stopped = await service.waitForStop(sessionId, { afterStopSeq: 0, timeoutMs: 40_000 });
        const stack = await service.stackTrace(sessionId, { startFrame: 0, levels: 1 });
        expect(stack.frames[0]?.line).toBe(6);
        expect(service.listSessions()[0]?.state).toBe('stopped');

        await service.continue(sessionId, {});
        await expect(
          service.waitForStop(sessionId, { afterStopSeq: stopped.stop_seq, timeoutMs: 25_000 }),
        ).rejects.toThrow(/terminated|exited/);
      });
    },
    120_000,
  );
});
