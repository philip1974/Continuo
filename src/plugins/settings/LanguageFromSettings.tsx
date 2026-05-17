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

  // values 变化 → call main settings store setLocale（持久化进 settings.json + 广播）
  useEffect(() => {
    if (isLocale(value) && value !== storeLocale) {
      void setStoreLocale(value);
    }
  }, [value, storeLocale, setStoreLocale]);

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
