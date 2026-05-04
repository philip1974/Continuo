import { Document, Folder } from '@react-symbols/icons';
import type { ItemInstance } from '@headless-tree/core';
import type { FileEntry } from '@/lib/fs/types';
import { ContextMenu, type ContextMenuActions } from './ContextMenu';
import type { DropTargetEntry } from './drop-handlers';

interface FileRowProps {
  item: ItemInstance<FileEntry>;
  /** react-virtual 提供的绝对定位 transform 等 style. */
  style: React.CSSProperties;
  selectedPaths: ReadonlySet<string>;
  rootPath: string;
  contextActions: ContextMenuActions;
  /** dnd:鼠标拖入此行时回报本 entry,供 FolderTree 计算落点. */
  onHoverDropTarget?: (target: DropTargetEntry | null) => void;
  /** dnd:此行是当前 hover 落点时高亮. */
  isDropHover?: boolean;
  /** 单击文件触发(目录的展开仍由 headless-tree mousedown 接管). */
  onFileOpen?: (path: string) => void;
}

const ICON_SIZE = 16;
const ROW_HEIGHT = 24;
const INDENT = 16;

// 单行节点。renamingFeature 自动接管 input 的 Enter/Esc 键盘事件,
// 我们只需在 isRenaming() 时把 name 区域换成 input 即可。
export function FileRow({
  item,
  style,
  selectedPaths,
  rootPath,
  contextActions,
  onHoverDropTarget,
  isDropHover = false,
  onFileOpen,
}: FileRowProps) {
  const data = item.getItemData();
  const isDir = item.isFolder();
  const isSelected = item.isSelected();
  const isFocused = item.isFocused();
  const isExpanded = isDir && item.isExpanded();
  const isLoading = item.isLoading();
  const isRenaming = item.isRenaming();
  const level = item.getItemMeta().level;

  const row = (
    <div
      {...item.getProps()}
      onClick={(e) => {
        // 上游 selectionFeature 用 mousedown,onClick 不冲突
        const upstream = (item.getProps() as { onClick?: (e: React.MouseEvent) => void })
          .onClick;
        upstream?.(e);
        // 单击文件 → 通知 FolderTree 触发 Editor 打开;
        // 单击目录由 headless-tree 默认行为处理(展开/折叠)
        if (!isDir && !isRenaming) {
          onFileOpen?.(data.path);
        }
      }}
      onDragEnter={(e) => {
        if (!e.dataTransfer.types.includes('Files')) return;
        // 文件夹 → 自身;文件 → 父目录(由 resolveDropTarget 算)
        onHoverDropTarget?.({ path: data.path, isDirectory: isDir });
      }}
      style={{
        ...style,
        height: ROW_HEIGHT,
        paddingLeft: 4 + level * INDENT,
      }}
      className={[
        'flex items-center gap-1 text-xs select-none',
        'border-l-2',
        isFocused ? 'border-sky-500' : 'border-transparent',
        isDropHover
          ? 'bg-sky-900/40 text-neutral-100'
          : isSelected
            ? 'bg-neutral-800 text-neutral-100'
            : 'text-neutral-400 hover:bg-neutral-900',
      ].join(' ')}
      title={data.path}
    >
      {/* 缩进指南线:每层 1px 灰竖线,辅助识别深层嵌套(VSCode 同款) */}
      {Array.from({ length: level }).map((_, i) => (
        <span
          key={i}
          aria-hidden="true"
          className="pointer-events-none absolute top-0 bottom-0 w-px bg-neutral-800"
          style={{ left: 4 + i * INDENT + 8 }}
        />
      ))}
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
        <input
          {...item.getRenameInputProps()}
          // 覆盖上游 ref(原本只是 r => r?.focus(),sync 调用会被 Radix Menu
          // close 后的 focus restore 抢回去)→ 改用 requestAnimationFrame 延迟一帧
          ref={(el) => {
            if (el) requestAnimationFrame(() => el.focus());
          }}
          className="w-full rounded bg-neutral-800 px-1 py-0 text-xs text-neutral-100 outline-none ring-1 ring-sky-500"
          spellCheck={false}
          autoComplete="off"
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
