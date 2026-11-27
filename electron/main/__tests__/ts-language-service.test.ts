// TDD: ts-language.service(main 侧语言服务进程管理)—— 懒启动、未保存文档的版本同步 / 重放、同槽取消、超时、崩溃重启与上限、
// 换根 / 重载 / 关窗结束进程;以及进程内消息循环 ts-server-loop 的排队取消。BDD: src/__tests__/editor-go-to-definition/
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createTsLanguageService,
  TS_CRASH_LIMIT,
  type TsLanguageService,
  type TsServerChild,
} from '../services/ts-language.service';
import { createTsServerLoop } from '../ts-language/ts-server-loop';
import type { TsServerRequest, TsServerResponse } from '../ts-language/ts-server-protocol';
import type { TsLanguageCore } from '../ts-language/ts-language-core';
import { TS_LANGUAGE_CHANNELS, type TsRequestInput } from '../../shared/ts-language';

class FakeChild implements TsServerChild {
  readonly sent: TsServerRequest[] = [];
  killed = false;
  private msg: ((m: unknown) => void) | null = null;
  private exit: ((code: number) => void) | null = null;
  postMessage(m: TsServerRequest) {
    this.sent.push(m);
  }
  onMessage(cb: (m: unknown) => void) {
    this.msg = cb;
  }
  onExit(cb: (code: number) => void) {
    this.exit = cb;
  }
  kill() {
    this.killed = true;
    this.exit?.(0);
  }
  reply(m: TsServerResponse) {
    this.msg?.(m);
  }
  crash() {
    this.exit?.(1);
  }
  lastDefinitionId(): number {
    const d = [...this.sent].reverse().find((m) => m.type === 'definition');
    return (d as { id: number }).id;
  }
}

const ROOT = '/w';
let children: FakeChild[];
let svc: TsLanguageService;
let sent: { channel: string; payload: unknown }[];
let clock: number;
const target = { id: 7, send: (channel: string, payload: unknown) => sent.push({ channel, payload }) };

const def = (over: Partial<TsRequestInput> = {}, slot: 'hover' | 'command' = 'command'): TsRequestInput => ({
  clientId: 'c1',
  docs: [],
  op: { kind: 'definition', slot, path: '/w/a.ts', line: 1, column: 1 },
  ...over,
});
const child = () => children[children.length - 1]!;
const ok = { type: 'result', origin: null, definitions: [] } as const;

beforeEach(() => {
  vi.useFakeTimers();
  children = [];
  sent = [];
  clock = 0;
  svc = createTsLanguageService({
    spawn: () => {
      const c = new FakeChild();
      children.push(c);
      return c;
    },
    now: () => clock,
    timeoutMs: 1000,
  });
});
afterEach(() => vi.useRealTimers());

describe('启动与路由', () => {
  it('懒启动:第一个请求才起进程,先 init(根 = 窗口工作区根)', async () => {
    expect(children).toHaveLength(0);
    const p = svc.request(target, ROOT, def());
    expect(children).toHaveLength(1);
    expect(child().sent[0]).toEqual({ type: 'init', root: ROOT });
    child().reply({ ...ok, id: child().lastDefinitionId() });
    await expect(p).resolves.toEqual({ status: 'ok', origin: null, definitions: [] });
  });

  it('无工作区 / 工作区外 / 非 TS 文件 → unavailable,不起进程', async () => {
    await expect(svc.request(target, null, def())).resolves.toEqual({ status: 'unavailable', reason: 'no-root' });
    const outside = def({ op: { kind: 'definition', slot: 'command', path: '/x/a.ts', line: 1, column: 1 } });
    await expect(svc.request(target, ROOT, outside)).resolves.toMatchObject({ reason: 'outside-root' });
    const md = def({ op: { kind: 'definition', slot: 'command', path: '/w/a.md', line: 1, column: 1 } });
    await expect(svc.request(target, ROOT, md)).resolves.toMatchObject({ reason: 'outside-root' });
    expect(children).toHaveLength(0);
  });

  it('预热:起进程并让其加载该文件的项目,立即返回', async () => {
    await expect(
      svc.request(target, ROOT, { clientId: 'c1', docs: [], op: { kind: 'warmup', path: '/w/a.ts' } }),
    ).resolves.toMatchObject({ status: 'ok' });
    expect(child().sent).toEqual([{ type: 'init', root: ROOT }, { type: 'warmup', path: '/w/a.ts' }]);
  });
});

