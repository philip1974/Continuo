// perf-audit P1 · 终端输出窗口级单订阅分发器的行为契约。
// 关键性能不变量:dispatch 只调 id 匹配的 handler,绝不 fan-out 到别 session
// 的 handler(旧实现是 N 个 listener 各自 `if(id!==termId)return`,O(N)/chunk)。

import { describe, expect, it, vi } from 'vitest';
import { createTerminalDataDemux } from '../../../electron/preload/terminal-data-demux';

describe('perf-audit P1 · createTerminalDataDemux', () => {
  it('dispatch 只调用 id 匹配的 handler,不 fan-out 到别 session', () => {
    const demux = createTerminalDataDemux();
    const a = vi.fn();
    const b = vi.fn();
    demux.add('sess-a', a);
    demux.add('sess-b', b);

    const invoked = demux.dispatch('sess-a', 'chunk-a');

    expect(invoked).toBe(1); // 只 1 个回调,不是 N 个
    expect(a).toHaveBeenCalledOnce();
    expect(a).toHaveBeenCalledWith('chunk-a');
    expect(b).not.toHaveBeenCalled(); // 别 session 的 handler 零开销
  });

  it('未知 id 的 chunk 分发到 0 个 handler(不抛)', () => {
    const demux = createTerminalDataDemux();
    demux.add('sess-a', vi.fn());
    expect(demux.dispatch('ghost', 'x')).toBe(0);
  });

  it('同一 id 多个 handler 都收到', () => {
    const demux = createTerminalDataDemux();
    const h1 = vi.fn();
    const h2 = vi.fn();
    demux.add('s', h1);
    demux.add('s', h2);
    expect(demux.dispatch('s', 'd')).toBe(2);
    expect(h1).toHaveBeenCalledWith('d');
    expect(h2).toHaveBeenCalledWith('d');
  });

  it('unsubscribe 后不再收到,且空 id 从 Map 清除(无泄漏)', () => {
    const demux = createTerminalDataDemux();
    const h = vi.fn();
    const unsub = demux.add('s', h);
    expect(demux.idCount()).toBe(1);

    unsub();
    expect(demux.idCount()).toBe(0); // Set 空 → id 条目删除,不残留
    expect(demux.dispatch('s', 'd')).toBe(0);
    expect(h).not.toHaveBeenCalled();
  });

  it('分发中某 handler unsubscribe 自己,不影响本轮其它 handler', () => {
    const demux = createTerminalDataDemux();
    const order: string[] = [];
    let unsub2: (() => void) | null = null;
    demux.add('s', () => {
      order.push('h1');
      unsub2?.(); // 在 h1 内退订 h2
    });
    unsub2 = demux.add('s', () => order.push('h2'));

    // 快照迭代 → 本轮 h2 仍被调用一次
    demux.dispatch('s', 'd');
    expect(order).toEqual(['h1', 'h2']);

    // 下一轮 h2 已退订
    order.length = 0;
    demux.dispatch('s', 'd');
    expect(order).toEqual(['h1']);
  });

  it('幂等 unsubscribe 安全(重复调不抛、不误删)', () => {
    const demux = createTerminalDataDemux();
    const h1 = vi.fn();
    const h2 = vi.fn();
    const unsub1 = demux.add('s', h1);
    demux.add('s', h2);
    unsub1();
    unsub1(); // 重复
    expect(demux.dispatch('s', 'd')).toBe(1);
    expect(h2).toHaveBeenCalledOnce();
  });
});
