// 边界(内存峰值):plugin-fs 的大块读取入口(read-file / read-for-editor / list-dir / read-git-blob)单次有上限,
// 但并发数此前无限制 —— 插件 Promise.all 几十个大文件读取即可把主进程撑大数 GB。全局闸:同时在途 ≤ 4,其余排队,
// 排队满了以 FS_BUSY 拒绝;闸在共享锁之外(排队者不持锁,独占写者不被整条队列饿死)。行为见同目录 README。
import { promises as fsp } from 'node:fs';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ app: { getPath: vi.fn(() => '') } }));

const { PLUGIN_FS_CHANNELS: C } = await import('../../../electron/shared/plugin-fs-channels');
const { IdentityRegistry } = await import('../../../electron/main/services/identity-registry.service');
const { PathScopeRegistry } = await import('../../../electron/main/services/path-scope-registry.service');
const { ScopeRequestCorrelator } = await import('../../../electron/main/services/scope-request-correlator');
const {
  registerPluginFsHandlers,
  PLUGIN_FS_HEAVY_READ_CONCURRENCY: MAX_ACTIVE,
  PLUGIN_FS_HEAVY_READ_QUEUE_MAX: MAX_QUEUED,
  PLUGIN_FS_HEAVY_READ_PER_PLUGIN_MAX: PER_PLUGIN,
} = await import('../../../electron/main/services/plugin-fs.service');
const { StubIpcMain, makeFakeEvent } = await import('../sdk-contract/integration/make-stub-ipc');

const PLUGIN = 'plugin.reader';
let root: string;
let proj: string;
let ipc: InstanceType<typeof StubIpcMain>;
let correlator: InstanceType<typeof ScopeRequestCorrelator>;
let token: string;
let scopes: InstanceType<typeof PathScopeRegistry>;
const event = makeFakeEvent({ id: 1, isDestroyed: () => false });
const invoke = (channel: string, ...args: unknown[]): Promise<unknown> =>
  ipc.invokeWithEvent(event, channel, token, ...args);

/** 拦住对 proj 下 `blocked-*` 文件的 open / opendir:记录同时在途数,放行由测试控制。 */
const gate = { active: 0, peak: 0, waiters: [] as (() => void)[], open: false };
function release(n = Infinity): void {
  for (let i = 0; i < n && gate.waiters.length > 0; i++) gate.waiters.shift()!();
}
async function blocking<T>(run: () => Promise<T>): Promise<T> {
  gate.active += 1;
  gate.peak = Math.max(gate.peak, gate.active);
  if (!gate.open) await new Promise<void>((r) => gate.waiters.push(r));
  try {
    return await run();
  } finally {
    gate.active -= 1;
  }
}
const isBlocked = (p: unknown): boolean => typeof p === 'string' && p.includes('blocked-');

/** 让排队 / 在途的 Promise 链走完若干轮(不依赖定时器)。 */
async function settle(): Promise<void> {
  for (let i = 0; i < 50; i++) await new Promise<void>((r) => setImmediate(r));
}

/** 等到条件成立(真实文件系统调用在负载下可能较慢)。 */
async function until(cond: () => boolean): Promise<void> {
  for (let i = 0; i < 400 && !cond(); i++) await new Promise<void>((r) => setTimeout(r, 5));
  expect(cond()).toBe(true);
}

/** 一次只放行一个被拦住的调用,直到 calls 全部结束;每一步都检查在途数不超过上限。 */
async function drainOneByOne(calls: Promise<unknown>[]): Promise<void> {
  let done = 0;
  for (const c of calls) void c.then(() => (done += 1), () => (done += 1));
  while (done < calls.length) {
    release(1);
    await settle();
    expect(gate.active).toBeLessThanOrEqual(MAX_ACTIVE);
  }
}

