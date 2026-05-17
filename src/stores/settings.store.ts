import { create } from 'zustand';
import { coApi } from '@/lib/co-api';
import { setLocale as setI18nModuleLocale, notifyLocaleChange } from '@/i18n';
import type { Locale } from '@shared/i18n-types';

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
    if (next.gen < get().currentGen) return;
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
