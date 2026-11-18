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
  ScopeRequestThrottle,
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
let senderDestroyed = false;
const event = makeFakeEvent({ id: 1, isDestroyed: () => senderDestroyed });
const tokens = new Map<string, string>();

type SentCall = [string, { requestId: string }];
/** 已发往 renderer 的授权弹窗(不含「撤掉弹窗」通知)。 */
const promptCalls = (): SentCall[] =>
  (event.sender.send.mock.calls as SentCall[]).filter(([channel]) => channel === C.SCOPE_REQUEST);
const prompts = (): number => promptCalls().length;
/** 已发往 renderer 的「撤掉弹窗」通知里的 requestId。 */
const cancelledIds = (): string[] =>
  (event.sender.send.mock.calls as SentCall[])
    .filter(([channel]) => channel === C.SCOPE_REQUEST_CANCELLED)
    .map(([, payload]) => payload.requestId);

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
  const [, payload] = promptCalls()[before]!;
  await ipc.invokeWithEvent(event, C.SCOPE_DECISION, payload.requestId, decision);
  return { result: await pending, prompted: true };
}

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'scope-throttle-')));
  for (const d of ['a', 'b', 'a/sub']) await mkdir(join(root, d));
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
  vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
  event.sender.send.mockReset();
  senderDestroyed = false;
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

