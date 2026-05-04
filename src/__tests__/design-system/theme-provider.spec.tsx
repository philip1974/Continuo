import { describe, it, expect, beforeEach, afterEach } from 'vitest';
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

  it('storage 非法值 → 兜底 dark', () => {
    localStorage.setItem(STORAGE_KEY, 'invalid');
    let captured: ReturnType<typeof useTheme> | null = null;
    render(
      <ThemeProvider>
        <Probe onMount={(c) => (captured = c)} />
      </ThemeProvider>,
    );
    expect(captured!.mode).toBe('dark');
  });
});
