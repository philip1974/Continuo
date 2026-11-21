// P2 UI 一致性回归(第七 session R5):MarketplaceTab 的 install.pending(乐观「刚装、
// 等磁盘落地」标记)此前单调只增不减。一旦插件已落地(进 installed 真实磁盘集),pending
// 仍残留 → 用户在设置页卸载该插件后 installed 变假而 pending 仍真 → marketplace 卡片
// 显示「已安装/待重启」幻影(installed 展示=installed||pending;pendingRestart=pending&&!installed)。
// 修复:pruneLandedPending 在每次 installed 轮询更新时摘除已落地的 pending id。
import { describe, it, expect } from 'vitest';
import { pruneLandedPending } from '../../marketplace/prune-landed-pending';

describe('49 · pruneLandedPending', () => {
  it('落地的 id(在 installed 中)被摘除', () => {
    const pending = new Set(['a', 'b']);
    const installed = new Set(['a']);
    const out = pruneLandedPending(pending, installed);
    expect([...out]).toEqual(['b']);
  });

  it('未落地的 id 保留(乐观窗口内仍显示)', () => {
    const pending = new Set(['a']);
    const installed = new Set<string>(); // watcher 还没扫到
    const out = pruneLandedPending(pending, installed);
    expect([...out]).toEqual(['a']);
  });

  it('无可摘除项 → 返回同一引用(避免多余 re-render)', () => {
    const pending = new Set(['x']);
    const installed = new Set(['y']);
    expect(pruneLandedPending(pending, installed)).toBe(pending);
  });

  it('空 pending → 返回同一引用', () => {
    const pending = new Set<string>();
    const installed = new Set(['a', 'b']);
    expect(pruneLandedPending(pending, installed)).toBe(pending);
  });

  it('全部落地 → 返回空集(新引用)', () => {
    const pending = new Set(['a', 'b']);
    const installed = new Set(['a', 'b', 'c']);
    const out = pruneLandedPending(pending, installed);
    expect(out.size).toBe(0);
    expect(out).not.toBe(pending);
    expect(pruneLandedPending(new Set(['x']), new Set(['x']))).toBe(out);
  });

  it('「装→落地→卸载」序列:落地时摘除,卸载后不复活幻影', () => {
    // 1) 装 a:pending={a}, installed={}(watcher 未扫到)
    let pending: ReadonlySet<string> = new Set(['a']);
    let installed: ReadonlySet<string> = new Set();
    pending = pruneLandedPending(pending, installed);
    expect([...pending]).toEqual(['a']); // 乐观保留

    // 2) watcher 落地:installed={a} → 摘除 a
    installed = new Set(['a']);
    pending = pruneLandedPending(pending, installed);
    expect(pending.size).toBe(0);

    // 3) 用户在设置页卸载 a:installed={} 。pending 已空 → 无幻影。
    installed = new Set();
    pending = pruneLandedPending(pending, installed);
    expect(pending.size).toBe(0);
    // pendingRestart = pending.has('a') && !installed.has('a') = false ✓
    expect(pending.has('a')).toBe(false);
  });
});
