import { create } from 'zustand';
import { coApi } from '@/lib/co-api';
import { setLocale as setI18nModuleLocale, notifyLocaleChange } from '@/i18n';
import { LocaleSchema, type Locale } from '@shared/i18n-types';

// 边界(E170,E168/E169 同族 IPC ingress 纵深防御):i18n:changed 广播驱动全局 locale + translate()。
// 此前 onChange 回调直接用 payload.locale/payload.gen。非法 locale(catalog 不存在,如 'fr')→
// setI18nModuleLocale 后 translate() 的 DICTS[locale] 为 undefined → 全 UI 渲染崩溃(跨窗广播,影响
// 所有窗口);NaN/Infinity gen 污染乱序保护(`gen < currentGen` 对 NaN 恒 false → 后续广播全被旧 gen
// 挡或反之)。主进程 setLocale IPC 已用 LocaleSchema 校验(故生产不可达),但广播 ingress 仍补齐校验
// (后果严重 + 复用单源 LocaleSchema,与 E168/E169 一致)。非法 drop + warn,不更新 store/module。
function isValidI18nChangedPayload(
  v: unknown,
): v is { locale: Locale; gen: number } {
  if (v === null || typeof v !== 'object') return false;
  const o = v as Record<string, unknown>;
  if (!LocaleSchema.safeParse(o.locale).success) return false;
  return (
    typeof o.gen === 'number' && Number.isSafeInteger(o.gen) && o.gen >= 0
  );
}

export interface SettingsState {
  /** 当前 locale — 启动时由 main.tsx bootstrap 用 main 真值 setState 注入；之后随 setLocale 更新。 */
  readonly locale: Locale;
  /** 最新一次本端发起或收到的 in-flight gen；过期 callback 丢弃。 */
  readonly currentGen: number;
  setLocale: (locale: Locale) => Promise<void>;
}

export const useSettingsStore = create<SettingsState>((set, get) => ({
  locale: 'en',
  currentGen: 0,
  setLocale: async (locale: Locale) => {
    // 调 main 持久化，等待返回 gen
    const result = await coApi.i18n.setLocale(locale);
    if (!result.ok) {
      // 失败：保留旧 locale，调用方决定 UI 提示
      throw new Error(`setLocale failed: code=${result.code} message=${result.message}`);
    }
    const next = result.data;
    // 仅当本次 gen 不旧时更新（防同窗内乱序）
    const current = get();
    if (next.gen < current.currentGen) return;
    if (next.locale === current.locale && next.gen === current.currentGen) return;
    set({ locale: next.locale, currentGen: next.gen });
    setI18nModuleLocale(next.locale);
    notifyLocaleChange();
  },
}));

/**
 * 启动时挂一次 broadcast listener — 接受 main 推过来的 CHANGED。
 * fire-and-forget；renderer 生命周期级订阅，不显式 unsubscribe。
 *
 * 严格防乱序：payload.gen < currentGen → drop。
 */
let _subscribed = false;
export function subscribeToI18nBroadcast(): void {
  if (_subscribed) return;
  _subscribed = true;
  coApi.i18n.onChange((payload) => {
    // 边界(E170):广播 ingress runtime 校验,非法 payload drop + warn,不污染 locale/乱序保护。
    if (!isValidI18nChangedPayload(payload)) {
      console.warn('[i18n-broadcast] invalid payload, dropped', payload);
      return;
    }
    const current = useSettingsStore.getState();
    if (payload.gen < current.currentGen) return;
    if (payload.locale === current.locale && payload.gen === current.currentGen) return;
    useSettingsStore.setState({ locale: payload.locale, currentGen: payload.gen });
    setI18nModuleLocale(payload.locale);
    notifyLocaleChange();
  });
}

/** Test helper. */
export function _resetSettingsStoreForTest(): void {
  useSettingsStore.setState({ locale: 'en', currentGen: 0 });
  _subscribed = false;
}