describe('未保存文档', () => {
  it('带全文的版本同步给进程;下个请求只带版本号 → 不重发;版本不认识 → resync', async () => {
    void svc.request(target, ROOT, def({ docs: [{ path: '/w/b.ts', version: 1, text: 'B1' }] }));
    expect(child().sent[1]).toEqual({ type: 'sync', changes: [{ path: '/w/b.ts', text: 'B1' }] });
    const n = child().sent.length;
    void svc.request(target, ROOT, def({ docs: [{ path: '/w/b.ts', version: 1 }] }));
    expect(child().sent.slice(n).some((m) => m.type === 'sync')).toBe(false);
    await expect(svc.request(target, ROOT, def({ docs: [{ path: '/w/b.ts', version: 2 }] }))).resolves.toEqual({
      status: 'resync',
      paths: ['/w/b.ts'],
    });
  });

  it('不再列出的文档 → 从进程移除(回到磁盘内容);工作区外的文档忽略', () => {
    void svc.request(target, ROOT, def({ docs: [{ path: '/w/b.ts', version: 1, text: 'B1' }, { path: '/etc/x.ts', version: 1, text: 'X' }] }));
    expect(child().sent[1]).toEqual({ type: 'sync', changes: [{ path: '/w/b.ts', text: 'B1' }] });
    void svc.request(target, ROOT, def({ docs: [] }));
    expect(child().sent).toContainEqual({ type: 'sync', changes: [{ path: '/w/b.ts', text: null }] });
  });

  it('窗口重载(clientId 变)→ 结束旧进程、丢弃旧记录(只带版本号的文档要求 resync)', async () => {
    void svc.request(target, ROOT, def({ docs: [{ path: '/w/b.ts', version: 1, text: 'B1' }] }));
    const first = child();
    await expect(
      svc.request(target, ROOT, def({ clientId: 'c2', docs: [{ path: '/w/b.ts', version: 1 }] })),
    ).resolves.toMatchObject({ status: 'resync' });
    expect(first.killed).toBe(true);
  });
});

describe('取消与超时', () => {
  it('同槽新请求取代旧请求(旧的 cancelled,并通知进程取消);不同槽互不影响', async () => {
    const hover1 = svc.request(target, ROOT, def({}, 'hover'));
    const cmd = svc.request(target, ROOT, def({}, 'command'));
    const firstId = child().sent.find((m) => m.type === 'definition') as { id: number };
    const hover2 = svc.request(target, ROOT, def({}, 'hover'));
    await expect(hover1).resolves.toEqual({ status: 'cancelled' });
    expect(child().sent).toContainEqual({ type: 'cancel', id: firstId.id });
    child().reply({ ...ok, id: child().lastDefinitionId() });
    await expect(hover2).resolves.toMatchObject({ status: 'ok' });
    // 命令槽的请求仍在等
    let settled = false;
    void cmd.then(() => (settled = true));
    await Promise.resolve();
    expect(settled).toBe(false);
  });

  it('超时 → unavailable(timeout),并通知进程取消', async () => {
    const p = svc.request(target, ROOT, def());
    const id = child().lastDefinitionId();
    vi.advanceTimersByTime(1000);
    await expect(p).resolves.toEqual({ status: 'unavailable', reason: 'timeout' });
    expect(child().sent).toContainEqual({ type: 'cancel', id });
  });
});

