// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render, act, cleanup } from '@testing-library/react';
import { ThemeProvider } from '../../theme';
import { useThemeBinding } from '../../theme/binding';
import { useSettingsValuesStore } from '../../plugins/settings/values-store';

const THEME_KEY = 'layoutmotion.theme.mode';

function Probe() {
  useThemeBinding();
  return null;
}

function App() {
  return (
    <ThemeProvider>
      <Probe />
    </ThemeProvider>
  );
}

beforeEach(() => {
  localStorage.clear();
  document.documentElement.classList.remove('dark');
  // 重置 settings values store
  useSettingsValuesStore.setState({ values: {} });
});

afterEach(() => cleanup());

describe('useThemeBinding', () => {
  it('store 写 light → ThemeProvider 切到 light(html.dark 移除)', () => {
    render(<App />);
    expect(document.documentElement.classList.contains('dark')).toBe(true);

    act(() => {
      useSettingsValuesStore.getState().setValue('general.theme', 'light');
    });

    expect(document.documentElement.classList.contains('dark')).toBe(false);
    expect(localStorage.getItem(THEME_KEY)).toBe('light');
  });

  it('store 写非法值 → 不调 setMode(class 不变)', () => {
    render(<App />);
    act(() => {
      useSettingsValuesStore
        .getState()
        .setValue('general.theme', 'rainbow' as never);
    });
    // 还是 dark
    expect(document.documentElement.classList.contains('dark')).toBe(true);
  });

  it('挂载时 ThemeProvider 已是 light 但 store 无 key → 迁移写入 store', () => {
    localStorage.setItem(THEME_KEY, 'light');
    render(<App />);
    // binding 第二个 effect 把当前 mode 推到 store
    expect(useSettingsValuesStore.getState().values['general.theme']).toBe(
      'light',
    );
  });

  it('挂载时 ThemeProvider 是默认 dark + store 无 key → 不写迁移', () => {
    render(<App />);
    expect(
      useSettingsValuesStore.getState().values['general.theme'],
    ).toBeUndefined();
  });

  it('reset(删 store key) 后 → binding 看到 default 为 dark,不会再切', () => {
    localStorage.setItem(THEME_KEY, 'light');
    render(<App />);
    // 此时 store 已被迁移=light, mode=light
    expect(document.documentElement.classList.contains('dark')).toBe(false);

    act(() => {
      useSettingsValuesStore.getState().setValue('general.theme', 'dark');
    });
    expect(document.documentElement.classList.contains('dark')).toBe(true);
  });
});