beforeEach(async () => {
  gate.active = 0;
  gate.peak = 0;
  gate.waiters = [];
  gate.open = false;
  root = await realpath(await mkdtemp(join(tmpdir(), 'pfs-read-conc-')));
  proj = join(root, 'proj');
  await mkdir(join(proj, 'blocked-dir'), { recursive: true });
  for (let i = 0; i < 40; i++) await writeFile(join(proj, `blocked-${i}.txt`), `content ${i}`);
  await writeFile(join(proj, 'free.txt'), 'free');
  const realOpen = fsp.open.bind(fsp);
  const realOpendir = fsp.opendir.bind(fsp);
  vi.spyOn(fsp, 'open').mockImplementation(((p: unknown, ...rest: unknown[]) =>
    isBlocked(p)
      ? blocking(() => (realOpen as (...a: unknown[]) => Promise<unknown>)(p, ...rest))
      : (realOpen as (...a: unknown[]) => Promise<unknown>)(p, ...rest)) as never);
  vi.spyOn(fsp, 'opendir').mockImplementation(((p: unknown, ...rest: unknown[]) =>
    isBlocked(p)
      ? blocking(() => (realOpendir as (...a: unknown[]) => Promise<unknown>)(p, ...rest))
      : (realOpendir as (...a: unknown[]) => Promise<unknown>)(p, ...rest)) as never);
  ipc = new StubIpcMain();
  const identity = new IdentityRegistry();
  scopes = new PathScopeRegistry(identity);
  correlator = new ScopeRequestCorrelator({ ttlMs: 60_000, gcIntervalMs: 60_000 });
  registerPluginFsHandlers(ipc as never, {
    identityRegistry: identity,
    pathScopeRegistry: scopes,
    correlator,
    webContentsForSender: () => null,
  });
  token = ((await ipc.invokeWithEvent(event, C.REGISTER_PLUGIN, PLUGIN)) as { token: string }).token;
  scopes.grant(PLUGIN, [{ path: proj, mode: 'rw' }]);
});

afterEach(async () => {
  gate.open = true;
  release();
  await settle();
  vi.restoreAllMocks();
  correlator.dispose();
  await rm(root, { recursive: true, force: true });
});

