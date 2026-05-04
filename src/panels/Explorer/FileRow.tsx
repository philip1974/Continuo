import { Document, Folder } from '@react-symbols/icons';
import type { ItemInstance } from '@headless-tree/core';
import type { FileEntry } from '@/lib/fs/types';

interface FileRowProps {
  item: ItemInstance<FileEntry>;
  /** react-virtual 提供的绝对定位 transform 等 style. */
  style: React.CSSProperties;
}

const ICON_SIZE = 16;
const ROW_HEIGHT = 24;
const INDENT = 16;

// 单行节点。缩进 = level * 16,左侧箭头(目录) + 类型图标 + 名称。
// 选中态用 bg-neutral-800,焦点用 border-l 标记(简单起见,无 outline)。
export function FileRow({ item, style }: FileRowProps) {
  const data = item.getItemData();
  const isDir = item.isFolder();
  const isSelected = item.isSelected();
  const isFocused = item.isFocused();
  const isExpanded = isDir && item.isExpanded();
  const isLoading = item.isLoading();
  const level = item.getItemMeta().level;

  return (
    <div
      {...item.getProps()}
      style={{
        ...style,
        height: ROW_HEIGHT,
        paddingLeft: 4 + level * INDENT,
      }}
      className={[
        'flex items-center gap-1 text-xs select-none',
        'border-l-2',
        isFocused ? 'border-sky-500' : 'border-transparent',
        isSelected
          ? 'bg-neutral-800 text-neutral-100'
          : 'text-neutral-400 hover:bg-neutral-900',
      ].join(' ')}
      title={data.path}
    >
      <span className="inline-flex w-3 shrink-0 items-center justify-center text-[10px] text-neutral-500">
        {isDir ? (isExpanded ? '▾' : '▸') : ''}
      </span>
      <span className="inline-flex shrink-0 items-center" aria-hidden="true">
        {isDir ? (
          <Folder width={ICON_SIZE} height={ICON_SIZE} />
        ) : (
          <Document width={ICON_SIZE} height={ICON_SIZE} />
        )}
      </span>
      <span className="truncate">{data.name}</span>
      {isLoading && <span className="ml-auto pr-2 text-[10px] text-neutral-600">…</span>}
    </div>
  );
}

export const FILE_ROW_HEIGHT = ROW_HEIGHT;