describe('每插件单飞(同一插件同时最多一个未决授权弹窗)', () => {
  interface Fired {
    readonly pending: Promise<unknown>;
    /** 这次请求发出的弹窗 requestId;没弹窗(直接收口)→ null。 */
    readonly requestId: string | null;
  }

  /** 发起 requestScope 但不应答:等到弹窗发出或请求直接收口为止。 */
  async function fire(pluginId: string, paths: readonly string[]): Promise<Fired> {
    const before = prompts();
    const pending = ipc.invokeWithEvent(
      event,
      C.REQUEST_SCOPE,
      tokens.get(pluginId),
      paths.map((path) => ({ path, mode: 'rw' as const })),
    );
    let settled = false;
    pending.then(
      () => (settled = true),
      () => (settled = true),
    );
    while (!settled && prompts() === before) await settle();
    return { pending, requestId: prompts() === before ? null : promptCalls()[before]![1].requestId };
  }

  /** 有一个未决弹窗时,同一插件再请求(别的目录)→ 直接 deny、不弹窗。 */
  async function expectBlocked(pluginId: string, tag: string): Promise<void> {
    const before = prompts();
    const second = await fire(pluginId, [join(root, `blocked-${tag}`)]);
    expect(second.requestId).toBeNull();
    expect(await second.pending).toBe('deny');
    expect(prompts()).toBe(before);
  }

  /** 上一个弹窗已收口 → 同一插件可以再弹(在途标记已释放)。 */
  async function expectReleased(pluginId: string, tag: string): Promise<void> {
    expect(await request(pluginId, [join(root, `released-${tag}`)], 'grant')).toEqual({
      result: 'grant',
      prompted: true,
    });
  }

  it('不等结果同步连发 10 次同一路径 → 只弹 1 个,其余直接 deny;拒绝后没有排队的弹窗', async () => {
    const dir = join(root, 'a');
    const all = Array.from({ length: 10 }, () =>
      ipc.invokeWithEvent(event, C.REQUEST_SCOPE, tokens.get('p'), [{ path: dir, mode: 'rw' }]),
    );
    const results: unknown[] = [];
    for (const p of all) void p.then((r) => results.push(r));
    for (let i = 0; i < 50 && results.length < 9; i += 1) await settle();
    expect(results).toEqual(Array(9).fill('deny'));
    expect(prompts()).toBe(1);

    await ipc.invokeWithEvent(event, C.SCOPE_DECISION, promptCalls()[0]![1].requestId, 'deny');
    expect(await Promise.all(all)).toEqual(Array(10).fill('deny'));
    expect(prompts()).toBe(1);
  });

  it('未决期间请求别的目录也直接 deny;别的插件不受影响;被单飞挡掉的请求不计入拒绝冷却', async () => {
    const first = await fire('p', [join(root, 'a')]);
    await expectBlocked('p', 'x');
    expect((await request('q', [join(root, 'a')], 'deny')).prompted).toBe(true);

    await ipc.invokeWithEvent(event, C.SCOPE_DECISION, first.requestId, 'grant');
    expect(await first.pending).toBe('grant');
    // 刚才被单飞挡掉的目录没有进入冷却,可以正常弹。
    expect((await request('p', [join(root, 'blocked-x')], 'grant')).prompted).toBe(true);
  });

  it('全部被拒、冷却到期后再连发 10 次 → 每个到期周期最多 1 个弹窗', async () => {
    const dir = join(root, 'a');
    for (let round = 0; round < 4; round += 1) {
      const before = prompts();
      const all = Array.from({ length: 10 }, () =>
        ipc.invokeWithEvent(event, C.REQUEST_SCOPE, tokens.get('p'), [{ path: dir, mode: 'rw' }]),
      );
      const results: unknown[] = [];
      for (const p of all) void p.then((r) => results.push(r));
      for (let i = 0; i < 50 && results.length < 9; i += 1) await settle();
      expect(results).toEqual(Array(9).fill('deny'));
      expect(prompts()).toBe(before + 1);
      await ipc.invokeWithEvent(event, C.SCOPE_DECISION, promptCalls()[before]![1].requestId, 'deny');
      await Promise.all(all);
      vi.advanceTimersByTime(SCOPE_DENY_COOLDOWN_MAX_MS);
    }
  });

  describe('每条收口路径都释放在途标记(否则该插件永远无法再请求 scope)', () => {
    it('用户允许', async () => {
      const first = await fire('p', [join(root, 'a')]);
      await expectBlocked('p', 'grant');
      await ipc.invokeWithEvent(event, C.SCOPE_DECISION, first.requestId, 'grant');
      expect(await first.pending).toBe('grant');
      await expectReleased('p', 'grant');
    });

    it('用户拒绝', async () => {
      const first = await fire('p', [join(root, 'a')]);
      await expectBlocked('p', 'deny');
      await ipc.invokeWithEvent(event, C.SCOPE_DECISION, first.requestId, 'deny');
      expect(await first.pending).toBe('deny');
      await expectReleased('p', 'deny');
    });

    it('TTL 超时(主进程 sweep)→ 请求 reject,并通知 renderer 撤掉弹窗', async () => {
      const first = await fire('p', [join(root, 'a')]);
      await expectBlocked('p', 'ttl');
      vi.advanceTimersByTime(60 * 60_000);
      correlator._sweep();
      await expect(first.pending).rejects.toThrow('request expired');
      expect(cancelledIds()).toEqual([first.requestId]);
      await expectReleased('p', 'ttl');
    });

    it('过期后才到的决定(resolve 时发现已过期,sweep 尚未跑)', async () => {
      const first = await fire('p', [join(root, 'a')]);
      await expectBlocked('p', 'late');
      vi.setSystemTime(Date.now() + 60 * 60_000); // 只拨时钟,不触发 correlator 的 GC 定时器
      await expect(
        ipc.invokeWithEvent(event, C.SCOPE_DECISION, first.requestId, 'grant'),
      ).rejects.toThrow('request expired');
      await expect(first.pending).rejects.toThrow('request expired');
      await expectReleased('p', 'late');
    });

    it('窗口关闭 / renderer reload(cancelBySender)', async () => {
      const first = await fire('p', [join(root, 'a')]);
      await expectBlocked('p', 'closed');
      senderDestroyed = true;
      correlator.cancelBySender(event.sender.id);
      expect(await first.pending).toBe('deny');
      senderDestroyed = false;
      await expectReleased('p', 'closed');
    });

    it('弹窗发送失败(sender 已销毁,send 抛错)', async () => {
      event.sender.send.mockImplementationOnce(() => {
        throw new Error('Object has been destroyed');
      });
      const pending = ipc.invokeWithEvent(event, C.REQUEST_SCOPE, tokens.get('p'), [
        { path: join(root, 'a'), mode: 'rw' },
      ]);
      expect(await pending).toBe('deny');
      await expectReleased('p', 'send');
    });

    it('插件卸载 / 禁用(_unregister-plugin)→ 未决请求按 deny 收口、通知 renderer 撤掉弹窗;不计入拒绝冷却', async () => {
      const dir = join(root, 'a');
      const first = await fire('p', [dir]);
      await expectBlocked('p', 'unregister');
      await ipc.invokeWithEvent(event, C.UNREGISTER_PLUGIN, tokens.get('p'));
      expect(await first.pending).toBe('deny');
      expect(cancelledIds()).toEqual([first.requestId]);
      // 迟到的决定不能再落地。
      await expect(
        ipc.invokeWithEvent(event, C.SCOPE_DECISION, first.requestId, 'grant'),
      ).rejects.toThrow();
      expect(scopes.getScopes('p')).toEqual([]);

      // 同 id 重新启用:同一目录可以立刻再弹(卸载收口不是用户拒绝)。
      await register('p');
      expect(await request('p', [dir], 'grant')).toEqual({ result: 'grant', prompted: true });
    });

    it('别的窗口里同一插件的实例被卸载 → 不影响本窗口实例的未决弹窗', async () => {
      const other = makeFakeEvent({ id: 2 });
      const otherToken = (
        (await ipc.invokeWithEvent(other, C.REGISTER_PLUGIN, 'p')) as { token: string }
      ).token;
      const first = await fire('p', [join(root, 'a')]);
      await ipc.invokeWithEvent(other, C.UNREGISTER_PLUGIN, otherToken);
      await expectBlocked('p', 'other-window');
      expect(cancelledIds()).toEqual([]);
      await ipc.invokeWithEvent(event, C.SCOPE_DECISION, first.requestId, 'deny');
      expect(await first.pending).toBe('deny');
    });
  });

  it('在途标记不随「记住的插件数」上限被淘汰', () => {
    const throttle = new ScopeRequestThrottle();
    expect(throttle.tryPrompt('victim', ['/x'], 0)).toBe(true);
    for (let i = 0; i < 1000; i += 1) {
      expect(throttle.tryPrompt(`other${i}`, ['/x'], 0)).toBe(true);
      throttle.endPrompt(`other${i}`);
    }
    expect(throttle.tryPrompt('victim', ['/y'], 0)).toBe(false);
    throttle.endPrompt('victim');
    expect(throttle.tryPrompt('victim', ['/y'], 0)).toBe(true);
  });
});

