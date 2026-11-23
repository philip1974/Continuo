// 性能(受保护根的 inode 判定):同一「代际」(两次 plugin-fs 变更之间)内,目录前缀与受保护根的 (dev, ino)
// 只 stat 一次;独占锁被授予 / TTL 到期 / 条目超限即失效。行为见同目录 README「身份缓存」。
// 真实 PathScopeRegistry + 真实临时目录;计数用例数的是 node:fs promises 的 stat + lstat 调用次数。
import { promises as fsp } from 'node:fs';
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PLUGIN_FS_CHANNELS as C } from '../../../electron/shared/plugin-fs-channels';
import { IdentityRegistry } from '../../../electron/main/services/identity-registry.service';
import {
  PathScopeRegistry,
  type PathScopeRegistryOptions,
} from '../../../electron/main/services/path-scope-registry.service';
import { ScopeRequestCorrelator } from '../../../electron/main/services/scope-request-correlator';
import { pluginFsIdentityEpoch, registerPluginFsHandlers } from '../../../electron/main/services/plugin-fs.service';
import { StubIpcMain, makeFakeEvent } from '../sdk-contract/integration/make-stub-ipc';

vi.mock('electron', () => ({ app: { getPath: vi.fn(() => '') } }));

const PLUGIN = 'plugin.cache';
const DENIED = 'target not in any granted scope';
const SENDER = 1;
const TTL = 250;

let root: string;
let home: string; // rw scope
let appLink: string; // 受保护根的写法:符号链接,起初指向 realA
let realA: string;
let realB: string; // 链接改指到这里之后,只有 inode 判定认得出它是受保护根
let deepFile: string;
let epoch: number | null;
let clock: number;
let correlators: ScopeRequestCorrelator[] = [];

function makeRegistry(cache: boolean, extra: Partial<NonNullable<PathScopeRegistryOptions['identityCache']>> = {}): {
  registry: PathScopeRegistry;
  token: string;
  identity: IdentityRegistry;
} {
  const identity = new IdentityRegistry();
  const registry = new PathScopeRegistry(identity, {
    protectedRoots: [appLink],
    ...(cache && { identityCache: { getEpoch: () => epoch, now: () => clock, ttlMs: TTL, ...extra } }),
  });
  const { token } = identity.register(PLUGIN, SENDER);
  registry.grant(PLUGIN, [{ path: home, mode: 'rw' }]);
  return { registry, token, identity };
}

/** 数 fn 期间 fs.promises.stat + lstat 的调用次数。 */
async function countStats(fn: () => Promise<unknown>): Promise<number> {
  let n = 0;
  const spies = (['stat', 'lstat'] as const).map((m) => {
    const real = (fsp[m] as (...a: unknown[]) => Promise<unknown>).bind(fsp);
    return vi.spyOn(fsp, m).mockImplementation(((...a: unknown[]) => {
      n += 1;
      return real(...a);
    }) as never);
  });
  try {
    await fn();
  } finally {
    for (const s of spies) s.mockRestore();
  }
  return n;
}

async function retargetLinkToB(): Promise<void> {
  await rm(appLink);
  await symlink(realB, appLink);
}

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'pfs-idcache-')));
  home = join(root, 'home');
  realA = join(home, 'realA');
  realB = join(home, 'realB');
  appLink = join(home, 'applink');
  const deep = join(home, 'proj', 'src', 'a', 'b', 'c');
  deepFile = join(deep, 'x.txt');
  await mkdir(deep, { recursive: true });
  await mkdir(realA);
  await mkdir(realB);
  await writeFile(deepFile, 'x');
  await writeFile(join(realB, 's.txt'), 'secret');
  if (process.platform !== 'win32') await symlink(realA, appLink);
  epoch = 0;
  clock = 1_000_000;
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(async () => {
  for (const c of correlators) c.dispose();
  correlators = [];
  vi.restoreAllMocks();
  await rm(root, { recursive: true, force: true });
});

