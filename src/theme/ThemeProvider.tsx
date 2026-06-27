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
  // 边界(E88,local-storage-record 同款兜底):getItem 在 localStorage 被禁用/损坏/受限
  //(SecurityError 等)时会**抛**,不只是返 null。此前裸调用会让 useState(readStoredMode)
  // 在渲染期抛 → renderer 崩。try/catch 回退默认 'dark'(启动不因存储不可用而崩)。
  try {
    const v = globalThis.localStorage.getItem(STORAGE_KEY);
    if (v === 'light' || v === 'dark' || v === 'system') return v;
  } catch {
    // 存储不可用 → 用默认主题
  }
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
    // 边界(E90):matchMedia 不保证存在(与 resolveSystemPreference 同守卫)。
    if (typeof globalThis.window.matchMedia !== 'function') return;
    const mql = globalThis.window.matchMedia('(prefers-color-scheme: dark)');
    const handler = (e: MediaQueryListEvent) => {
      setSystemPref(e.matches ? 'dark' : 'light');
    };
    // 边界(E90):MediaQueryList 事件订阅 API 不保证存在 —— 现代为 add/removeEventListener,
    // 旧 WebKit/Electron / 受限测试环境 / 畸形 polyfill 可能只有 addListener/removeListener,
    // 甚至都没有。feature-detect:优先现代、回退旧、都无则跳过订阅(订阅不可用不应让根 Provider
    // 挂载 effect 抛错、打断主题系统乃至 renderer 启动)。cleanup 对称。
    if (typeof mql.addEventListener === 'function') {
      mql.addEventListener('change', handler);
      return () => mql.removeEventListener('change', handler);
    }
    if (typeof mql.addListener === 'function') {
      mql.addListener(handler); // 旧环境回退
      return () => mql.removeListener(handler);
    }
    return;
  }, []);

  useEffect(() => {
    applyThemeClass(resolved);
  }, [resolved]);

  const setMode = useCallback((next: ThemeMode) => {
    setModeState(next); // 内存态 + DOM class(useEffect)始终更新
    // 边界(E88):setItem 可抛 quota/security error —— 写失败只忽略持久化,绝不中断主题切换。
    if (typeof globalThis.localStorage !== 'undefined') {
      try {
        globalThis.localStorage.setItem(STORAGE_KEY, next);
      } catch {
        // 存储满/禁用/受限 → 只丢持久化,内存态与 DOM 已更新
      }
    }
  }, []);

  const value = useMemo<ThemeContextValue>(
    () => ({ mode, resolved, setMode }),
    [mode, resolved, setMode],
  );

  return createElement(ThemeContext.Provider, { value }, children);
}
