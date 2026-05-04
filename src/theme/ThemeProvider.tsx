// LM 本地的 ThemeProvider(从 @nous/shell-ui/theme 移植 + 加 localStorage 持久化)。
// 与 Nous 行为一致:切 .dark class on <html>,system 模式跟随 OS。
// 区别:LM 暗色优先(无存储时默认 'dark'),并把 mode 写入 localStorage。

import {
  createContext,
  createElement,
  useCallback,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';

export type ThemeMode = 'light' | 'dark' | 'system';

export interface ThemeContextValue {
  readonly mode: ThemeMode;
  readonly resolved: 'light' | 'dark';
  setMode: (mode: ThemeMode) => void;
}

const STORAGE_KEY = 'layoutmotion.theme.mode';

export const ThemeContext = createContext<ThemeContextValue>({
  mode: 'dark',
  resolved: 'dark',
  setMode: () => {},
});

function readStoredMode(): ThemeMode {
  if (typeof globalThis.localStorage === 'undefined') return 'dark';
  const v = globalThis.localStorage.getItem(STORAGE_KEY);
  if (v === 'light' || v === 'dark' || v === 'system') return v;
  return 'dark';
}

function resolveSystemPreference(): 'light' | 'dark' {
  if (typeof globalThis.window === 'undefined') return 'dark';
  if (typeof globalThis.window.matchMedia !== 'function') return 'dark';
  return globalThis.window.matchMedia('(prefers-color-scheme: dark)').matches
    ? 'dark'
    : 'light';
}

function applyThemeClass(resolved: 'light' | 'dark'): void {
  if (typeof globalThis.document === 'undefined') return;
  const root = globalThis.document.documentElement;
  if (resolved === 'dark') root.classList.add('dark');
  else root.classList.remove('dark');
}

interface ThemeProviderProps {
  readonly children: ReactNode;
}

export function ThemeProvider({ children }: ThemeProviderProps) {
  const [mode, setModeState] = useState<ThemeMode>(readStoredMode);
  const [systemPref, setSystemPref] = useState<'light' | 'dark'>(
    resolveSystemPreference,
  );

  const resolved: 'light' | 'dark' = mode === 'system' ? systemPref : mode;

  useEffect(() => {
    if (typeof globalThis.window === 'undefined') return;
    const mql = globalThis.window.matchMedia('(prefers-color-scheme: dark)');
    const handler = (e: MediaQueryListEvent) => {
      setSystemPref(e.matches ? 'dark' : 'light');
    };
    mql.addEventListener('change', handler);
    return () => mql.removeEventListener('change', handler);
  }, []);

  useEffect(() => {
    applyThemeClass(resolved);
  }, [resolved]);

  const setMode = useCallback((next: ThemeMode) => {
    setModeState(next);
    if (typeof globalThis.localStorage !== 'undefined') {
      globalThis.localStorage.setItem(STORAGE_KEY, next);
    }
  }, []);

  const value = useMemo<ThemeContextValue>(
    () => ({ mode, resolved, setMode }),
    [mode, resolved, setMode],
  );

  return createElement(ThemeContext.Provider, { value }, children);
}
