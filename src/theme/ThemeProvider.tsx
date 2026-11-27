// 主题 Provider:切 .dark class on <html>,system 模式跟随 OS;默认 dark。
// mode 的唯一存储是设置值 general.theme(values-store;设置页的「主题」项读写同一份)。此前 Provider 另存一份
// localStorage 键、再由 useThemeBinding 从设置值单向同步,两份存储靠胶水保持一致。旧键只在启动时迁移一次后删除。

import {
  createContext,
  createElement,
  useCallback,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from 'react';
import { create } from 'zustand';
import {
  getStoredSettingValue,
  useSettingValue,
  useSettingsValuesStore,
} from '@/plugins/settings/values-store';
import { GENERAL_THEME } from '@/plugins/settings/core-setting-specs';
import { getPopoutDocuments, subscribePopoutDocuments } from '@/shell/dock/popout-documents';

export type ThemeMode = 'light' | 'dark' | 'system';

/** 主题模式全集(颜色主题选择器的列表顺序,同设置页选项)。 */
export const THEME_MODES: readonly ThemeMode[] = ['light', 'dark', 'system'];

export interface ThemeContextValue {
  /** 设置值 general.theme(不含预览)。 */
  readonly mode: ThemeMode;
  /** 实际生效的亮 / 暗(颜色主题选择器预览中 → 预览项)。 */
  readonly resolved: 'light' | 'dark';
  setMode: (mode: ThemeMode) => void;
}

const THEME_SETTING_ID = GENERAL_THEME.id;
const THEME_DEFAULT: ThemeMode = GENERAL_THEME.default;
// 旧版独立存储键(沿用前身 LayoutMotion 的名字),只用于一次性迁移。
const LEGACY_STORAGE_KEY = 'layoutmotion.theme.mode';

export const ThemeContext = createContext<ThemeContextValue>({
  mode: THEME_DEFAULT,
  resolved: 'dark',
  setMode: () => {},
});

function isThemeMode(v: unknown): v is ThemeMode {
  return v === 'light' || v === 'dark' || v === 'system';
}

/**
 * 旧键 → 设置值的一次性迁移(首帧前同步执行,不闪烁):设置值尚无且旧键合法 → 写入设置值;旧键无论如何删除。
 * 边界(E88):localStorage 被禁用 / 受限时 getItem / removeItem 会抛 —— 吞掉,按无旧值处理。
 */
function migrateLegacyThemeMode(): void {
  if (typeof globalThis.localStorage === 'undefined') return;
  let legacy: string | null;
  try {
    legacy = globalThis.localStorage.getItem(LEGACY_STORAGE_KEY);
  } catch {
    return;
  }
  if (legacy === null) return;
  if (isThemeMode(legacy) && getStoredSettingValue(THEME_SETTING_ID) === undefined) {
    useSettingsValuesStore.getState().setValue(THEME_SETTING_ID, legacy);
  }
  try {
    globalThis.localStorage.removeItem(LEGACY_STORAGE_KEY);
  } catch {
    // 删除失败:下次启动再试,设置值已优先
  }
}

/**
 * 颜色主题预览(VSCode 颜色主题选择器上下移动即预览,target 'preview':只作用于界面,不写设置)。非 null 时本窗口按它渲染,
 * 关闭选择器(Esc / 确定)清回 null。只在本 JS 环境(主窗及其 popout 子窗,子窗由主窗 Provider 同步 class)生效,不跨窗口。
 * BDD: src/__tests__/theme-commands/
 */
export const useThemePreviewStore = create<{ readonly preview: ThemeMode | null }>(() => ({ preview: null }));

export function setThemePreview(preview: ThemeMode | null): void {
  if (useThemePreviewStore.getState().preview !== preview) useThemePreviewStore.setState({ preview });
}

/** 当前设置的主题模式(非 React 调用方用;非法 / 缺失 → 默认)。 */
export function currentThemeMode(): ThemeMode {
  const stored = getStoredSettingValue(THEME_SETTING_ID);
  return isThemeMode(stored) ? stored : THEME_DEFAULT;
}

/** 模式 → 亮 / 暗(system 按 prefers-color-scheme)。 */
export function resolveThemeMode(mode: ThemeMode): 'light' | 'dark' {
  return mode === 'system' ? resolveSystemPreference() : mode;
}

function resolveSystemPreference(): 'light' | 'dark' {
  if (typeof globalThis.window === 'undefined') return 'dark';
  if (typeof globalThis.window.matchMedia !== 'function') return 'dark';
  return globalThis.window.matchMedia('(prefers-color-scheme: dark)').matches
    ? 'dark'
    : 'light';
}

function applyThemeClass(doc: Document, resolved: 'light' | 'dark'): void {
  doc.documentElement.classList.toggle('dark', resolved === 'dark');
}

interface ThemeProviderProps {
  readonly children: ReactNode;
}

export function ThemeProvider({ children }: ThemeProviderProps) {
  useState(migrateLegacyThemeMode); // 首次渲染前同步跑一次(幂等)
  const stored = useSettingValue<string>(THEME_SETTING_ID, THEME_DEFAULT);
  const mode: ThemeMode = isThemeMode(stored) ? stored : THEME_DEFAULT;
  const preview = useThemePreviewStore((s) => s.preview);
  const popoutDocs = useSyncExternalStore(subscribePopoutDocuments, getPopoutDocuments);
  const setValue = useSettingsValuesStore((st) => st.setValue);
  const [systemPref, setSystemPref] = useState<'light' | 'dark'>(
    resolveSystemPreference,
  );

  const effective = preview ?? mode;
  const resolved: 'light' | 'dark' = effective === 'system' ? systemPref : effective;

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

  // popout 子窗各自跑一份 App(按同一设置值定 class),但预览只在本 JS 环境 —— 子窗的 <html> 也由这里同步,子窗里打开
  // 的颜色主题选择器预览才看得见(VSCode:辅助窗口与主窗同一主题)。无预览时与子窗自己算的结果一致。
  useEffect(() => {
    if (typeof globalThis.document === 'undefined') return;
    applyThemeClass(globalThis.document, resolved);
    for (const doc of popoutDocs) applyThemeClass(doc, resolved);
  }, [resolved, popoutDocs]);

  // 写设置值。values-store 兜底:quota / security 异常只丢持久化,内存态与 DOM class 照常更新;整份设置记录
  // 序列化超读端上限(too-large)时拒写且不提交内存态 —— 此时主题不切换(与其它设置项一致,防内存与磁盘发散)。
  const setMode = useCallback(
    (next: ThemeMode) => {
      if (next !== mode) setValue(THEME_SETTING_ID, next);
    },
    [mode, setValue],
  );

  const value = useMemo<ThemeContextValue>(
    () => ({ mode, resolved, setMode }),
    [mode, resolved, setMode],
  );

  return createElement(ThemeContext.Provider, { value }, children);
}
