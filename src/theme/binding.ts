// ThemeProvider ↔ SettingsValueStore 桥(M-Settings v6)。
// 让 SettingsPanel 改「主题」setting item 后,ThemeProvider 立即 setMode。
// 启动时若 store 还没该 key,把 ThemeProvider 当前 mode 推过去做迁移。
//
// 单向数据源(SettingsPanel → ThemeProvider),反向不必接 — 改主题的入口
// 只有 SettingsPanel + 内部 setMode(后者通常仅由 binding 自身触发,不会
// 形成回环)。

import { useEffect } from 'react';
import { useTheme } from './useTheme';
import type { ThemeMode } from './ThemeProvider';
import {
  useSettingValue,
  useSettingsValuesStore,
} from '@/plugins/settings/values-store';

const THEME_SETTING_ID = 'general.theme';
const THEME_DEFAULT: ThemeMode = 'dark';

function isThemeMode(v: unknown): v is ThemeMode {
  return v === 'light' || v === 'dark' || v === 'system';
}

export function useThemeBinding(): void {
  const { mode, setMode } = useTheme();
  // 用 useSettingValue 拿带 fallback 的有效值:reset 后 store 删 key,
  // 这里仍然返回 default,binding 看到值变(从 'light' → 'dark')触发 setMode
  const themeValue = useSettingValue<ThemeMode>(
    THEME_SETTING_ID,
    THEME_DEFAULT,
  );
  const rawStored = useSettingsValuesStore(
    (s) => s.values[THEME_SETTING_ID],
  );
  const setValue = useSettingsValuesStore((s) => s.setValue);

  // store 「general.theme」变化 → 同步到 ThemeProvider
  useEffect(() => {
    if (isThemeMode(themeValue) && themeValue !== mode) {
      setMode(themeValue);
    }
  }, [themeValue, mode, setMode]);

  // 首次挂载:store 还没该 key 且 ThemeProvider 已有非默认 mode → 迁移过去
  useEffect(() => {
    if (rawStored === undefined && mode !== THEME_DEFAULT) {
      setValue(THEME_SETTING_ID, mode);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}