describe('plugin-fs 大块读取的全局并发闸', () => {
  it('40 个并发 readFile:同时在途的读取 ≤ 上限,其余排队,最终全部按内容完成', async () => {
    const calls = Array.from({ length: 40 }, (_, i) => invoke(C.READ_FILE, join(proj, `blocked-${i}.txt`)));
    await until(() => gate.active === MAX_ACTIVE);
    // 逐个放行:任何时刻都不超过上限
    await drainOneByOne(calls);
    const out = await Promise.all(calls);
    expect(out).toEqual(Array.from({ length: 40 }, (_, i) => `content ${i}`));
    expect(gate.peak).toBe(MAX_ACTIVE);
  });

  it('read-file / read-for-editor / list-dir 共用同一个闸', async () => {
    const calls = [
      ...Array.from({ length: 6 }, (_, i) => invoke(C.READ_FILE, join(proj, `blocked-${i}.txt`))),
      ...Array.from({ length: 6 }, (_, i) => invoke(C.READ_FOR_EDITOR, join(proj, `blocked-${10 + i}.txt`))),
      ...Array.from({ length: 6 }, () => invoke(C.LIST_DIR, join(proj, 'blocked-dir'))),
    ];
    await until(() => gate.active === MAX_ACTIVE);
    await drainOneByOne(calls);
    await Promise.all(calls);
    expect(gate.peak).toBe(MAX_ACTIVE);
  });

  // 原为单插件 MAX_ACTIVE + MAX_QUEUED 个读取占满全局队列;名额改为按插件后,单插件先触到自己的名额(本用例),
  // 全局上限要多个插件合起来才触到(下一条用例)。
  it('该插件在途 + 排队满名额后,它的新请求以 FS_BUSY 立即拒绝(含 read-for-editor 的结果对象、read-git-blob);放行后恢复', async () => {
    const calls = Array.from({ length: PER_PLUGIN }, (_, i) =>
      invoke(C.READ_FILE, join(proj, `blocked-${i % 40}.txt`)),
    );
    await settle();
    await expect(invoke(C.READ_FILE, join(proj, 'free.txt'))).rejects.toMatchObject({ code: 'FS_BUSY' });
    await expect(invoke(C.LIST_DIR, proj)).rejects.toMatchObject({ code: 'FS_BUSY' });
    await expect(invoke(C.READ_GIT_BLOB, proj, 'a'.repeat(40))).rejects.toMatchObject({ code: 'FS_BUSY' });
    expect(await invoke(C.READ_FOR_EDITOR, join(proj, 'free.txt'))).toMatchObject({ ok: false, code: 'FS_BUSY' });
    // 拒绝的请求不占名额:放行后全部完成,新请求照常
    gate.open = true;
    release();
    expect(await Promise.all(calls)).toHaveLength(PER_PLUGIN);
    expect(gate.peak).toBe(MAX_ACTIVE);
    expect(await invoke(C.READ_FILE, join(proj, 'free.txt'))).toBe('free');
  }, 60_000);

  it('全部插件合计在途 + 排队达到全局上限后,任何插件的新请求都以 FS_BUSY 拒绝;放行后恢复', async () => {
    const total = MAX_ACTIVE + MAX_QUEUED;
    const calls: Promise<unknown>[] = [];
    let last = { ev: event, tok: token };
    for (let p = 0; calls.length < total; p++) {
      const ev = makeFakeEvent({ id: 100 + p, isDestroyed: () => false });
      const id = `plugin.flood${p}`;
      const tok = ((await ipc.invokeWithEvent(ev, C.REGISTER_PLUGIN, id)) as { token: string }).token;
      scopes.grant(id, [{ path: proj, mode: 'r' }]);
      last = { ev, tok };
      for (let i = 0; i < PER_PLUGIN && calls.length < total; i++) {
        calls.push(ipc.invokeWithEvent(ev, C.READ_FILE, tok, join(proj, `blocked-${i % 40}.txt`)));
      }
    }
    await settle();
    // 名额未满的插件(本用例的 PLUGIN、最后一个 flood 插件)也被全局上限拒绝
    await expect(invoke(C.READ_FILE, join(proj, 'free.txt'))).rejects.toMatchObject({ code: 'FS_BUSY' });
    await expect(
      ipc.invokeWithEvent(last.ev, C.READ_FILE, last.tok, join(proj, 'free.txt')),
    ).rejects.toMatchObject({ code: 'FS_BUSY' });
    gate.open = true;
    release();
    expect(await Promise.all(calls)).toHaveLength(total);
    expect(gate.peak).toBe(MAX_ACTIVE);
    expect(await invoke(C.READ_FILE, join(proj, 'free.txt'))).toBe('free');
  }, 60_000);

  it('不经闸的入口(stat)在闸满时照常;与独占写交错不死锁,排队的读取不挡写者', async () => {
    const reads = Array.from({ length: 20 }, (_, i) => invoke(C.READ_FILE, join(proj, `blocked-${i}.txt`)));
    await until(() => gate.active === MAX_ACTIVE);
    expect(await invoke(C.STAT, join(proj, 'free.txt'))).toMatchObject({ isFile: true });
    let wrote = false;
    const write = invoke(C.WRITE_FILE, join(proj, 'free.txt'), 'written').then(() => {
      wrote = true;
    });
    await settle();
    expect(wrote).toBe(false); // 4 个在途读取持共享锁
    // 只放行在途的 4 个:写者随即拿到独占锁,不必等其余 16 个排队者
    release(MAX_ACTIVE);
    await settle();
    await write;
    expect(wrote).toBe(true);
    expect(await readFile(join(proj, 'free.txt'), 'utf8')).toBe('written');
    gate.open = true;
    release();
    expect(await Promise.all(reads)).toHaveLength(20);
  });
});
