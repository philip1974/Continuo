// BDD:尾随防抖,可选 maxWait。见同目录 README。
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { debounce } from '../../lib/debounce';

const SRC_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('debounce', () => {
  it('连续调用只在最后一次之后 delay 执行一次,参数取最后一次', () => {
    const fn = vi.fn();
    const d = debounce(fn, 100);
    d(1);
    vi.advanceTimersByTime(60);
    d(2);
    vi.advanceTimersByTime(99);
    expect(fn).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(fn).toHaveBeenCalledExactlyOnceWith(2);
  });

  it('cancel 丢弃未执行的调用', () => {
    const fn = vi.fn();
    const d = debounce(fn, 100);
    d(1);
    d.cancel();
    vi.advanceTimersByTime(500);
    expect(fn).not.toHaveBeenCalled();
  });

  it('maxWait:持续调用时自本轮首次起至多 maxWait 执行一次,之后开始新一轮', () => {
    const fn = vi.fn();
    const d = debounce(fn, 100, { maxWait: 250 });
    for (let t = 0; t < 250; t += 50) {
      d(t);
      vi.advanceTimersByTime(50);
    }
    expect(fn).toHaveBeenCalledExactlyOnceWith(200);
    // 新一轮:从此刻重新计 maxWait
    d(999);
    vi.advanceTimersByTime(100);
    expect(fn).toHaveBeenLastCalledWith(999);
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('maxWait 下 cancel 后重新开始一轮', () => {
    const fn = vi.fn();
    const d = debounce(fn, 100, { maxWait: 150 });
    d(1);
    vi.advanceTimersByTime(90);
    d.cancel();
    d(2);
    vi.advanceTimersByTime(99);
    expect(fn).not.toHaveBeenCalled(); // 未沿用被取消那轮的 firstAt
    vi.advanceTimersByTime(1);
    expect(fn).toHaveBeenCalledExactlyOnceWith(2);
  });
});

describe('接线守卫', () => {
  it.each(['panels/Explorer/fs-watch-helpers.ts', 'panels/Terminal/useTerminal.ts'])('%s', (rel) => {
    const src = readFileSync(path.join(SRC_ROOT, rel), 'utf-8');
    expect(src).toContain('debounce(');
    expect(src).not.toMatch(/firstAt \+ [A-Za-z_]+ - (Date\.now\(\)|now)/);
    expect(src).not.toContain('cwdFirstAt');
  });
});
