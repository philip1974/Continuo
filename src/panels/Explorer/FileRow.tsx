import { Document, Folder } from '@react-symbols/icons';
import type { ItemInstance } from '@headless-tree/core';
import type { FileEntry } from '@/lib/fs/types';
import { ContextMenu, type ContextMenuActions } from './ContextMenu';
import { RenameInput } from './RenameInput';

interface FileRowProps {
  item: ItemInstance<FileEntry>;
  /** react-virtual 提供的绝对定位 transform 等 style. */
  style: React.CSSProperties;
  selectedPaths: ReadonlySet<string>;
  rootPath: string;
  contextActions: ContextMenuActions;
  /** 当前正在 rename 的 path;非 null 且 === item.path 则显示 RenameInput */
  renamingPath: string | null;
  onRenameSubmit: (path: string, newName: string) => void;
  onRenameCancel: () => void;
}

const ICON_SIZE = 16;
const ROW_HEIGHT = 24;
const INDENT = 16;

// 单行节点。缩进 = level * 16,左侧箭头(目录) + 类型图标 + 名称。
// 右键菜单挂在整行;rename 模式下名称区替换成 RenameInput。
export function FileRow({
  item,
  style,
  selectedPaths,
  rootPath,
  contextActions,
  renamingPath,
  onRenameSubmit,
  onRenameCancel,
}: FileRowProps) {
  const data = item.getItemData();
  const isDir = item.isFolder();
  const isSelected = item.isSelected();
  const isFocused = item.isFocused();
  const isExpanded = isDir && item.isExpanded();
  const isLoading = item.isLoading();
  const isRenaming = renamingPath === data.path;
  const level = item.getItemMeta().level;

  const row = (
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
      {isRenaming ? (
        <RenameInput
          initialName={data.name}
          onSubmit={(newName) => onRenameSubmit(data.path, newName)}
          onCancel={onRenameCancel}
        />
      ) : (
        <span className="truncate">{data.name}</span>
      )}
      {isLoading && (
        <span className="ml-auto pr-2 text-[10px] text-neutral-600">…</span>
      )}
    </div>
  );

  return (
    <ContextMenu
      target={data}
      selectedPaths={selectedPaths}
      rootPath={rootPath}
      actions={contextActions}
    >
      {row}
    </ContextMenu>
  );
}

export const FILE_ROW_HEIGHT = ROW_HEIGHT;
