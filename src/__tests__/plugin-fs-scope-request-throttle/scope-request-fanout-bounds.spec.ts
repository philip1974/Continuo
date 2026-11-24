// 安全:插件给的路径可以「很短的段 × 很多级」(8190 字符 ≈ 4080 级)。冷却键要逐级 stat 取文件身份,此前全量并发、
// 缺失的各级逐级拼接余下各段(键长是层级数的平方),且在任何节流判定之前:一次 requestScope 传 64 条这样的路径,
// 主进程事件循环卡死 10s、RSS +2.8GB,5 次并发堆耗尽。这里钉住:入口的层级上限、算键的 stat 次数 / 并发 / 键长
// 上限、被节流的请求不触发算键、plugin-fs 各操作 target 的层级上限。断言次数与字节数,不断言耗时。
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  FS_PATH_MAX,
  FS_PATH_MAX_DEPTH,
  MAX_SCOPE_PATH_DEPTH,
  MAX_SCOPE_REQUEST_COUNT,
  pathDepthExceeds,
  validateScopesShape,
} from '../../../electron/shared/fs-limits';
import { PLUGIN_FS_CHANNELS } from '../../../electron/shared/plugin-fs-channels';
import { IdentityRegistry } from '../../../electron/main/services/identity-registry.service';
import { PathScopeRegistry } from '../../../electron/main/services/path-scope-registry.service';
import { ScopeRequestCorrelator } from '../../../electron/main/services/scope-request-correlator';
import { registerPluginFsHandlers } from '../../../electron/main/services/plugin-fs.service';
import {
  SCOPE_KEY_MAX_CHARS,
  SCOPE_KEY_MAX_LEVELS,
  SCOPE_KEY_STAT_CONCURRENCY,
  SCOPE_PLUGIN_DENY_STREAK,
  ScopeRequestThrottle,
  scopeThrottleKeys,
} from '../../../electron/main/services/scope-request-throttle';
import { StubIpcMain, makeFakeEvent } from '../sdk-contract/integration/make-stub-ipc';
import { flushMacrotasks } from '../_helpers/async';

vi.mock('electron', () => ({ app: { getPath: vi.fn(() => '') } }));
// 真实实现,外加调用计数(plugin-fs.service 里的调用也经这个 mock)。
vi.mock('../../../electron/main/services/scope-request-throttle', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../../electron/main/services/scope-request-throttle')>();
  return { ...mod, scopeThrottleKeys: vi.fn(mod.scopeThrottleKeys) };
});

const C = PLUGIN_FS_CHANNELS;
const keysSpy = vi.mocked(scopeThrottleKeys);

/** `/a/a/…/a/<leaf>`:levels 级。 */
const deepPath = (levels: number, leaf: string, top = ''): string =>
  `${top}/${Array(levels - 1).fill('a').join('/')}/${leaf}`;

/** 计数的 stat 桩:只有 `/` 存在。记录调用次数与同时在途的最大数。 */
function countingStat() {
  const counters = { calls: 0, inFlight: 0, maxInFlight: 0 };
  const statOf = async (p: string): Promise<{ dev: bigint; ino: bigint }> => {
    counters.calls += 1;
    counters.inFlight += 1;
    counters.maxInFlight = Math.max(counters.maxInFlight, counters.inFlight);
    await new Promise((r) => setImmediate(r));
    counters.inFlight -= 1;
    if (p === '/') return { dev: 1n, ino: 2n };
    throw new Error('ENOENT');
  };
  return { counters, statOf };
}

