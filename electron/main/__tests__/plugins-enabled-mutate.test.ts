import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fsp from 'node:fs/promises';
import { mkdtemp, mkdir, rm, writeFile, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  setEnabledId,
  readEnabledIds,
  uninstallPlugin,
} from '../services/plugins.service';

// 数据安全(codex 复查 P1):_enabled.json 的 read-modify-write 此前在 renderer 的
// PluginManager 内做,串行锁 per-PluginManager 实例;每个窗口各有自己的 PluginManager,
// 两窗口同时 enable/disable 不同插件 → 各读旧集合、整表写回,后写者覆盖先写者 →
// 某插件启用状态重启后丢失(跨窗口 lost update)。RMW 收口到主进程 setEnabledId 单条
// 串行链(enabledWriteChain),renderer 改传 delta(id, enabled)。
describe('setEnabledId(主进程全局串行 delta 写)', () => {
  let baseDir: string;
  const FILE = '_enabled.json';
  beforeEach(async () => {
    baseDir = await mkdtemp(path.join(os.tmpdir(), 'continuo-enabled-'));
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(baseDir, { recursive: true, force: true });
  });

  it('并发启用不同插件 → 全部落盘,无 lost update(跨窗口竞态修复)', async () => {
    // 模拟两个窗口几乎同时各自 enable 一个不同插件:都先读旧集合再整表写。
    // 收口到单条链后,每次 RMW 读到的是上一次 write 后的最新集合 → 不丢更新。
    await Promise.all([
      setEnabledId(baseDir, 'a', true),
      setEnabledId(baseDir, 'b', true),
      setEnabledId(baseDir, 'c', true),
    ]);

    expect([...(await readEnabledIds(baseDir))].sort()).toEqual(['a', 'b', 'c']);
  });

  it('并发启用+禁用交错 → 最终集合一致,无半丢失', async () => {
    await setEnabledId(baseDir, 'a', true);
    await Promise.all([
      setEnabledId(baseDir, 'b', true),
      setEnabledId(baseDir, 'a', false),
      setEnabledId(baseDir, 'c', true),
    ]);
    expect([...(await readEnabledIds(baseDir))].sort()).toEqual(['b', 'c']);
  });

  it('enabled=false 移除不存在的 id → 幂等(不抛、集合不变)', async () => {
    await setEnabledId(baseDir, 'a', true);
    await setEnabledId(baseDir, 'x', false);
    expect([...(await readEnabledIds(baseDir))]).toEqual(['a']);
  });

  // 数据安全(codex P1,#33 修复的连带兄弟入口):uninstallPlugin 清 _enabled.json 此前
  // 手写 readEnabledIds→filter→writeEnabledIds,绕过 enabledWriteChain → 与跨窗口
  // enable/disable 并发时用旧快照整表写回丢更新。改走 setEnabledId(id,false) 入链。
  it('uninstallPlugin 清 enabled 走同一串行链 → 与并发 enable 无 lost update', async () => {
    await mkdir(path.join(baseDir, 'b')); // 目标存在,可卸载
    await writeFile(path.join(baseDir, FILE), JSON.stringify(['b']), 'utf-8');

    await Promise.all([
      uninstallPlugin(baseDir, 'b'), // 卸载 b(清其 enabled)
      setEnabledId(baseDir, 'a', true), // 另一窗口同时启用 a
    ]);

    // b 被移除、a 保留 —— 两个操作串行,无相互整表覆盖
    expect([...(await readEnabledIds(baseDir))]).toEqual(['a']);
  });

  // race(R107):uninstallPlugin 的 fs 段(access → 元数据清理 → rm)现纳入同 id 主进程 mutation
  // 锁(withPluginMutationLock),与 installFromGit 的 swap 互斥。验证:并发两次卸载同 id 串行执行
  // —— 恰一次成功删目录,另一次因目录已被前一次删掉走 NOT_INSTALLED;不会两个 access 都通过后各自
  // rm(交错)。未上锁时两调用都先 access 通过 → 都 fulfill(rm force 幂等)→ 本断言失败。
  it('R107 并发两次卸载同 id → 串行:恰一次成功,另一次 NOT_INSTALLED', async () => {
    const id = 'plug-r107';
    await mkdir(path.join(baseDir, id), { recursive: true });
    await writeFile(
      path.join(baseDir, id, 'manifest.json'),
      JSON.stringify({ id, name: id, version: '1.0.0' }),
      'utf-8',
    );

    const results = await Promise.allSettled([
      uninstallPlugin(baseDir, id),
      uninstallPlugin(baseDir, id),
    ]);

    const fulfilled = results.filter((r) => r.status === 'fulfilled').length;
    const notInstalled = results.filter(
      (r) =>
        r.status === 'rejected' &&
        (r.reason as { code?: string })?.code === 'NOT_INSTALLED',
    ).length;
    expect(fulfilled).toBe(1); // 仅一次真正卸载
    expect(notInstalled).toBe(1); // 另一次串行后见目录已删
  });

  it('读 EACCES → setEnabledId 抛,且不抹盘(原 _enabled.json 完好)', async () => {
    const file = path.join(baseDir, FILE);
    const original = JSON.stringify(['a', 'b']);
    await writeFile(file, original, 'utf-8');

    // 边界(E159):readMetadataCapped 改单 fd 后经 fs.open 读元数据,EACCES 须从 open 抛出。
    const realOpen = fsp.open.bind(fsp);
    vi.spyOn(fsp, 'open').mockImplementation((async (
      p: unknown,
      ...rest: unknown[]
    ) => {
      if (String(p) === file) {
        throw Object.assign(new Error('EACCES'), { code: 'EACCES' });
      }
      return (realOpen as (...a: unknown[]) => Promise<unknown>)(p, ...rest);
    }) as unknown as typeof fsp.open);

    // 读失败(当前态未知)→ RMW 中止,绝不基于空集合写回抹掉已启用插件
    await expect(setEnabledId(baseDir, 'c', true)).rejects.toThrow();

    vi.restoreAllMocks();
    expect(await readFile(file, 'utf-8')).toBe(original);
  });
});
