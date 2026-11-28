// BDD:窗口缩放比例变化后重算像素相关布局(见同目录 README)。
import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { watchDevicePixelRatio } from '@/lib/device-pixel-ratio';

/** 只实现 matchMedia('(resolution: Ndppx)') 的假窗口:setDpr 模拟换屏,对不再匹配的 query 派发 change。 */
function fakeWindow(initial: number) {
  const queries: Array<{ dpr: number; listeners: Set<() => void>; mql: MediaQueryList }> = [];
  const win = {
    devicePixelRatio: initial,
    matchMedia: vi.fn((query: string) => {
      const m = /^\(resolution: ([\d.]+)dppx\)$/.exec(query);
      if (!m) throw new Error(`unexpected query ${query}`);
      const listeners = new Set<() => void>();
      const mql = {
        addEventListener: (_t: string, l: () => void) => listeners.add(l),
        removeEventListener: (_t: string, l: () => void) => listeners.delete(l),
      } as unknown as MediaQueryList;
      queries.push({ dpr: Number(m[1]), listeners, mql });
      return mql;
    }),
    setDpr(next: number) {
      const before = win.devicePixelRatio;
      win.devicePixelRatio = next;
      for (const q of [...queries]) {
        if (q.dpr === before && q.dpr !== next) for (const l of [...q.listeners]) l();
      }
    },
    listenerCount: () => queries.reduce((n, q) => n + q.listeners.size, 0),
  };
  return win;
}
type FakeWindow = ReturnType<typeof fakeWindow>;
const asWindow = (w: FakeWindow | null) => w as unknown as Window | null;

describe('watchDevicePixelRatio(VSCode DevicePixelRatioMonitor)', () => {
  it('DPR 变化触发一次,之后按新值换 query,再变仍能听到', () => {
    const win = fakeWindow(2);
    const onChange = vi.fn();
    watchDevicePixelRatio(() => asWindow(win), onChange);
    expect(win.matchMedia).toHaveBeenLastCalledWith('(resolution: 2dppx)');
    win.setDpr(1.5);
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(win.matchMedia).toHaveBeenLastCalledWith('(resolution: 1.5dppx)');
    win.setDpr(1.25);
    expect(onChange).toHaveBeenCalledTimes(2);
    expect(win.listenerCount()).toBe(1); // 旧 query 的监听已摘掉
  });

  it('sync:所在窗口变了 → 改听新窗口(旧窗口不再触发);没变不重建;都不触发 onChange', () => {
    const main = fakeWindow(2);
    const popout = fakeWindow(1);
    let current: FakeWindow = main;
    const onChange = vi.fn();
    const watch = watchDevicePixelRatio(() => asWindow(current), onChange);
    watch.sync();
    expect(main.matchMedia).toHaveBeenCalledTimes(1);
    current = popout;
    watch.sync();
    expect(onChange).not.toHaveBeenCalled();
    expect(main.listenerCount()).toBe(0);
    main.setDpr(1);
    expect(onChange).not.toHaveBeenCalled();
    popout.setDpr(2);
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it('dispose 后不再触发;没有窗口 / 没有 matchMedia → 不监听不抛', () => {
    const win = fakeWindow(2);
    const onChange = vi.fn();
    const watch = watchDevicePixelRatio(() => asWindow(win), onChange);
    watch.dispose();
    win.setDpr(1);
    expect(onChange).not.toHaveBeenCalled();
    expect(win.listenerCount()).toBe(0);
    expect(() => watchDevicePixelRatio(() => null, onChange).sync()).not.toThrow();
    expect(() => watchDevicePixelRatio(() => ({ devicePixelRatio: 1 }) as unknown as Window, onChange)).not.toThrow();
  });
});

describe('终端接线(useTerminal)', () => {
  const src = readFileSync(join(process.cwd(), 'src/panels/Terminal/useTerminal.ts'), 'utf8');

  it('监听终端所在窗口的 DPR,变化后下一帧请求重算行列;容器 RO 回调先 sync(拖进 / 拖出 popout 换窗口)', () => {
    const block = src.slice(src.indexOf('const dprWatch = watchDevicePixelRatio('));
    const watch = block.slice(0, block.indexOf('const ro = new ResizeObserver'));
    expect(watch).toMatch(/\(\) => container\.ownerDocument\.defaultView,/);
    expect(watch).toMatch(/win\.requestAnimationFrame\(\(\) => \{[^}]*resizeDebouncer\.request\(\);/);
    expect(block).toMatch(/new ResizeObserver\(\(\) => \{\s*dprWatch\.sync\(\);\s*resizeDebouncer\.request\(\);/);
  });

  it('卸载时摘监听并取消待执行的帧', () => {
    const teardown = src.slice(src.indexOf('ro.disconnect();'));
    expect(teardown.slice(0, teardown.indexOf('resizeDebouncer.dispose();'))).toMatch(/dprWatch\.dispose\(\);\s*cancelDprFit\(\);/);
  });
});