describe.skipIf(process.platform === 'win32')('受保护根 inode 判定的身份缓存', () => {
  it('同一代际内 N 次校验同一文件:stat 次数是「首次 O(深度)」+ 之后每次只查叶子,而非 N × 深度', async () => {
    const N = 20;
    const { registry, token } = makeRegistry(true);
    const first = await countStats(() => registry.check(token, SENDER, 'read', deepFile, 'r'));
    const rest = await countStats(async () => {
      for (let i = 1; i < N; i += 1) await registry.check(token, SENDER, 'read', deepFile, 'r');
    });
    const depth = deepFile.split('/').length - 1;
    expect(first).toBeGreaterThan(depth); // 首次:各级前缀 + 受保护根
    expect(rest).toBe(N - 1); // 之后:每次只现查叶子
  });

  it('同目录下的不同文件共用目录前缀的缓存;叶子总是现查', async () => {
    const { registry, token } = makeRegistry(true);
    const sibling = join(deepFile, '..', 'y.txt');
    await writeFile(sibling, 'y');
    await registry.check(token, SENDER, 'read', deepFile, 'r');
    expect(await countStats(() => registry.check(token, SENDER, 'read', sibling, 'r'))).toBe(1);
  });

  it('未注入 identityCache:不缓存(每次校验的 stat 次数相同)', async () => {
    const { registry, token } = makeRegistry(false);
    const first = await countStats(() => registry.check(token, SENDER, 'read', deepFile, 'r'));
    const second = await countStats(() => registry.check(token, SENDER, 'read', deepFile, 'r'));
    expect(second).toBe(first);
    expect(registry._identityCacheSizeForTest()).toBe(0);
  });

  it('getEpoch 返回 null(独占持有期间):不读也不写缓存', async () => {
    const { registry, token } = makeRegistry(true);
    epoch = null;
    const first = await countStats(() => registry.check(token, SENDER, 'read', deepFile, 'r'));
    const second = await countStats(() => registry.check(token, SENDER, 'read', deepFile, 'r'));
    expect(second).toBe(first);
    expect(registry._identityCacheSizeForTest()).toBe(0);
  });

  it('代际变化(独占锁被授予过)→ 整体失效:受保护根改指后不再用旧身份放行', async () => {
    const { registry, token } = makeRegistry(true);
    const target = join(realB, 's.txt');
    await registry.check(token, SENDER, 'read', target, 'r'); // 此时 realB 不是受保护根;填充缓存
    await retargetLinkToB();
    epoch = 1; // 时钟不动:只靠代际失效
    await expect(registry.check(token, SENDER, 'read', target, 'r')).rejects.toThrow(DENIED);
  });

  it('TTL 到期 → 整体失效(不经过锁的外部改动最多被旧身份掩盖一个 TTL)', async () => {
    const { registry, token } = makeRegistry(true);
    const target = join(realB, 's.txt');
    await registry.check(token, SENDER, 'read', target, 'r');
    await retargetLinkToB();
    clock += TTL; // 代际不动:只靠 TTL 失效
    await expect(registry.check(token, SENDER, 'read', target, 'r')).rejects.toThrow(DENIED);
  });

  it('时钟回拨 → 视为到期', async () => {
    const { registry, token } = makeRegistry(true);
    const target = join(realB, 's.txt');
    await registry.check(token, SENDER, 'read', target, 'r');
    await retargetLinkToB();
    clock -= 10_000;
    await expect(registry.check(token, SENDER, 'read', target, 'r')).rejects.toThrow(DENIED);
  });

  it('条目数有上限:超限清空重来,判定结果不变', async () => {
    const MAX = 4;
    const { registry, token } = makeRegistry(true, { maxEntries: MAX });
    for (const name of ['p', 'q', 'r', 's', 't']) {
      const dir = join(home, 'many', name, 'k');
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, 'f'), name);
      await registry.check(token, SENDER, 'read', join(dir, 'f'), 'r');
      expect(registry._identityCacheSizeForTest()).toBeLessThanOrEqual(MAX);
    }
    await expect(registry.check(token, SENDER, 'read', join(realA, 'nope'), 'r')).rejects.toThrow(DENIED);
  });
});

describe.skipIf(process.platform === 'win32')('身份缓存接到 plugin-fs 全局读写锁', () => {
  async function stack(): Promise<(channel: string, ...args: unknown[]) => Promise<unknown>> {
    const ipc = new StubIpcMain();
    const identity = new IdentityRegistry();
    // 生产接线:代际 = plugin-fs 锁的独占授予次数。时钟冻结,排除 TTL 的作用。
    const registry = new PathScopeRegistry(identity, {
      protectedRoots: [appLink],
      identityCache: { getEpoch: pluginFsIdentityEpoch, now: () => clock },
    });
    const correlator = new ScopeRequestCorrelator({ ttlMs: 60_000, gcIntervalMs: 60_000 });
    correlators.push(correlator);
    registerPluginFsHandlers(ipc as never, {
      identityRegistry: identity,
      pathScopeRegistry: registry,
      correlator,
    });
    const event = makeFakeEvent({ id: SENDER, isDestroyed: () => false });
    const { token } = (await ipc.invokeWithEvent(event, C.REGISTER_PLUGIN, PLUGIN)) as { token: string };
    registry.grant(PLUGIN, [{ path: home, mode: 'rw' }]);
    return (channel, ...args) => ipc.invokeWithEvent(event, channel, token, ...args);
  }

  it('只读调用之间命中缓存;任何变更调用(独占)之后重新 stat,不用旧身份放行', async () => {
    const call = await stack();
    const target = join(realB, 's.txt');
    expect(await call(C.READ_FILE, target)).toBe('secret');
    const warm = await countStats(() => call(C.STAT, deepFile));
    const hot = await countStats(() => call(C.STAT, deepFile));
    expect(hot).toBeLessThan(warm); // 两次只读之间命中
    await retargetLinkToB(); // 之后 realB 只有按 inode 才认得出是受保护根
    await call(C.MKDIR, join(home, 'unrelated')); // 任意一次变更调用
    await expect(call(C.READ_FILE, target)).rejects.toThrow(DENIED);
  });

  it('代际 = 独占授予次数;独占持有期间为 null(变更调用自身在变更之前做的校验不进缓存)', async () => {
    const call = await stack();
    const before = pluginFsIdentityEpoch();
    await call(C.STAT, deepFile); // 共享:不改变代际
    expect(pluginFsIdentityEpoch()).toBe(before);
    let during: number | null | undefined;
    const realMkdir = fsp.mkdir.bind(fsp);
    vi.spyOn(fsp, 'mkdir').mockImplementation(((...a: Parameters<typeof fsp.mkdir>) => {
      during = pluginFsIdentityEpoch();
      return realMkdir(...a);
    }) as never);
    await call(C.MKDIR, join(home, 'made'));
    expect(during).toBeNull();
    expect(pluginFsIdentityEpoch()).toBe((before as number) + 1);
  });
});
