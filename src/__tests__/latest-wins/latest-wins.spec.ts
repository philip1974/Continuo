// race(R18):createLatestGuard —— 单调代际「最新者胜」,过期调用的 isLatest() 返 false。
import { describe, it, expect } from 'vitest';
import { createLatestGuard } from '../../lib/latest-wins';

describe('createLatestGuard (R18)', () => {
  it('单次调用 → isLatest() 为 true', () => {
    const g = createLatestGuard();
    const isLatest = g.begin();
    expect(isLatest()).toBe(true);
  });

  it('后发起的 begin 使先前的 isLatest() 变 false(最新者胜)', () => {
    const g = createLatestGuard();
    const first = g.begin();
    const second = g.begin();
    expect(first()).toBe(false); // 被 second 取代
    expect(second()).toBe(true);
  });

  it('模拟乱序 resolve:先发起 A、后发起 B,B 先落地;A 旧结果被丢弃', async () => {
    const g = createLatestGuard();
    const applied: string[] = [];

    function dropWorkspace(name: string, delayMs: number) {
      const isLatest = g.begin();
      return new Promise<void>((resolve) => {
        setTimeout(() => {
          if (isLatest()) applied.push(name);
          resolve();
        }, delayMs);
      });
    }

    // A 先发起(慢),B 后发起(快)→ B 先 resolve setRoot(B),A 后 resolve 但已过期被丢
    const pA = dropWorkspace('A', 30);
    const pB = dropWorkspace('B', 5);
    await Promise.all([pA, pB]);

    expect(applied).toEqual(['B']); // 只有最新的 B 落地,过期的 A 不覆盖
  });

  it('连续三次:只有最后一次为最新', () => {
    const g = createLatestGuard();
    const a = g.begin();
    const b = g.begin();
    const c = g.begin();
    expect(a()).toBe(false);
    expect(b()).toBe(false);
    expect(c()).toBe(true);
  });
});