describe('生命周期', () => {
  it('崩溃:在途请求 crashed + 推送 crashed 事件;下个请求重启并重放未保存文档', async () => {
    const p = svc.request(target, ROOT, def({ docs: [{ path: '/w/b.ts', version: 3, text: 'B3' }] }));
    child().crash();
    await expect(p).resolves.toEqual({ status: 'unavailable', reason: 'crashed' });
    expect(sent).toEqual([{ channel: TS_LANGUAGE_CHANNELS.EVENT, payload: { kind: 'crashed', fatal: false } }]);
    void svc.request(target, ROOT, def({ docs: [{ path: '/w/b.ts', version: 3 }] }));
    expect(children).toHaveLength(2);
    expect(child().sent.slice(0, 2)).toEqual([
      { type: 'init', root: ROOT },
      { type: 'sync', changes: [{ path: '/w/b.ts', text: 'B3' }] },
    ]);
  });

  it(`5 分钟内崩溃 ${TS_CRASH_LIMIT} 次 → 不再重启(fatal);重载后恢复`, async () => {
    for (let i = 0; i < TS_CRASH_LIMIT; i++) {
      clock += 1000;
      void svc.request(target, ROOT, def());
      child().crash();
    }
    expect(sent[sent.length - 1]).toEqual({ channel: TS_LANGUAGE_CHANNELS.EVENT, payload: { kind: 'crashed', fatal: true } });
    const n = children.length;
    await expect(svc.request(target, ROOT, def())).resolves.toEqual({ status: 'unavailable', reason: 'fatal' });
    expect(children).toHaveLength(n);
    void svc.request(target, ROOT, def({ clientId: 'reloaded' }));
    expect(children).toHaveLength(n + 1);
  });

  it('崩溃间隔超过 5 分钟的不累计', async () => {
    for (let i = 0; i < TS_CRASH_LIMIT + 2; i++) {
      clock += 2 * 60_000;
      void svc.request(target, ROOT, def());
      child().crash();
    }
    expect(sent.every((e) => (e.payload as { fatal: boolean }).fatal === false)).toBe(true);
  });

  it('换工作区根 → 结束旧进程,按新根启动;关窗 / 重载(dispose)→ 结束进程,在途请求 cancelled,不算崩溃', async () => {
    void svc.request(target, ROOT, def());
    const first = child();
    void svc.request(target, '/v', def({ op: { kind: 'definition', slot: 'command', path: '/v/a.ts', line: 1, column: 1 } }));
    expect(first.killed).toBe(true);
    expect(child().sent[0]).toEqual({ type: 'init', root: '/v' });
    const p = svc.request(target, '/v', def({ op: { kind: 'definition', slot: 'hover', path: '/v/a.ts', line: 1, column: 1 } }));
    svc.dispose(target.id);
    await expect(p).resolves.toEqual({ status: 'cancelled' });
    expect(child().killed).toBe(true);
    expect(sent).toEqual([]);
  });
});

describe('进程内消息循环(ts-server-loop)', () => {
  function fakeCore(): TsLanguageCore & { calls: string[] } {
    const calls: string[] = [];
    return {
      calls,
      applyChanges: (c) => void calls.push(`sync:${c.map((x) => x.path).join(',')}`),
      warmup: (p) => void calls.push(`warmup:${p}`),
      definition: (p, line, column) => {
        calls.push(`def:${p}:${line}:${column}`);
        return { origin: null, definitions: [] };
      },
      dispose: () => void calls.push('dispose'),
    };
  }

  it('排队中的请求收到 cancel → 不计算,回 cancelled;sync 立即生效于其后的请求', () => {
    const core = fakeCore();
    const out: TsServerResponse[] = [];
    const tasks: (() => void)[] = [];
    const loop = createTsServerLoop((m) => out.push(m), () => core, (fn) => tasks.push(fn));
    loop.handle({ type: 'init', root: '/w' });
    loop.handle({ type: 'definition', id: 1, path: '/w/a.ts', line: 1, column: 1 });
    loop.handle({ type: 'definition', id: 2, path: '/w/a.ts', line: 2, column: 1 });
    loop.handle({ type: 'cancel', id: 1 });
    loop.handle({ type: 'sync', changes: [{ path: '/w/b.ts', text: 'x' }] });
    while (tasks.length > 0) tasks.shift()!();
    expect(out).toEqual([
      { type: 'cancelled', id: 1 },
      { type: 'result', id: 2, origin: null, definitions: [] },
    ]);
    expect(core.calls).toEqual(['sync:/w/b.ts', 'def:/w/a.ts:2:1']);
  });

  it('计算抛错 → error 回应,循环继续', () => {
    const core = fakeCore();
    core.definition = () => {
      throw new Error('boom');
    };
    const out: TsServerResponse[] = [];
    const tasks: (() => void)[] = [];
    const loop = createTsServerLoop((m) => out.push(m), () => core, (fn) => tasks.push(fn));
    loop.handle({ type: 'init', root: '/w' });
    loop.handle({ type: 'definition', id: 1, path: '/w/a.ts', line: 1, column: 1 });
    loop.handle({ type: 'warmup', path: '/w/a.ts' });
    while (tasks.length > 0) tasks.shift()!();
    expect(out).toEqual([{ type: 'error', id: 1, message: 'boom' }]);
  });
});
