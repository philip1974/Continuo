// 切换窗口(VSCode workbench.action.switchWindow 的 Quick Pick,mac ⌃W):列出所有窗口 —— 各主窗口及其 popout 子窗(VSCode 同列
// 辅助窗口,排在所属主窗之后;这里缩进表示归属),当前窗口标「当前窗口」,初始选中它的下一个;可输入按标题过滤,↑↓ / Enter / 点击
// 聚焦所选窗口(window:focus-window)。列表机制走共享 usePickerList。BDD: src/__tests__/switch-window/

import { useMemo } from 'react';
import { Input, Modal } from '@/design';
import { useT } from '@/i18n';
import { coApi } from '@/lib/co-api';
import { notifyFailure, notifyThrownError } from '@/notifications/notify-thrown-error';
import { normalizeSearchQuery } from '@/lib/search-query';
import { lowerIfNeeded } from '../../../electron/shared/lower-if-needed';
import type { WindowSwitchEntry } from '../../../electron/shared/window-channels';
import { usePickerList } from '../picker/use-picker-list';
import { pickerRowClassName, pickerRowSecondaryClassName } from '../picker/picker-row';
import { fuzzyFilter } from '../command-palette/fuzzy';
import { useSwitchWindowStore } from './store';

export function SwitchWindowModal() {
  const isOpen = useSwitchWindowStore((s) => s.isOpen);
  const close = useSwitchWindowStore((s) => s.close);
  const t = useT();
  if (!isOpen) return null;
  return (
    <Modal visible onClose={close} size="lg" className="!p-0 !rounded-md" aria-label={t('switch_window.input_aria')}>
      <SwitchWindowBody />
    </Modal>
  );
}

/** 聚焦所选窗口;是当前窗口 → 只关闭选择器(VSCode 同:focusWindow 当前窗口无变化)。 */
function focusWindow(entry: WindowSwitchEntry): void {
  if (entry.current) return;
  coApi.window.focusWindow(entry.id).then((r) => {
    if (!r.ok) notifyFailure(r);
  }, notifyThrownError);
}

function SwitchWindowBody() {
  const t = useT();
  const query = useSwitchWindowStore((s) => s.query);
  const selectedIndex = useSwitchWindowStore((s) => s.selectedIndex);
  const windows = useSwitchWindowStore((s) => s.windows);
  const close = useSwitchWindowStore((s) => s.close);
  const setQuery = useSwitchWindowStore((s) => s.setQuery);
  const moveSelection = useSwitchWindowStore((s) => s.moveSelection);
  const clampSelection = useSwitchWindowStore((s) => s.clampSelection);

  const items = useMemo(
    () => (windows ?? []).map((w) => ({ ...w, lower: lowerIfNeeded(w.title.normalize('NFC')) })),
    [windows],
  );
  const filtered = useMemo(() => fuzzyFilter(items, normalizeSearchQuery(query), (i) => i.lower), [items, query]);

  const accept = (entry: WindowSwitchEntry): void => {
    close();
    focusWindow(entry);
  };

  const { scrollRef, virtualItems, comboboxProps, listboxProps, getOptionProps } = usePickerList({
    idPrefix: 'switch-window',
    count: filtered.length,
    selectedIndex,
    rowHeight: 28,
    overscan: 8,
    moveSelection,
    clampSelection,
    onEnter: (index) => {
      const item = filtered[index];
      if (item) accept(item);
    },
  });

  return (
    <div className="flex flex-col">
      <div className="border-b border-line p-2">
        <Input
          size="sm"
          data-autofocus
          aria-label={t('switch_window.input_aria')}
          {...comboboxProps}
          placeholder={t('switch_window.placeholder')}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>
      <div ref={scrollRef} className="max-h-[min(420px,calc(100vh-8rem))] overflow-y-auto py-1">
        {windows !== null && filtered.length === 0 ? (
          <div role="status" className="px-3 py-4 text-center text-xs text-fg-dim">
            {t('switch_window.no_match')}
          </div>
        ) : (
          filtered.length > 0 && (
            <ul {...listboxProps} aria-label={t('switch_window.list_aria')}>
              {virtualItems.map((vRow) => {
                const item = filtered[vRow.index]!;
                const selected = vRow.index === selectedIndex;
                return (
                  <li
                    key={item.id}
                    {...getOptionProps(vRow)}
                    className={pickerRowClassName(selected)}
                    data-window-id={item.id}
                    title={item.title}
                    onClick={() => accept(item)}
                  >
                    <span className={`min-w-0 flex-1 truncate${item.parentId === null ? '' : ' pl-4'}`}>{item.title}</span>
                    {item.current && (
                      <span className={`shrink-0 text-2xs ${pickerRowSecondaryClassName(selected)}`}>
                        {t('switch_window.current')}
                      </span>
                    )}
                  </li>
                );
              })}
            </ul>
          )
        )}
      </div>
    </div>
  );
}