describe('插件级退避:退避期不算「无拒绝」', () => {
  it('退避到上限后,从退避结束(而非上次被拒)起满 SCOPE_DENY_FORGET_MS 无拒绝才清零', () => {
    const throttle = new ScopeRequestThrottle();
    let now = 1_000_000;
    let n = 0;
    const deny = (): void => {
      const path = [`/d${(n += 1)}`];
      expect(throttle.tryPrompt('p', path, now)).toBe(true);
      throttle.noteDecision('p', path, 'deny', now);
      throttle.endPrompt('p');
    };
    for (let i = 0; i < SCOPE_PLUGIN_DENY_STREAK; i += 1) deny();
    for (let i = 0; i < 12; i += 1) {
      now += SCOPE_DENY_COOLDOWN_MAX_MS;
      deny();
    }
    // 距上次被拒刚过 FORGET(其中前 SCOPE_DENY_COOLDOWN_MAX_MS 是退避期,不算无拒绝)→ 计数没清零:
    // 再被拒仍是上限退避,而不是从头再给 SCOPE_PLUGIN_DENY_STREAK 次。
    now += SCOPE_DENY_FORGET_MS + 1;
    deny();
    expect(throttle.tryPrompt('p', ['/after'], now + SCOPE_DENY_COOLDOWN_MAX_MS - 1)).toBe(false);
    // 退避结束后再安静满 FORGET → 清零。
    now += SCOPE_DENY_COOLDOWN_MAX_MS + SCOPE_DENY_FORGET_MS + 1;
    deny();
    expect(throttle.tryPrompt('p', ['/fresh'], now)).toBe(true);
  });
});
