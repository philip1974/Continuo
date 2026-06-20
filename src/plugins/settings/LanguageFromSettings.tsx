// topic 16 i18n: Settings values store ↔ main settings store 桥。
// 沿用 src/theme/binding.ts useThemeBinding 的模式。

import { useEffect } from 'react';
import type { ReactNode } from 'react';
import {
  useSettingValue,
  useSettingsValuesStore,
} from '@/plugins/settings/values-store';
import { useSettingsStore } from '@/stores/settings.store';
import type { Locale } from '@shared/i18n-types';

const LANGUAGE_SETTING_ID = 'general.language';
const LANGUAGE_DEFAULT: Locale = 'en';

function isLocale(v: unknown): v is Locale {
  return v === 'en' || v === 'zh' || v === 'ko';
}

export function LanguageFromSettings(): ReactNode {
  const value = useSettingValue<Locale>(LANGUAGE_SETTING_ID, LANGUAGE_DEFAULT);
  const rawStored = useSettingsValuesStore(
    (s) => s.values[LANGUAGE_SETTING_ID],
  );
  const setValue = useSettingsValuesStore((s) => s.setValue);
  const storeLocale = useSettingsStore((s) => s.locale);
  const setStoreLocale = useSettingsStore((s) => s.setLocale);

  // values 变化 → call main settings store setLocale（持久化进 settings.json + 广播）。
  // 必须 gate 到「确实有显式 stored value」(rawStored !== undefined):value 在 localStorage
  // 缺失时是 fallback 'en',第一个 effect 无法区分「真存的 en」与「缺省 fallback」。启动时
  // main locale 已是持久化的 zh/ko 而 values 还没该 key → 不 gate 会先把 fallback 'en' 回写
  // main(setLocale 持久化 settings.json + 广播),静默把非默认主语言重置为 en。缺失值只允许
  // 下面的 main → values seed。(codex 复审 loop R14)
  useEffect(() => {
    if (rawStored !== undefined && isLocale(value) && value !== storeLocale) {
      void setStoreLocale(value);
    }
  }, [rawStored, value, storeLocale, setStoreLocale]);

  // 首次挂载：store locale 已是 main 真值（bootstrap inject），但 values 还没该 key →
  // 把 store.locale 写回 values（让 SegmentedControl 显示正确选中态）
  useEffect(() => {
    if (rawStored === undefined && storeLocale !== LANGUAGE_DEFAULT) {
      setValue(LANGUAGE_SETTING_ID, storeLocale);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return null;
}