describe('层级数上限(shared/fs-limits)', () => {
  it('pathDepthExceeds 按非空段计数,/ 与 \\ 都算分隔符', () => {
    expect(pathDepthExceeds('/a/b/c', 3)).toBe(false);
    expect(pathDepthExceeds('/a/b/c', 2)).toBe(true);
    expect(pathDepthExceeds('//a///b/', 2)).toBe(false);
    expect(pathDepthExceeds('C:\\a\\b', 3)).toBe(false);
    expect(pathDepthExceeds('C:\\a\\b', 2)).toBe(true);
    expect(pathDepthExceeds('~', 1)).toBe(false);
    expect(pathDepthExceeds('', 0)).toBe(false);
  });

  it('validateScopesShape:scope 路径最多 MAX_SCOPE_PATH_DEPTH 级;审计者的 8190 字符 4081 级路径被拒', () => {
    expect(validateScopesShape([{ path: deepPath(MAX_SCOPE_PATH_DEPTH, 'x'), mode: 'r' }])).toBeNull();
    expect(validateScopesShape([{ path: deepPath(MAX_SCOPE_PATH_DEPTH + 1, 'x'), mode: 'r' }])).toMatch(
      /levels deep/,
    );
    const audit = deepPath(4081, '0');
    expect(audit.length).toBeLessThanOrEqual(FS_PATH_MAX);
    expect(validateScopesShape([{ path: audit, mode: 'r' }])).toMatch(/levels deep/);
    // 普通路径不受影响
    expect(validateScopesShape([{ path: '~/Documents/project', mode: 'rw' }])).toBeNull();
  });
});

describe('scopeThrottleKeys:stat 次数、并发与键长有界', () => {
  it('审计复现的输入(64 条 × 4081 级)→ 不 stat,只给纯路径键', async () => {
    const paths = Array.from({ length: MAX_SCOPE_REQUEST_COUNT }, (_, i) => deepPath(4081, String(i)));
    const { counters, statOf } = countingStat();
    const keys = await scopeThrottleKeys(paths, statOf);
    expect(counters.calls).toBe(0);
    expect(keys).toEqual(paths);
  });

  it('层级数在上限内的最坏输入(64 条互不共享上级 × SCOPE_KEY_MAX_LEVELS 级,全部缺失)→ stat 次数、并发、键长都有上限', async () => {
    const paths = Array.from({ length: MAX_SCOPE_REQUEST_COUNT }, (_, i) =>
      deepPath(SCOPE_KEY_MAX_LEVELS - 1, 'leaf', `/top${i}`),
    );
    const { counters, statOf } = countingStat();
    const keys = await scopeThrottleKeys(paths, statOf);
    // 每条路径每级一次 + 共有的根一次
    expect(counters.calls).toBe(MAX_SCOPE_REQUEST_COUNT * SCOPE_KEY_MAX_LEVELS + 1);
    expect(counters.maxInFlight).toBeLessThanOrEqual(SCOPE_KEY_STAT_CONCURRENCY);
    for (const [i, key] of keys.entries()) {
      expect(key.length).toBeLessThanOrEqual(SCOPE_KEY_MAX_CHARS);
      // 线性:路径 + 每级一个定长身份(此前缺失的各级逐级拼接余下各段,这条路径的键约 30 万字符)
      expect(key.length).toBeLessThanOrEqual(paths[i]!.length + (SCOPE_KEY_MAX_LEVELS + 1) * 42);
      expect(key.startsWith(`${paths[i]}\0`)).toBe(true);
    }
    const totalBytes = keys.reduce((n, k) => n + Buffer.byteLength(k), 0);
    expect(totalBytes).toBeLessThanOrEqual(MAX_SCOPE_REQUEST_COUNT * SCOPE_KEY_MAX_CHARS);
  });

  it('各路径共有的上级只 stat 一次', async () => {
    const paths = Array.from({ length: MAX_SCOPE_REQUEST_COUNT }, (_, i) => `/p/q/r/s/dir${i}`);
    const { counters, statOf } = countingStat();
    await scopeThrottleKeys(paths, statOf);
    expect(counters.calls).toBe(MAX_SCOPE_REQUEST_COUNT + 5); // 64 个叶子 + /p/q/r/s、/p/q/r、/p/q、/p、/
  });

  it('层级数刚超过 SCOPE_KEY_MAX_LEVELS 的路径:纯路径键,字符串层的冷却仍然命中', async () => {
    const path = deepPath(SCOPE_KEY_MAX_LEVELS + 1, 'x');
    const { counters, statOf } = countingStat();
    const keys = await scopeThrottleKeys([path], statOf);
    expect(counters.calls).toBe(0);
    const throttle = new ScopeRequestThrottle();
    throttle.noteDecision('p', keys, 'deny', 0);
    expect(throttle.tryPrompt('p', await scopeThrottleKeys([path], statOf), 1)).toBe(false);
  });
});

