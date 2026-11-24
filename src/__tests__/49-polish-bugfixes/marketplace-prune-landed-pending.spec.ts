// P2 UI 一致性回归(第七 session R5):待重启记录(乐观「刚装、等落地」标记)此前单调只增不减。一旦插件已落地
// (进插件列表),记录仍残留 → 用户在设置页卸载该插件后 → marketplace 卡片显示「已安装/待重启」幻影
// (installed 展示=installed||pending;pendingRestart=pending&&!installed)。
// 修复:pruneLandedPendingMap 在插件列表变化时摘除已落地的 id(现集中在 pending-installs-store 订阅列表变化执行)。
import { describe, it, expect } from 'vitest';
import { pruneLandedPendingMap } from '../../marketplace/prune-landed-pending';

const pendingOf = (...ids: string[]) => new Map(ids.map((id) => [id, { id }]));
const inSet = (...ids: string[]) => {
  const set = new Set(ids);
  return (id: string) => set.has(id);
};

describe('49 · pruneLandedPendingMap', () => {
  it('落地的 id(已在列表)被摘除', () => {
    expect([...pruneLandedPendingMap(pendingOf('a', 'b'), inSet('a')).keys()]).toEqual(['b']);
  });

  it('未落地的 id 保留(乐观窗口内仍显示)', () => {
    expect([...pruneLandedPendingMap(pendingOf('a'), inSet()).keys()]).toEqual(['a']);
  });

  it('无可摘除项 → 返回同一引用(避免多余 re-render)', () => {
    const pending = pendingOf('x');
    expect(pruneLandedPendingMap(pending, inSet('y'))).toBe(pending);
  });

  it('空记录 → 返回同一引用', () => {
    const pending = pendingOf();
    expect(pruneLandedPendingMap(pending, inSet('a', 'b'))).toBe(pending);
  });

  it('全部落地 → 返回空 Map(新引用)', () => {
    const pending = pendingOf('a', 'b');
    const out = pruneLandedPendingMap(pending, inSet('a', 'b', 'c'));
    expect(out.size).toBe(0);
    expect(out).not.toBe(pending);
  });

  it('「装→落地→卸载」序列:落地时摘除,卸载后不复活幻影', () => {
    let pending: ReadonlyMap<string, { id: string }> = pendingOf('a');
    pending = pruneLandedPendingMap(pending, inSet()); // watcher 未扫到 → 乐观保留
    expect(pending.has('a')).toBe(true);
    pending = pruneLandedPendingMap(pending, inSet('a')); // 落地 → 摘除
    expect(pending.size).toBe(0);
    pending = pruneLandedPendingMap(pending, inSet()); // 卸载 → 无幻影
    expect(pending.has('a')).toBe(false);
  });
});
