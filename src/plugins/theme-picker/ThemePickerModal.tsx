// 颜色主题选择器(VSCode workbench.action.selectTheme 的 Quick Pick):列出 亮色 / 暗色 / 高对比度深色 / 高对比度浅色 / 跟随系统,可输入过滤;打开时选中当前
// 主题(行尾标「当前」),↑↓ 移动即预览(setThemePreview,只改界面不写设置;VSCode 同为 'preview' 目标),Enter / 单击写入设置
// general.theme 并关闭,Esc / 点遮罩关闭并恢复原主题(store.close 清预览)。列表机制走共享 usePickerList。
// BDD: src/__tests__/theme-commands/

import { useEffect, useMemo } from 'react';
import { Input, Modal } from '@/design';
import { useLocale, useT } from '@/i18n';
import { normalizeSearchQuery } from '@/lib/search-query';
import { lowerIfNeeded } from '../../../electron/shared/lower-if-needed';
import { useSettingsValuesStore } from '@/plugins/settings/values-store';
import { GENERAL_THEME } from '@/plugins/settings/core-setting-specs';
import { setThemePreview, THEME_MODES, useTheme, type ThemeMode } from '@/theme';
import { usePickerList } from '../picker/use-picker-list';
import { pickerRowClassName, pickerRowSecondaryClassName } from '../picker/picker-row';
import { fuzzyFilter } from '../command-palette/fuzzy';
import { useThemePickerStore } from './store';

const MODE_LABEL_KEYS: Record<ThemeMode, string> = {
  light: 'settings.general.theme.light',
  dark: 'settings.general.theme.dark',
  hcDark: 'settings.general.theme.hc_dark',
  hcLight: 'settings.general.theme.hc_light',
  system: 'settings.general.theme.system',
};

export function ThemePickerModal() {
  const isOpen = useThemePickerStore((s) => s.isOpen);
  const close = useThemePickerStore((s) => s.close);
  const t = useT();
  if (!isOpen) return null;
  return (
    <Modal visible onClose={close} size="lg" className="!p-0 !rounded-md" aria-label={t('theme_picker.input_aria')}>
      <ThemePickerBody />
    </Modal>
  );
}

function ThemePickerBody() {
  const t = useT();
  const query = useThemePickerStore((s) => s.query);
  const selectedIndex = useThemePickerStore((s) => s.selectedIndex);
  const close = useThemePickerStore((s) => s.close);
  const setQuery = useThemePickerStore((s) => s.setQuery);
  const moveSelection = useThemePickerStore((s) => s.moveSelection);
  const clampSelection = useThemePickerStore((s) => s.clampSelection);
  const setValue = useSettingsValuesStore((s) => s.setValue);
  const { mode: current } = useTheme();
  const locale = useLocale();

  const items = useMemo(
    () =>
      THEME_MODES.map((mode) => {
        const label = t(MODE_LABEL_KEYS[mode]);
        return { mode, label, lower: lowerIfNeeded(`${label} ${mode}`) };
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- t 是稳定引用,切语言靠 locale 重算
    [t, locale],
  );
  const filtered = useMemo(() => fuzzyFilter(items, normalizeSearchQuery(query), (i) => i.lower), [items, query]);
  const active = filtered[selectedIndex]?.mode ?? null;

  // 选中行变化 → 预览(无匹配项 → 原主题);卸载(任何关闭路径)→ 清预览
  useEffect(() => setThemePreview(active), [active]);
  useEffect(() => () => setThemePreview(null), []);

  const accept = (mode: ThemeMode): void => {
    if (mode !== current) setValue(GENERAL_THEME.id, mode);
    close();
  };

  const { scrollRef, virtualItems, comboboxProps, listboxProps, getOptionProps } = usePickerList({
    idPrefix: 'theme-picker',
    count: filtered.length,
    selectedIndex,
    rowHeight: 28,
    overscan: 4,
    moveSelection,
    clampSelection,
    onEnter: (index) => {
      const item = filtered[index];
      if (item) accept(item.mode);
    },
  });

  return (
    <div className="flex flex-col">
      <div className="border-b border-line p-2">
        <Input
          size="sm"
          data-autofocus
          aria-label={t('theme_picker.input_aria')}
          {...comboboxProps}
          placeholder={t('theme_picker.placeholder')}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>
      <div ref={scrollRef} className="max-h-[min(420px,calc(100vh-8rem))] overflow-y-auto py-1">
        {filtered.length === 0 ? (
          <div role="status" className="px-3 py-4 text-center text-xs text-fg-dim">
            {t('theme_picker.no_match')}
          </div>
        ) : (
          <ul {...listboxProps} aria-label={t('theme_picker.list_aria')}>
            {virtualItems.map((vRow) => {
              const item = filtered[vRow.index]!;
              const selected = vRow.index === selectedIndex;
              return (
                <li
                  key={item.mode}
                  {...getOptionProps(vRow)}
                  className={pickerRowClassName(selected)}
                  data-theme-mode={item.mode}
                  onClick={() => accept(item.mode)}
                >
                  <span className="min-w-0 flex-1 truncate">{item.label}</span>
                  {item.mode === current && (
                    <span className={`shrink-0 text-2xs ${pickerRowSecondaryClassName(selected)}`}>
                      {t('theme_picker.current')}
                    </span>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}