describe('plugin-fs 入口', () => {
  let root: string;
  let ipc: StubIpcMain;
  let scopes: PathScopeRegistry;
  let correlator: ScopeRequestCorrelator;
  const event = makeFakeEvent({ id: 1 });
  let token: string;

  type SentCall = [string, { requestId: string }];
  const promptCalls = (): SentCall[] =>
    (event.sender.send.mock.calls as SentCall[]).filter(([channel]) => channel === C.SCOPE_REQUEST);
  const requestScope = (paths: readonly string[]): Promise<unknown> =>
    ipc.invokeWithEvent(event, C.REQUEST_SCOPE, token, paths.map((path) => ({ path, mode: 'rw' })));
  /** 发起请求并等弹窗发出;返回应答函数。 */
  async function prompted(paths: readonly string[]): Promise<(decision: 'grant' | 'deny') => Promise<unknown>> {
    const before = promptCalls().length;
    const pending = requestScope(paths);
    while (promptCalls().length === before) await flushMacrotasks(1, 'immediate');
    const [, payload] = promptCalls()[before]!;
    return async (decision) => {
      await ipc.invokeWithEvent(event, C.SCOPE_DECISION, payload.requestId, decision);
      return pending;
    };
  }

  beforeEach(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), 'scope-fanout-')));
    for (const d of ['a', 'b', 'c', 'd', 'e']) await mkdir(join(root, d));
    event.sender.send.mockReset();
    keysSpy.mockClear();
    ipc = new StubIpcMain();
    const identity = new IdentityRegistry();
    scopes = new PathScopeRegistry(identity);
    correlator = new ScopeRequestCorrelator({ ttlMs: 60 * 60_000 });
    registerPluginFsHandlers(ipc as never, {
      identityRegistry: identity,
      pathScopeRegistry: scopes,
      correlator,
    });
    token = ((await ipc.invokeWithEvent(event, C.REGISTER_PLUGIN, 'p')) as { token: string }).token;
  });

  afterEach(async () => {
    correlator.dispose();
    await rm(root, { recursive: true, force: true });
  });

  it('requestScope:审计复现的 64 条 × 4081 级路径 → 入口即拒(BAD_INPUT),不算键、不弹窗', async () => {
    const paths = Array.from({ length: MAX_SCOPE_REQUEST_COUNT }, (_, i) => deepPath(4081, String(i)));
    await expect(requestScope(paths)).rejects.toThrow(/levels deep/);
    expect(keysSpy).not.toHaveBeenCalled();
    expect(promptCalls()).toHaveLength(0);
  });

  it('requestScope:层级数超过 MAX_SCOPE_PATH_DEPTH 一级即拒;正常请求照常弹窗', async () => {
    await expect(requestScope([deepPath(MAX_SCOPE_PATH_DEPTH + 1, 'x', root)])).rejects.toThrow(/levels deep/);
    const answer = await prompted([join(root, 'a')]);
    expect(await answer('grant')).toBe('grant');
    expect(keysSpy).toHaveBeenCalledTimes(1);
  });

  it('该插件已有未决弹窗 → 新请求直接 deny,不算冷却键(不触发 stat 扇出)', async () => {
    const answer = await prompted([join(root, 'a')]);
    expect(keysSpy).toHaveBeenCalledTimes(1);
    for (let i = 0; i < 20; i++) expect(await requestScope([join(root, 'b', `n${i}`)])).toBe('deny');
    expect(keysSpy).toHaveBeenCalledTimes(1);
    await answer('deny');
  });

  it('插件级退避期内的请求直接 deny,不算冷却键', async () => {
    for (const d of ['a', 'b', 'c'].slice(0, SCOPE_PLUGIN_DENY_STREAK)) {
      expect(await (await prompted([join(root, d)]))('deny')).toBe('deny');
    }
    const calls = keysSpy.mock.calls.length;
    for (let i = 0; i < 20; i++) expect(await requestScope([join(root, 'd', `n${i}`)])).toBe('deny');
    expect(keysSpy).toHaveBeenCalledTimes(calls);
    expect(promptCalls()).toHaveLength(SCOPE_PLUGIN_DENY_STREAK);
  });

  describe('各 fs 操作的 target 层级上限(FS_PATH_MAX_DEPTH)', () => {
    beforeEach(async () => {
      expect(await (await prompted([root]))('grant')).toBe('grant');
    });
    /** 已授 scope 内、层级数为 levels 的(不存在的)路径。 */
    const inScope = (levels: number): string => {
      // 与 pathDepthExceeds 同口径:`/` 与 `\` 都算分隔符(Windows 上 root 形如 `C:\Users\...`)。
      const have = root.split(/[\\/]/).filter(Boolean).length;
      return `${root}/${Array(levels - have).fill('a').join('/')}`;
    };
    const ops: ReadonlyArray<[string, (target: string) => unknown[]]> = [
      [C.READ_FILE, (t) => [t]],
      [C.WRITE_FILE, (t) => [t, 'x']],
      [C.LIST_DIR, (t) => [t]],
      [C.STAT, (t) => [t]],
      [C.LSTAT, (t) => [t]],
      [C.REALPATH, (t) => [t]],
      [C.MKDIR, (t) => [t, { recursive: true }]],
      [C.RM, (t) => [t, { recursive: true }]],
      [C.RENAME, (t) => [t, join(root, 'renamed')]],
      [C.RENAME, (t) => [join(root, 'a'), t]],
      [C.CP, (t) => [t, join(root, 'copied')]],
      [C.CP, (t) => [join(root, 'a'), t]],
      [C.ATOMIC_REPLACE, (t) => [t, join(root, 'final')]],
    ];

    it.each(ops)('%s:scope 内的超深 target → invalid target path(不进 scope 校验的逐级处理)', async (channel, args) => {
      const tooDeep = inScope(FS_PATH_MAX_DEPTH + 1);
      expect(tooDeep.length).toBeLessThanOrEqual(FS_PATH_MAX);
      await expect(ipc.invokeWithEvent(event, channel, token, ...args(tooDeep))).rejects.toThrow(
        'invalid target path',
      );
    });

    it('审计者的 4080 级路径(8190 字符)同样在入口被拒', async () => {
      const audit = `${root}/${Array(4000).fill('a').join('/')}`;
      expect(audit.length).toBeLessThanOrEqual(FS_PATH_MAX);
      await expect(ipc.invokeWithEvent(event, C.STAT, token, audit)).rejects.toThrow('invalid target path');
    });

    it('层级数在上限内的路径不受影响(照常进 scope 校验:这里是「不存在」而不是「畸形」)', async () => {
      const ok = inScope(FS_PATH_MAX_DEPTH);
      const err = await ipc.invokeWithEvent(event, C.STAT, token, ok).then(
        () => null,
        (e: Error) => e,
      );
      expect(err).not.toBeNull();
      expect(err!.message).not.toContain('invalid target path');
      // 正常深度的真实文件照常可读写
      await ipc.invokeWithEvent(event, C.WRITE_FILE, token, join(root, 'a', 'f.txt'), 'hello');
      expect(await ipc.invokeWithEvent(event, C.READ_FILE, token, join(root, 'a', 'f.txt'))).toBe('hello');
    });
  });
});
