// 打磨 R55(codex 性能):Terminal 6MB+ lazy chunk 不再无条件 idle prefetch,改为
// watchTerminalIntent:只在出现终端会话(恢复 / 新建)时 warm 一次。普通从不开终端的
// session 不下载/解析 xterm chunk。
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect, vi } from 'vitest';
import { watchTerminalIntent } from '../../lib/terminal-chunk-warmup';

function fakeStore(initial: readonly unknown[]) {
  let sessions = initial;
  const listeners = new Set<() => void>();
  return {
    getState: () => ({ sessions }),
    subscribe: (l: () => void) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    set(next: readonly unknown[]) {
      sessions = next;
      for (const l of listeners) l();
    },
  };
}

describe('打磨 R55 — watchTerminalIntent', () => {
  it('无会话 → 不 warm', () => {
    const store = fakeStore([]);
    const onWarm = vi.fn();
    watchTerminalIntent(store, onWarm);
    expect(onWarm).not.toHaveBeenCalled();
  });

  it('启动时已有会话 → 立即 warm', () => {
    const store = fakeStore([{ id: 't1' }]);
    const onWarm = vi.fn();
    watchTerminalIntent(store, onWarm);
    expect(onWarm).toHaveBeenCalledTimes(1);
  });

  it('会话异步出现(恢复/新建)→ warm 一次,后续变化不重复 warm', () => {
    const store = fakeStore([]);
    const onWarm = vi.fn();
    watchTerminalIntent(store, onWarm);
    expect(onWarm).not.toHaveBeenCalled();

    store.set([{ id: 't1' }]); // 恢复出会话
    expect(onWarm).toHaveBeenCalledTimes(1);

    store.set([{ id: 't1' }, { id: 't2' }]); // 再新建
    store.set([]); // 关掉
    store.set([{ id: 't3' }]); // 再开
    expect(onWarm).toHaveBeenCalledTimes(1); // warm 只一次
  });
});

describe('Phase-5 · preloadTerminalPanelChunk specifier 必须与 React.lazy 一致', () => {
  // 去重的硬前提:preloadTerminalPanelChunk 的 import specifier 与 TerminalPlugin 的
  // React.lazy 逐字符一致,才会请求同一 chunk → 预热有提前量。静态断言两处一致,防漂移。
  const SPECIFIER = "@/panels/Terminal/TerminalPanelView";
  const read = (rel: string) => readFileSync(join(process.cwd(), rel), 'utf-8');

  it('preloadTerminalPanelChunk 用精确 specifier', () => {
    const src = read('src/lib/terminal-chunk-warmup.ts');
    expect(src).toContain(`import('${SPECIFIER}')`);
  });

  it('TerminalPlugin 的 React.lazy 用同一 specifier(两处必须一致才能去重)', () => {
    const src = read('src/core-plugins/TerminalPlugin.ts');
    expect(src).toContain(`import('${SPECIFIER}')`);
  });
});
