// 安全(插件之间的读取饥饿):大块读取闸(见 read-concurrency.spec)此前是全局一条队列、没有按插件的名额 —— 一个插件
// 保持上千个排队读取,其它插件的 readFile / listDir / editor.openFile 全部 FS_BUSY(审计实测 8 秒内 150 次小文件读
// 全部被拒)。现在:每个插件(按 pluginId,同一插件多窗口 / 多实例共享名额)在途 + 排队至多
// PLUGIN_FS_HEAVY_READ_PER_PLUGIN_MAX 个,超出只拒绝该插件;全局并发上限不变;有空位时在有排队的插件之间轮转放行。
import { promises as fsp } from 'node:fs';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
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
  PLUGIN_FS_HEAVY_READ_PER_PLUGIN_MAX: PER_PLUGIN,
} = await import('../../../electron/main/services/plugin-fs.service');
const { StubIpcMain, makeFakeEvent } = await import('../sdk-contract/integration/make-stub-ipc');

let root: string;
let proj: string;
let ipc: InstanceType<typeof StubIpcMain>;
let correlator: InstanceType<typeof ScopeRequestCorrelator>;
let scopes: InstanceType<typeof PathScopeRegistry>;
const evA = makeFakeEvent({ id: 1, isDestroyed: () => false });
const evA2 = makeFakeEvent({ id: 3, isDestroyed: () => false }); // 插件 A 在另一个窗口的实例
const evB = makeFakeEvent({ id: 2, isDestroyed: () => false });
let tokA: string;
let tokA2: string;
let tokB: string;

/** 拦住对 `blocked-*` 的 open / opendir:记录在途数与谁在途,放行由测试控制(FIFO)。 */
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

async function settle(): Promise<void> {
  for (let i = 0; i < 50; i++) await new Promise<void>((r) => setImmediate(r));
}
async function until(cond: () => boolean): Promise<void> {
  for (let i = 0; i < 400 && !cond(); i++) await new Promise<void>((r) => setTimeout(r, 5));
  expect(cond()).toBe(true);
}

const read = (ev: typeof evA, tok: string, name: string): Promise<unknown> =>
  ipc.invokeWithEvent(ev, C.READ_FILE, tok, join(proj, name));

beforeEach(async () => {
  gate.active = 0;
  gate.peak = 0;
  gate.waiters = [];
  gate.open = false;
  root = await realpath(await mkdtemp(join(tmpdir(), 'pfs-read-fair-')));
  proj = join(root, 'proj');
  await mkdir(join(proj, 'blocked-dir'), { recursive: true });
  for (let i = 0; i < 8; i++) await writeFile(join(proj, `blocked-${i}.txt`), `content ${i}`);
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
  const reg = async (ev: typeof evA, id: string): Promise<string> =>
    ((await ipc.invokeWithEvent(ev, C.REGISTER_PLUGIN, id)) as { token: string }).token;
  tokA = await reg(evA, 'plugin.a');
  tokA2 = await reg(evA2, 'plugin.a');
  tokB = await reg(evB, 'plugin.b');
  scopes.grant('plugin.a', [{ path: proj, mode: 'rw' }]);
  scopes.grant('plugin.b', [{ path: proj, mode: 'rw' }]);
});

afterEach(async () => {
  gate.open = true;
  release();
  await settle();
  vi.restoreAllMocks();
  correlator.dispose();
  await rm(root, { recursive: true, force: true });
});

describe('plugin-fs 大块读取闸:按插件名额 + 插件间轮转', () => {
  it('插件 A 占满自己的名额:A 的下一次读取 FS_BUSY,插件 B 的 readFile / listDir / editor.openFile 不被拒并在 A 的长队之前完成', async () => {
    const aCalls = Array.from({ length: PER_PLUGIN }, (_, i) => read(evA, tokA, `blocked-${i % 8}.txt`));
    for (const c of aCalls) c.catch(() => undefined);
    await until(() => gate.active === MAX_ACTIVE);
    // A 超出自己的名额 → 只拒绝 A(同一插件另一窗口的实例共享名额,不能靠多开窗口放大)
    await expect(read(evA, tokA, 'free.txt')).rejects.toMatchObject({ code: 'FS_BUSY' });
    await expect(read(evA2, tokA2, 'free.txt')).rejects.toMatchObject({ code: 'FS_BUSY' });
    // B 不受 A 的长队影响:排在队里,一有空位即轮到
    const done: string[] = [];
    const bRead = read(evB, tokB, 'free.txt').then((v) => (done.push('read'), v));
    const bList = ipc.invokeWithEvent(evB, C.LIST_DIR, tokB, proj).then((v) => (done.push('list'), v));
    const bOpen = ipc
      .invokeWithEvent(evB, C.READ_FOR_EDITOR, tokB, join(proj, 'free.txt'))
      .then((v) => (done.push('open'), v));
    await settle();
    // 放行 A 在途的 4 个:空出的 4 个位置轮转 → B 的 3 个各拿一个(A 只拿一个)
    release(MAX_ACTIVE);
    await settle();
    expect(await bRead).toBe('free');
    expect(await bList).toEqual(expect.arrayContaining([expect.objectContaining({ name: 'free.txt' })]));
    expect(await bOpen).toMatchObject({ ok: true, content: 'free' });
    expect(done.sort()).toEqual(['list', 'open', 'read']);
    expect(gate.peak).toBeLessThanOrEqual(MAX_ACTIVE);
    gate.open = true;
    release();
    expect(await Promise.all(aCalls)).toHaveLength(PER_PLUGIN);
    // 名额随完成释放
    expect(await read(evA, tokA, 'free.txt')).toBe('free');
  });

  it('两个插件各有长队:全局在途 ≤ 上限,放行顺序在插件之间交替', async () => {
    const N = 30;
    const order: string[] = [];
    const calls: Promise<unknown>[] = [];
    for (let i = 0; i < N; i++) {
      calls.push(read(evA, tokA, `blocked-${i % 8}.txt`).then(() => order.push('A')));
    }
    for (let i = 0; i < N; i++) {
      calls.push(read(evB, tokB, `blocked-${i % 8}.txt`).then(() => order.push('B')));
    }
    await until(() => gate.active === MAX_ACTIVE);
    let finished = 0;
    for (const c of calls) void c.then(() => (finished += 1));
    while (finished < calls.length) {
      release(1);
      await settle();
      expect(gate.active).toBeLessThanOrEqual(MAX_ACTIVE);
    }
    expect(gate.peak).toBe(MAX_ACTIVE);
    // 前 4 个是 A 先到时直接拿到的位置;之后 A 剩 26、B 有 30:先严格交替 52 次,最后 4 个是 B
    const tail = order.slice(MAX_ACTIVE);
    expect(order.slice(0, MAX_ACTIVE)).toEqual(['A', 'A', 'A', 'A']);
    expect(tail.slice(0, 52)).toEqual(Array.from({ length: 52 }, (_, i) => (i % 2 === 0 ? 'A' : 'B')));
    expect(tail.slice(52)).toEqual(['B', 'B', 'B', 'B']);
  });
});
