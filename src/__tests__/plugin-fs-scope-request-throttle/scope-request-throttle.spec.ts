// 安全:scope 授权请求被拒后有冷却 + 每插件弹窗速率上限,插件不能循环弹窗诱导误点。行为见同目录 README。
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PLUGIN_FS_CHANNELS } from '../../../electron/shared/plugin-fs-channels';
import { IdentityRegistry } from '../../../electron/main/services/identity-registry.service';
import { PathScopeRegistry } from '../../../electron/main/services/path-scope-registry.service';
import { ScopeRequestCorrelator } from '../../../electron/main/services/scope-request-correlator';
import { registerPluginFsHandlers } from '../../../electron/main/services/plugin-fs.service';
import {
  SCOPE_DENY_COOLDOWN_BASE_MS,
  SCOPE_DENY_COOLDOWN_MAX_MS,
  SCOPE_DENY_FORGET_MS,
  SCOPE_PLUGIN_DENY_STREAK,
  SCOPE_PROMPT_RATE_MAX,
  SCOPE_PROMPT_RATE_WINDOW_MS,
} from '../../../electron/main/services/scope-request-throttle';
import { StubIpcMain, makeFakeEvent } from '../sdk-contract/integration/make-stub-ipc';

vi.mock('electron', () => ({ app: { getPath: vi.fn(() => '') } }));

const C = PLUGIN_FS_CHANNELS;

let root: string;
let ipc: StubIpcMain;
let scopes: PathScopeRegistry;
let correlator: ScopeRequestCorrelator;
const event = makeFakeEvent({ id: 1, isDestroyed: () => false });
const tokens = new Map<string, string>();

const prompts = (): number => event.sender.send.mock.calls.length;

/** 等所有已排队的 microtask / fs 回调跑完(真实 fs + 假定时器:只假 Date / setTimeout,不假 setImmediate)。 */
const settle = (): Promise<void> => new Promise((r) => setImmediate(r));

async function register(pluginId: string): Promise<void> {
  const r = (await ipc.invokeWithEvent(event, C.REGISTER_PLUGIN, pluginId)) as { token: string };
  tokens.set(pluginId, r.token);
}

/**
 * 发起 requestScope。弹窗发出 → 按 decision 应答后返回结果与 prompted=true;
 * 没有弹窗(被冷却 / 限速直接拒、或已覆盖直接授予)→ prompted=false。
 */
async function request(
  pluginId: string,
  paths: readonly string[],
  decision: 'grant' | 'deny',
  mode: 'r' | 'rw' = 'r',
): Promise<{ result: unknown; prompted: boolean }> {
  const before = prompts();
  const pending = ipc.invokeWithEvent(
    event,
    C.REQUEST_SCOPE,
    tokens.get(pluginId),
    paths.map((path) => ({ path, mode })),
  );
  let settled = false;
  void pending.then(
    () => (settled = true),
    () => (settled = true),
  );
  while (!settled && prompts() === before) await settle();
  if (prompts() === before) return { result: await pending, prompted: false };
  const [, payload] = event.sender.send.mock.calls[before]! as [string, { requestId: string }];
  await ipc.invokeWithEvent(event, C.SCOPE_DECISION, payload.requestId, decision);
  return { result: await pending, prompted: true };
}

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'scope-throttle-')));
  for (const d of ['a', 'b', 'a/sub']) await mkdir(join(root, d));
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
  vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
  event.sender.send.mockClear();
  tokens.clear();
  ipc = new StubIpcMain();
  const identity = new IdentityRegistry();
  scopes = new PathScopeRegistry(identity);
  correlator = new ScopeRequestCorrelator({ ttlMs: 60 * 60_000, gcIntervalMs: 60 * 60_000 });
  registerPluginFsHandlers(ipc as never, {
    identityRegistry: identity,
    pathScopeRegistry: scopes,
    correlator,
    webContentsForSender: () => null,
  });
  await register('p');
  await register('q');
});

afterEach(async () => {
  correlator.dispose();
  vi.useRealTimers();
  await rm(root, { recursive: true, force: true });
});

