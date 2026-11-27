// 打开最近的文件夹(VSCode workbench.action.openRecent 的 Quick Pick,⌃R):列出「最近打开」的文件夹(当前文件夹除外,同资源管理器
// 「打开最近」菜单),可输入过滤,↑↓ / Enter / 点击打开。打开与「最近打开」菜单同一路径(openRecentRootOrNotify):已在别的窗口
// 打开 → 聚焦那个窗口;目录已不存在 → 询问是否从列表删除;切换后焦点交给新文件树(switchToCheckedRoot)。
// ⌘Enter / ⌘ 单击(Windows / Linux Ctrl)在新窗口打开(openRecentRootInNewWindow,同「在新窗口打开文件夹…」;VSCode 同,占位文字
// 照抄其提示)。
// 列表机制(虚拟化 / 键盘 / ARIA)走共享 usePickerList,与命令面板 / Quick Open 一致。
// BDD: src/__tests__/workbench-missing-commands/

import { useMemo } from 'react';
import { Input, Modal, TruncateStart } from '@/design';
import { useT } from '@/i18n';
import { useWorkspaceStore } from '@/stores/workspace.store';
import { pathEquals } from '@/lib/path-cross';
import { normalizeSearchQuery } from '@/lib/search-query';
import { lowerIfNeeded } from '../../../electron/shared/lower-if-needed';
import { openRecentRootInNewWindow, openRecentRootOrNotify } from '@/panels/Explorer/open-recent-root';
import { detectPlatform } from '../command-palette/format-hotkey';
import { useRecentRootMissingPrompt } from '@/panels/Explorer/RecentRootMissingDialog';
import { recentRootAccessibleName, recentRootLabelParts } from '@/panels/Explorer/path-utils';
import { usePickerList } from '../picker/use-picker-list';
import { pickerRowClassName, pickerRowSecondaryClassName } from '../picker/picker-row';
import { fuzzyFilter } from '../command-palette/fuzzy';
import { useOpenRecentStore } from './store';

interface RecentItem {
  readonly path: string;
  readonly name: string;
  readonly parent: string;
  /** 过滤用小写匹配源(名称 + 完整路径;NFC,与归一后的查询对齐 —— 磁盘上 NFD 的文件夹名也能搜到)。 */
  readonly lower: string;
}

/** 列表项:最近打开的文件夹,当前文件夹除外(同资源管理器「打开最近」菜单)。 */
export function openRecentItems(recentRoots: readonly string[], root: string | null): RecentItem[] {
  const out: RecentItem[] = [];
  for (const p of recentRoots) {
    if (root !== null && pathEquals(p, root)) continue;
    const { name, parent } = recentRootLabelParts(p);
    out.push({ path: p, name, parent, lower: lowerIfNeeded(`${name} ${p}`.normalize('NFC')) });
  }
  return out;
}

/** 「在新窗口打开」的修饰键:mac ⌘,Windows / Linux Ctrl(VSCode keyMods.ctrlCmd)。 */
function isCtrlCmd(mods: { readonly metaKey: boolean; readonly ctrlKey: boolean }): boolean {
  return detectPlatform() === 'mac' ? mods.metaKey : mods.ctrlKey;
}

/** 常驻 App 顶层:询问框(目录已不存在)在 picker 关闭后仍要显示,故挂在外层;列表只在打开时挂载。 */
export function OpenRecentModal() {
  const isOpen = useOpenRecentStore((s) => s.isOpen);
  const close = useOpenRecentStore((s) => s.close);
  const missingPrompt = useRecentRootMissingPrompt();
  const t = useT();
  return (
    <>
      {isOpen && (
        <Modal visible onClose={close} size="lg" className="!p-0 !rounded-md" aria-label={t('open_recent.input_aria')}>
          <OpenRecentBody onMissing={missingPrompt.onMissing} />
        </Modal>
      )}
      {missingPrompt.dialog}
    </>
  );
}

function OpenRecentBody({ onMissing }: { readonly onMissing: (path: string) => void }) {
  const t = useT();
  const query = useOpenRecentStore((s) => s.query);
  const selectedIndex = useOpenRecentStore((s) => s.selectedIndex);
  const close = useOpenRecentStore((s) => s.close);
  const setQuery = useOpenRecentStore((s) => s.setQuery);
  const moveSelection = useOpenRecentStore((s) => s.moveSelection);
  const clampSelection = useOpenRecentStore((s) => s.clampSelection);
  const recentRoots = useWorkspaceStore((s) => s.recentRoots);
  const root = useWorkspaceStore((s) => s.root);
  const setRoot = useWorkspaceStore((s) => s.setRoot);

  const items = useMemo(() => openRecentItems(recentRoots, root), [recentRoots, root]);
  const filtered = useMemo(() => fuzzyFilter(items, normalizeSearchQuery(query), (i) => i.lower), [items, query]);

  // ⌘Enter / ⌘ 单击(Windows / Linux Ctrl)→ 在新窗口打开(VSCode openRecent:keyMods.ctrlCmd → forceNewWindow)
  const openItem = (item: RecentItem, mods: { readonly metaKey: boolean; readonly ctrlKey: boolean }): void => {
    close();
    if (isCtrlCmd(mods)) void openRecentRootInNewWindow(item.path, onMissing);
    else void openRecentRootOrNotify(item.path, setRoot, onMissing);
  };

  const { scrollRef, virtualItems, comboboxProps, listboxProps, getOptionProps } = usePickerList({
    idPrefix: 'open-recent',
    count: filtered.length,
    selectedIndex,
    rowHeight: 28,
    overscan: 12,
    moveSelection,
    clampSelection,
    onEnter: (index, e) => {
      const item = filtered[index];
      if (item) openItem(item, e);
    },
  });

  return (
    <div className="flex flex-col">
      <div className="border-b border-line p-2">
        <Input
          size="sm"
          // 初始焦点用 data-autofocus(同 Quick Open:Esc 关闭后焦点回到打开前的元素)
          data-autofocus
          aria-label={t('open_recent.input_aria')}
          {...comboboxProps}
          placeholder={t(detectPlatform() === 'mac' ? 'open_recent.placeholder_mac' : 'open_recent.placeholder')}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>
      <div ref={scrollRef} className="max-h-[min(420px,calc(100vh-8rem))] overflow-y-auto py-1">
        {filtered.length === 0 ? (
          <div role="status" className="px-3 py-4 text-center text-xs text-fg-dim">
            {items.length === 0 ? t('open_recent.empty') : t('open_recent.no_match')}
          </div>
        ) : (
          <ul {...listboxProps} aria-label={t('open_recent.list_aria')}>
            {virtualItems.map((vRow) => {
              const idx = vRow.index;
              const item = filtered[idx]!;
              const selected = idx === selectedIndex;
              return (
                <li
                  key={item.path}
                  {...getOptionProps(vRow)}
                  className={pickerRowClassName(selected)}
                  title={item.path}
                  aria-label={recentRootAccessibleName(item.path)}
                  onClick={(e) => openItem(item, e)}
                >
                  <span className="max-w-[60%] shrink-0 truncate font-medium">{item.name}</span>
                  {item.parent !== '' && (
                    <TruncateStart
                      text={item.parent}
                      title={item.path}
                      className={`min-w-0 flex-1 text-2xs ${pickerRowSecondaryClassName(selected)}`}
                    >
                      {item.parent}
                    </TruncateStart>
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
