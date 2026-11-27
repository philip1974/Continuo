// 转到定义有多个结果时的选择器(VSCode 默认在 peek 视图里列出全部定义;本项目没有 peek,改用 Quick Pick 式列表):每行 = 定义所在行的
// 预览 + 「文件名:行」+ 相对工作区的目录;可输入过滤,↑↓ / Enter / 单击跳到所选定义(记导航来处,⌃- 退回)。Esc 关闭不跳。
// 列表机制走共享 usePickerList。BDD: src/__tests__/editor-go-to-definition/

import { useMemo } from 'react';
import { Input, Modal } from '@/design';
import { useT } from '@/i18n';
import { normalizeSearchQuery } from '@/lib/search-query';
import { basename, dirname, stripRootPrefix } from '@/lib/path-cross';
import { useWorkspaceStore } from '@/stores/workspace.store';
import { goToLocation } from '@/panels/Editor/go-to-definition';
import { lowerIfNeeded } from '../../../electron/shared/lower-if-needed';
import type { TsLocation } from '../../../electron/shared/ts-language';
import { usePickerList } from '../picker/use-picker-list';
import { pickerRowClassName, pickerRowSecondaryClassName } from '../picker/picker-row';
import { fuzzyFilter } from '../command-palette/fuzzy';
import { useDefinitionPickerStore } from './store';

export function DefinitionPickerModal() {
  const isOpen = useDefinitionPickerStore((s) => s.isOpen);
  const close = useDefinitionPickerStore((s) => s.close);
  const t = useT();
  if (!isOpen) return null;
  return (
    <Modal visible onClose={close} size="lg" className="!p-0 !rounded-md" aria-label={t('definition_picker.input_aria')}>
      <DefinitionPickerBody />
    </Modal>
  );
}

function DefinitionPickerBody() {
  const t = useT();
  const query = useDefinitionPickerStore((s) => s.query);
  const selectedIndex = useDefinitionPickerStore((s) => s.selectedIndex);
  const locations = useDefinitionPickerStore((s) => s.locations);
  const close = useDefinitionPickerStore((s) => s.close);
  const setQuery = useDefinitionPickerStore((s) => s.setQuery);
  const moveSelection = useDefinitionPickerStore((s) => s.moveSelection);
  const clampSelection = useDefinitionPickerStore((s) => s.clampSelection);
  const root = useWorkspaceStore((s) => s.root);

  const items = useMemo(
    () =>
      locations.map((loc, i) => {
        const name = basename(loc.path);
        const dir = root === null ? dirname(loc.path) : stripRootPrefix(root, dirname(loc.path));
        const where = `${name}:${loc.line}`;
        return { key: `${i}`, loc, where, dir, lower: lowerIfNeeded(`${loc.preview} ${where} ${dir}`.normalize('NFC')) };
      }),
    [locations, root],
  );
  const filtered = useMemo(() => fuzzyFilter(items, normalizeSearchQuery(query), (i) => i.lower), [items, query]);

  const accept = (loc: TsLocation): void => {
    close();
    void goToLocation(loc);
  };

  const { scrollRef, virtualItems, comboboxProps, listboxProps, getOptionProps } = usePickerList({
    idPrefix: 'definition-picker',
    count: filtered.length,
    selectedIndex,
    rowHeight: 28,
    overscan: 8,
    moveSelection,
    clampSelection,
    onEnter: (index) => {
      const item = filtered[index];
      if (item) accept(item.loc);
    },
  });

  return (
    <div className="flex flex-col">
      <div className="border-b border-line p-2">
        <Input
          size="sm"
          data-autofocus
          aria-label={t('definition_picker.input_aria')}
          {...comboboxProps}
          placeholder={t('definition_picker.placeholder')}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>
      <div ref={scrollRef} className="max-h-[min(420px,calc(100vh-8rem))] overflow-y-auto py-1">
        {filtered.length === 0 ? (
          <div role="status" className="px-3 py-4 text-center text-xs text-fg-dim">
            {t('definition_picker.no_match')}
          </div>
        ) : (
          <ul {...listboxProps} aria-label={t('definition_picker.list_aria')}>
            {virtualItems.map((vRow) => {
              const item = filtered[vRow.index]!;
              const selected = vRow.index === selectedIndex;
              return (
                <li
                  key={item.key}
                  {...getOptionProps(vRow)}
                  className={pickerRowClassName(selected)}
                  title={item.loc.path}
                  onClick={() => accept(item.loc)}
                >
                  <span className="min-w-0 flex-1 truncate font-mono">{item.loc.preview}</span>
                  <span className={`shrink-0 text-2xs ${pickerRowSecondaryClassName(selected)}`}>{item.where}</span>
                  <span className={`min-w-0 max-w-[40%] shrink truncate text-2xs ${pickerRowSecondaryClassName(selected)}`}>
                    {item.dir}
                  </span>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}
