// 编码 / 行尾选择器(VSCode changeEncoding / changeEOL 的 Quick Pick):可输入过滤,打开时选中当前编码 / 行尾(行尾标「当前」),
// Enter / 单击确定,Esc / 点遮罩关闭。脏 tab「通过编码重新打开」先弹「放弃更改并重新打开」确认。列表机制走共享 usePickerList。
// BDD: src/__tests__/editor-text-encoding/

import { useMemo } from 'react';
import { Input, Modal } from '@/design';
import { useLocale, useT } from '@/i18n';
import { ConfirmDialog } from '@/lib/ConfirmDialog';
import { normalizeSearchQuery } from '@/lib/search-query';
import { editorTabTitle } from '@/panels/Editor/untitled';
import { lowerIfNeeded } from '../../../electron/shared/lower-if-needed';
import { useEditorStore } from '@/stores/editor.store';
import { findEditorFileTabById } from '@/panels/Editor/editor-tab-lookup';
import { lineEndingOf, tabEncodingOf } from '@/panels/Editor/editor-encoding';
import { usePickerList } from '../picker/use-picker-list';
import { pickerRowClassName, pickerRowSecondaryClassName } from '../picker/picker-row';
import { fuzzyFilter } from '../command-palette/fuzzy';
import { encodingPickItems } from './encoding-picks';
import { acceptEncodingPick, runReopen } from './encoding-actions';
import { useEncodingPickerStore, type EncodingPickRequest } from './store';

export function EncodingPickerModal() {
  const isOpen = useEncodingPickerStore((s) => s.isOpen);
  const request = useEncodingPickerStore((s) => s.request);
  const close = useEncodingPickerStore((s) => s.close);
  const confirm = useEncodingPickerStore((s) => s.confirmReopen);
  const setConfirm = useEncodingPickerStore((s) => s.setConfirmReopen);
  const t = useT();
  return (
    <>
      {isOpen && request !== null && (
        <Modal visible onClose={close} size="lg" className="!p-0 !rounded-md" aria-label={placeholderOf(request, t)}>
          <EncodingPickerBody request={request} />
        </Modal>
      )}
      <ConfirmDialog
        open={confirm !== null}
        title={t('encoding_picker.reopen_dirty.title')}
        description={t('encoding_picker.reopen_dirty.detail')}
        confirmLabel={t('encoding_picker.reopen_dirty.confirm')}
        destructive
        onCancel={() => setConfirm(null)}
        onConfirm={() => {
          setConfirm(null);
          if (confirm) void runReopen(confirm.tabId, confirm.encoding);
        }}
      />
    </>
  );
}

function placeholderOf(request: EncodingPickRequest, t: ReturnType<typeof useT>): string {
  switch (request.kind) {
    case 'action':
      return t('encoding_picker.pick_action');
    case 'reopen':
      return t('encoding_picker.pick_reopen');
    case 'save':
      return t('encoding_picker.pick_save');
    case 'open':
      return t('encoding_picker.pick_open', { name: request.name });
    case 'eol':
      return t('encoding_picker.pick_eol');
  }
}

function EncodingPickerBody({ request }: { readonly request: EncodingPickRequest }) {
  const t = useT();
  const locale = useLocale();
  const query = useEncodingPickerStore((s) => s.query);
  const selectedIndex = useEncodingPickerStore((s) => s.selectedIndex);
  const setQuery = useEncodingPickerStore((s) => s.setQuery);
  const moveSelection = useEncodingPickerStore((s) => s.moveSelection);
  const clampSelection = useEncodingPickerStore((s) => s.clampSelection);
  const tabId = request.kind === 'open' ? null : request.tabId;
  // 当前编码 / 行尾:行尾标「当前」(初始选中它);编码同样标出(VSCode 只靠初始选中)
  const current = useEditorStore((s) => {
    const tab = tabId === null ? null : findEditorFileTabById(s.tabs, tabId);
    if (!tab) return null;
    return request.kind === 'eol' ? lineEndingOf(tab.content) : tabEncodingOf(tab);
  });
  const fileName = useEditorStore((s) => {
    const tab = tabId === null ? null : findEditorFileTabById(s.tabs, tabId);
    return tab ? editorTabTitle(tab.filePath) : null;
  });

  const items = useMemo(
    () =>
      encodingPickItems(request).items.map((item) => {
        const label = item.labelKey !== undefined ? t(item.labelKey) : (item.label ?? item.id);
        return { ...item, text: label, lower: lowerIfNeeded(`${label} ${item.description ?? ''}`) };
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- t 是稳定引用,切语言靠 locale 重算
    [request, t, locale],
  );
  const filtered = useMemo(() => fuzzyFilter(items, normalizeSearchQuery(query), (i) => i.lower), [items, query]);

  const accept = (id: string): void => acceptEncodingPick(request, id);

  const { scrollRef, virtualItems, comboboxProps, listboxProps, getOptionProps } = usePickerList({
    idPrefix: 'encoding-picker',
    count: filtered.length,
    selectedIndex,
    rowHeight: 28,
    overscan: 6,
    moveSelection,
    clampSelection,
    onEnter: (index) => {
      const item = filtered[index];
      if (item) accept(item.id);
    },
  });

  const placeholder = placeholderOf(request, t);
  return (
    <div className="flex flex-col">
      <div className="border-b border-line p-2">
        <Input
          size="sm"
          data-autofocus
          aria-label={fileName === null ? placeholder : t('common.label_detail', { label: placeholder, detail: fileName })}
          {...comboboxProps}
          placeholder={placeholder}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>
      <div ref={scrollRef} className="max-h-[min(420px,calc(100vh-8rem))] overflow-y-auto py-1">
        {filtered.length === 0 ? (
          <div role="status" className="px-3 py-4 text-center text-xs text-fg-dim">
            {t('encoding_picker.no_match')}
          </div>
        ) : (
          <ul {...listboxProps} aria-label={placeholder}>
            {virtualItems.map((vRow) => {
              const item = filtered[vRow.index]!;
              const selected = vRow.index === selectedIndex;
              return (
                <li
                  key={item.id}
                  {...getOptionProps(vRow)}
                  className={pickerRowClassName(selected)}
                  data-encoding-pick={item.id}
                  onClick={() => accept(item.id)}
                >
                  <span className="min-w-0 flex-1 truncate">{item.text}</span>
                  {item.description !== undefined && (
                    <span className={`shrink-0 text-2xs ${pickerRowSecondaryClassName(selected)}`}>{item.description}</span>
                  )}
                  {item.id === current && (
                    <span className={`shrink-0 text-2xs ${pickerRowSecondaryClassName(selected)}`}>
                      {t('encoding_picker.current')}
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