describe('拒绝冷却', () => {
  it('被拒后立刻重复同一请求 → 直接 deny,不再弹窗(循环弹窗攻击)', async () => {
    const dir = join(root, 'a');
    expect(await request('p', [dir], 'deny')).toEqual({ result: 'deny', prompted: true });
    for (let i = 0; i < 20; i += 1) {
      expect(await request('p', [dir], 'grant')).toEqual({ result: 'deny', prompted: false });
    }
    expect(prompts()).toBe(1);
    expect(scopes.getScopes('p')).toEqual([]);
  });

  it('同一组 scope 与顺序 / 写法无关(归一化后比较)', async () => {
    const a = join(root, 'a');
    const b = join(root, 'b');
    await request('p', [a, b], 'deny');
    expect((await request('p', [b, `${a}/`], 'grant')).prompted).toBe(false);
  });

  it('冷却结束后可以再弹;这次允许 → 授予并清除拒绝记录', async () => {
    const dir = join(root, 'a');
    await request('p', [dir], 'deny');
    vi.advanceTimersByTime(SCOPE_DENY_COOLDOWN_BASE_MS - 1);
    expect((await request('p', [dir], 'grant')).prompted).toBe(false);
    vi.advanceTimersByTime(1);
    expect(await request('p', [dir], 'grant')).toEqual({ result: 'grant', prompted: true });
    expect(scopes.getScopes('p')).toEqual([{ path: dir, mode: 'r' }]);
  });

  it('连续被拒 → 冷却翻倍,封顶 SCOPE_DENY_COOLDOWN_MAX_MS', async () => {
    const dir = join(root, 'a');
    await request('p', [dir], 'deny');
    vi.advanceTimersByTime(SCOPE_DENY_COOLDOWN_BASE_MS);
    expect((await request('p', [dir], 'deny')).prompted).toBe(true); // 第 2 次被拒 → 冷却 2×
    vi.advanceTimersByTime(SCOPE_DENY_COOLDOWN_BASE_MS);
    expect((await request('p', [dir], 'grant')).prompted).toBe(false);
    vi.advanceTimersByTime(SCOPE_DENY_COOLDOWN_BASE_MS);
    expect((await request('p', [dir], 'deny')).prompted).toBe(true); // 第 3 次被拒 → 冷却 4×

    // 一直拒下去,冷却不超过上限。
    for (let i = 0; i < 10; i += 1) {
      vi.advanceTimersByTime(SCOPE_DENY_COOLDOWN_MAX_MS);
      expect((await request('p', [dir], 'deny')).prompted).toBe(true);
    }
    vi.advanceTimersByTime(SCOPE_DENY_COOLDOWN_MAX_MS - 1);
    expect((await request('p', [dir], 'grant')).prompted).toBe(false);
    vi.advanceTimersByTime(1);
    expect((await request('p', [dir], 'grant')).prompted).toBe(true);
  });

  it('距上次拒绝超过 SCOPE_DENY_FORGET_MS → 退避级别归零(再被拒只冷却基础时长)', async () => {
    const dir = join(root, 'a');
    await request('p', [dir], 'deny');
    vi.advanceTimersByTime(SCOPE_DENY_COOLDOWN_BASE_MS);
    await request('p', [dir], 'deny'); // 级别 2
    vi.advanceTimersByTime(SCOPE_DENY_FORGET_MS + 1);
    expect((await request('p', [dir], 'deny')).prompted).toBe(true); // 归零后重新从级别 1 计
    vi.advanceTimersByTime(SCOPE_DENY_COOLDOWN_BASE_MS);
    expect((await request('p', [dir], 'grant')).prompted).toBe(true);
  });

  it('按插件、按路径分别计:别的插件 / 别的目录不受影响', async () => {
    await request('p', [join(root, 'a')], 'deny');
    expect(await request('q', [join(root, 'a')], 'grant')).toEqual({ result: 'grant', prompted: true });
    expect(await request('p', [join(root, 'b')], 'grant')).toEqual({ result: 'grant', prompted: true });
  });
});

describe('拒绝冷却按单条路径计(换个组合 / mode 再问不算新请求)', () => {
  it('被拒的路径搭上别的目录再请求([a, n1]、[a, n2] …)→ 直接 deny,不弹窗', async () => {
    const a = join(root, 'a');
    await request('p', [a], 'deny');
    for (let i = 0; i < 5; i += 1) {
      expect(await request('p', [a, join(root, `n${i}`)], 'grant')).toEqual({ result: 'deny', prompted: false });
    }
    expect(prompts()).toBe(1);
    expect(scopes.getScopes('p')).toEqual([]);
  });

  it('r 被拒后换 rw 请求同一路径 → 不弹窗', async () => {
    const a = join(root, 'a');
    await request('p', [a], 'deny', 'r');
    expect(await request('p', [a], 'grant', 'rw')).toEqual({ result: 'deny', prompted: false });
  });

  it('被拒目录的父目录(扩大范围再问)→ 不弹窗;子目录(缩小范围)可以弹', async () => {
    await request('p', [join(root, 'a')], 'deny');
    expect(await request('p', [root], 'grant')).toEqual({ result: 'deny', prompted: false });
    expect(await request('p', [join(root, 'a', 'sub')], 'grant')).toEqual({ result: 'grant', prompted: true });
  });

  it('一组里被拒 → 组内每条路径各自进入冷却', async () => {
    const a = join(root, 'a');
    const b = join(root, 'b');
    await request('p', [a, b], 'deny');
    expect((await request('p', [b], 'grant')).prompted).toBe(false);
    expect((await request('p', [a], 'grant')).prompted).toBe(false);
  });
});

