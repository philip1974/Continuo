// 规则 5:co:// 旧队列优先 —— 依次尝试各就绪窗口排空 pending;旧队列未全部交付前不投递新 URL。
import { describe, expect, it } from 'vitest';
import { routeProtocolUrl, type ProtoWindow } from '../../../electron/main/protocol-dispatch';
import { makeFakeWin } from '../_helpers/fake-window';

const CH = 'plugins:protocol-url';

function win(dead = false) {
  const fake = makeFakeWin({ throwOnSend: dead });
  const w: ProtoWindow = fake;
  return { w, send: fake.webContents.send };
}

describe('规则 5 · co:// FIFO 不乱序', () => {
  it('首个就绪窗口 drain 失败 → 改由下一个就绪窗口按序交付旧队列,再投新 URL', () => {
    const a = win(true);
    const b = win();
    const pending = ['co://old/1', 'co://old/2'];
    routeProtocolUrl('co://new', { windows: [a.w, b.w], channel: CH, pending, isReady: () => true });
    expect(b.send.mock.calls.map((c) => c[1])).toEqual([
      { url: 'co://old/1' },
      { url: 'co://old/2' },
      { url: 'co://new' },
    ]);
    expect(pending).toEqual([]);
  });

  it('所有就绪窗口都无法交付旧队列 → 新 URL 入队尾,不先于旧 URL 投递', () => {
    const a = win(true);
    const b = win(true);
    const pending = ['co://old/1'];
    routeProtocolUrl('co://new', { windows: [a.w, b.w], channel: CH, pending, isReady: () => true });
    expect(pending).toEqual(['co://old/1', 'co://new']);
    const delivered = [...a.send.mock.calls, ...b.send.mock.calls].map(
      (c) => (c[1] as { url: string }).url,
    );
    // 只尝试过旧 URL(都失败),新 URL 未被尝试投递
    expect(delivered.every((u) => u === 'co://old/1')).toBe(true);
  });
});
