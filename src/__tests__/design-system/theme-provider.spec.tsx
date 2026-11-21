import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, act, cleanup } from '@testing-library/react';
import { ThemeProvider, useTheme } from '../../theme';

const STORAGE_KEY = 'layoutmotion.theme.mode';

function Probe({ onMount }: { onMount: (ctx: ReturnType<typeof useTheme>) => void }) {
  const ctx = useTheme();
  onMount(ctx);
  return null;
}

describe('ThemeProvider', () => {
  beforeEach(() => {
    localStorage.clear();
    document.documentElement.classList.remove('dark');
  });
  afterEach(() => cleanup());

  it('无 storage 默认 mode=dark, resolved=dark, html.dark 加上', () => {
    let captured: ReturnType<typeof useTheme> | null = null;
    render(
      <ThemeProvider>
        <Probe onMount={(c) => (captured = c)} />
      </ThemeProvider>,
    );
    expect(captured!.mode).toBe('dark');
    expect(captured!.resolved).toBe('dark');
    expect(document.documentElement.classList.contains('dark')).toBe(true);
  });

  it('storage=light → mount 即 light, html.dark 不加', () => {
    localStorage.setItem(STORAGE_KEY, 'light');
    let captured: ReturnType<typeof useTheme> | null = null;
    render(
      <ThemeProvider>
        <Probe onMount={(c) => (captured = c)} />
      </ThemeProvider>,
    );
    expect(captured!.mode).toBe('light');
    expect(captured!.resolved).toBe('light');
    expect(document.documentElement.classList.contains('dark')).toBe(false);
  });

  it('setMode 写入 localStorage 并立刻切换 class', () => {
    let captured: ReturnType<typeof useTheme> | null = null;
    render(
      <ThemeProvider>
        <Probe onMount={(c) => (captured = c)} />
      </ThemeProvider>,
    );
    act(() => captured!.setMode('light'));
    expect(localStorage.getItem(STORAGE_KEY)).toBe('light');
    expect(document.documentElement.classList.contains('dark')).toBe(false);

    act(() => captured!.setMode('dark'));
    expect(localStorage.getItem(STORAGE_KEY)).toBe('dark');
    expect(document.documentElement.classList.contains('dark')).toBe(true);
  });

  it('setMode 写入当前 mode 时不重复写 localStorage', () => {
    let captured: ReturnType<typeof useTheme> | null = null;
    render(
      <ThemeProvider>
        <Probe onMount={(c) => (captured = c)} />
      </ThemeProvider>,
    );
    const setItemSpy = vi.spyOn(Storage.prototype, 'setItem');
    act(() => captured!.setMode('dark'));
    expect(setItemSpy).not.toHaveBeenCalled();
    setItemSpy.mockRestore();
  });

  it('storage 非法值 → 兜底 dark 并清掉脏 key', () => {
    localStorage.setItem(STORAGE_KEY, 'invalid');
    let captured: ReturnType<typeof useTheme> | null = null;
    render(
      <ThemeProvider>
        <Probe onMount={(c) => (captured = c)} />
      </ThemeProvider>,
    );
    expect(captured!.mode).toBe('dark');
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
  });

  // 边界(E88,local-storage-record 同款兜底):localStorage 被禁用/损坏/受限时 getItem/setItem
  // 会抛(SecurityError/QuotaExceeded),ThemeProvider 须 try/catch 兜底,绝不让渲染/切换崩。
  it('E88 getItem 抛(storage 受限)→ mount 不崩,兜底 dark', () => {
    const spy = vi
      .spyOn(Storage.prototype, 'getItem')
      .mockImplementation(() => {
        throw new Error('SecurityError');
      });
    let captured: ReturnType<typeof useTheme> | null = null;
    expect(() =>
      render(
        <ThemeProvider>
          <Probe onMount={(c) => (captured = c)} />
        </ThemeProvider>,
      ),
    ).not.toThrow();
    expect(captured!.mode).toBe('dark');
    spy.mockRestore();
  });

  it('E88 setItem 抛(quota/security)→ setMode 不崩,内存态 + DOM class 仍更新', () => {
    const spy = vi
      .spyOn(Storage.prototype, 'setItem')
      .mockImplementation(() => {
        throw new Error('QuotaExceededError');
      });
    let captured: ReturnType<typeof useTheme> | null = null;
    render(
      <ThemeProvider>
        <Probe onMount={(c) => (captured = c)} />
      </ThemeProvider>,
    );
    expect(() => act(() => captured!.setMode('light'))).not.toThrow();
    expect(captured!.resolved).toBe('light'); // 内存态更新
    expect(document.documentElement.classList.contains('dark')).toBe(false); // DOM 更新
    spy.mockRestore();
  });

  // 边界(E90):MediaQueryList 事件订阅 API 不保证存在 —— 旧 WebKit/Electron / 受限环境只有
  // addListener/removeListener(无 addEventListener),或两者都无。feature-detect 不崩。
  it('E90 mql 仅旧 API(addListener)→ mount 不崩,用旧 API 订阅', () => {
    let legacyHandler: ((e: MediaQueryListEvent) => void) | null = null;
    const fakeMql = {
      matches: false,
      addListener: (h: (e: MediaQueryListEvent) => void) => {
        legacyHandler = h;
      },
      removeListener: vi.fn(),
      // 无 addEventListener / removeEventListener
    };
    const spy = vi
      .spyOn(window, 'matchMedia')
      .mockReturnValue(fakeMql as unknown as MediaQueryList);
    expect(() =>
      render(
        <ThemeProvider>
          <Probe onMount={() => {}} />
        </ThemeProvider>,
      ),
    ).not.toThrow();
    expect(legacyHandler).not.toBeNull(); // 回退到旧 API 订阅
    spy.mockRestore();
  });

  it('E90 mql 无任何订阅 API → mount 不崩,跳过订阅', () => {
    const fakeMql = { matches: false }; // 无 add/removeEventListener / addListener
    const spy = vi
      .spyOn(window, 'matchMedia')
      .mockReturnValue(fakeMql as unknown as MediaQueryList);
    expect(() =>
      render(
        <ThemeProvider>
          <Probe onMount={() => {}} />
        </ThemeProvider>,
      ),
    ).not.toThrow();
    spy.mockRestore();
  });
});
