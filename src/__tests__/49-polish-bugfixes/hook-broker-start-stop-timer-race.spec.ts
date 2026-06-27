// @vitest-environment node
// race(R108,R81/R90 同族):HookFileBroker.start() 在 watcher 挂载后的初始 readdir/ingestFile 扫描
// 期间(await 处)若被 stop() 打断,恢复后仍会执行 cleanupTimer = setInterval(...)。stop() 当时看不到
// 尚未创建的 timer → 清不掉 → 迟到的 setInterval 泄漏,甚至在 broker 已停/重启后继续跑 stale cleanup。
// 修复:初始扫描结束后、创建 cleanupTimer 前复查 stopped || myGen !== startGen,过期则关本次 watcher
// 并直接返回,不创建 timer。
//
// 用 opendir mock 暂停扫描的 await:start() 卡在 opendir → stop() → resolve opendir(空目录)→ 有修复则
// 在 setInterval 之前 bail(cleanupTimer 不创建);无修复则泄漏一个 interval。
// (E211/E212:readHookDirCapped 已由 readdir 改 opendir 流式枚举,暂停点从 readdir 的 await 移到 opendir 的 await。)

import { afterEach, describe, expect, it, vi } from 'vitest';

// 空目录的 async-iterable Dir(for await 立即结束)。
function emptyDir() {
  return {
    async *[Symbol.asyncIterator]() {
      /* 空目录:不 yield */
    },
    close: async () => undefined,
  };
}

const h = vi.hoisted(() => ({
  opendirResolvers: [] as Array<(v: unknown) => void>,
  closeSpy: vi.fn(),
}));

vi.mock('node:fs', () => ({
  watch: vi.fn(() => ({ close: h.closeSpy, on: vi.fn() })),
}));

const fsp = vi.hoisted(() => ({
  mkdir: vi.fn(async () => undefined),
  opendir: vi.fn(
    () =>
      new Promise((r) => {
        h.opendirResolvers.push(r);
      }),
  ),
  stat: vi.fn(async () => ({ mtimeMs: 0 })),
  readFile: vi.fn(async () => '{}'),
  unlink: vi.fn(async () => undefined),
}));
vi.mock('node:fs/promises', () => fsp);

import { createHookFileBroker } from '../../../electron/main/services/mcp-tools-hook-bridge';

afterEach(() => {
  h.opendirResolvers = [];
  vi.clearAllMocks();
});

describe('race(R108) · start() 扫描期间 stop() 不泄漏 cleanupTimer', () => {
  it('opendir 在途时 stop() → 恢复后不创建 cleanupTimer + 关本次 watcher', async () => {
    const setIntervalSpy = vi.spyOn(globalThis, 'setInterval');
    const broker = createHookFileBroker('/fake/dir');

    // start():mkdir(mock)→ 复查通过 → watch(mock)→ readdir → 卡在 deferred。
    const startP = broker.start();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(h.opendirResolvers.length).toBe(1); // 卡在初始扫描
    expect(setIntervalSpy).not.toHaveBeenCalled(); // timer 尚未创建

    // 扫描在途时停止 broker(stopped=true,关 watcher)。
    await broker.stop();

    // 放行 readdir(空目录)→ start 恢复 → 复查 stopped → 在 setInterval 之前 bail。
    h.opendirResolvers[0]!(emptyDir());
    await Promise.resolve();
    await Promise.resolve();
    await startP;

    // 关键:过期 start 不创建 cleanupTimer(无泄漏的 interval)。
    expect(setIntervalSpy).not.toHaveBeenCalled();
    // 本次 start 创建的 watcher 被关(stop 关一次 + bail 幂等再关)。
    expect(h.closeSpy).toHaveBeenCalled();

    setIntervalSpy.mockRestore();
  });

  it('正常 start(扫描期间无 stop)→ 创建 cleanupTimer', async () => {
    const setIntervalSpy = vi.spyOn(globalThis, 'setInterval');
    const broker = createHookFileBroker('/fake/dir');
    try {
      const startP = broker.start();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      expect(h.opendirResolvers.length).toBe(1);
      h.opendirResolvers[0]!(emptyDir()); // 扫描正常结束,无 stop 打断
      await startP;
      expect(setIntervalSpy).toHaveBeenCalledTimes(1); // 创建 cleanupTimer
    } finally {
      await broker.stop();
      setIntervalSpy.mockRestore();
    }
  });
});