describe('插件级连续被拒退避', () => {
  /** 连续拒掉 n 个互不相干的目录(每次都弹了窗)。 */
  async function denyDistinct(n: number, tag: string): Promise<void> {
    for (let i = 0; i < n; i += 1) {
      expect((await request('p', [join(root, `${tag}${i}`)], 'deny')).prompted).toBe(true);
    }
  }

  it('连续 SCOPE_PLUGIN_DENY_STREAK 次被拒(每次不同目录)→ 该插件任何 scope 请求都直接 deny;别的插件不受影响', async () => {
    await denyDistinct(SCOPE_PLUGIN_DENY_STREAK, 'x');
    expect(await request('p', [join(root, 'fresh')], 'grant')).toEqual({ result: 'deny', prompted: false });
    expect((await request('q', [join(root, 'fresh')], 'grant')).prompted).toBe(true);

    vi.advanceTimersByTime(SCOPE_DENY_COOLDOWN_BASE_MS - 1);
    expect((await request('p', [join(root, 'fresh')], 'grant')).prompted).toBe(false);
    vi.advanceTimersByTime(1);
    expect((await request('p', [join(root, 'fresh')], 'deny')).prompted).toBe(true); // 再被拒 → 退避翻倍
    vi.advanceTimersByTime(SCOPE_DENY_COOLDOWN_BASE_MS * 2 - 1);
    expect((await request('p', [join(root, 'fresh2')], 'grant')).prompted).toBe(false);
    vi.advanceTimersByTime(1);
    expect((await request('p', [join(root, 'fresh2')], 'grant')).prompted).toBe(true);
  });

  it('退避指数增长但不超过 SCOPE_DENY_COOLDOWN_MAX_MS', async () => {
    await denyDistinct(SCOPE_PLUGIN_DENY_STREAK, 'x');
    for (let i = 0; i < 12; i += 1) {
      vi.advanceTimersByTime(SCOPE_DENY_COOLDOWN_MAX_MS);
      expect((await request('p', [join(root, `y${i}`)], 'deny')).prompted).toBe(true);
    }
    vi.advanceTimersByTime(SCOPE_DENY_COOLDOWN_MAX_MS - 1);
    expect((await request('p', [join(root, 'z')], 'grant')).prompted).toBe(false);
    vi.advanceTimersByTime(1);
    expect((await request('p', [join(root, 'z')], 'grant')).prompted).toBe(true);
  });

  it('用户授予一次 → 连续被拒计数清零', async () => {
    await denyDistinct(SCOPE_PLUGIN_DENY_STREAK - 1, 'x');
    expect((await request('p', [join(root, 'ok')], 'grant')).result).toBe('grant');
    await denyDistinct(SCOPE_PLUGIN_DENY_STREAK - 1, 'y');
    expect((await request('p', [join(root, 'still')], 'grant')).prompted).toBe(true);
  });

  it('距上次被拒超过 SCOPE_DENY_FORGET_MS → 计数清零', async () => {
    await denyDistinct(SCOPE_PLUGIN_DENY_STREAK - 1, 'x');
    vi.advanceTimersByTime(SCOPE_DENY_FORGET_MS + 1);
    await denyDistinct(1, 'y');
    expect((await request('p', [join(root, 'still')], 'grant')).prompted).toBe(true);
  });
});

describe('弹窗速率上限', () => {
  it('同一插件 60s 内最多 SCOPE_PROMPT_RATE_MAX 个弹窗(各请求不同目录),超出直接 deny;窗口滑过后恢复', async () => {
    // 每次都允许(各自不同目录,互不覆盖):只有速率上限在起作用,不触发拒绝冷却 / 插件级退避。
    for (let i = 0; i < SCOPE_PROMPT_RATE_MAX; i += 1) {
      expect((await request('p', [join(root, `n${i}`)], 'grant')).prompted).toBe(true);
    }
    expect(await request('p', [join(root, 'more')], 'grant')).toEqual({ result: 'deny', prompted: false });
    // 别的插件不受影响。
    expect((await request('q', [join(root, 'more')], 'deny')).prompted).toBe(true);

    vi.advanceTimersByTime(SCOPE_PROMPT_RATE_WINDOW_MS);
    expect(await request('p', [join(root, 'more')], 'grant')).toEqual({ result: 'grant', prompted: true });
  });

  it('已被现有授权覆盖的请求静默 grant,不计入速率、不受冷却影响', async () => {
    const dir = join(root, 'a');
    scopes.grant('p', [{ path: dir, mode: 'r' }]);
    for (let i = 0; i < SCOPE_PROMPT_RATE_MAX * 3; i += 1) {
      expect(await request('p', [dir], 'deny')).toEqual({ result: 'grant', prompted: false });
    }
    expect((await request('p', [join(root, 'b')], 'grant')).prompted).toBe(true);
  });
});
