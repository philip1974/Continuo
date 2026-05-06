import { useEffect, useMemo, useState } from 'react';
import type { ItemInstance } from '@headless-tree/core';
import type { FileEntry } from '@/lib/fs/types';
import { Input } from '@/design';
import { coApp } from '@/plugins/co-app';
import { mergeDecorations } from '@/plugins/registries/ExplorerDecoratorRegistry';
import { ContextMenu, type ContextMenuActions } from './ContextMenu';
import type { DropTargetEntry } from './drop-handlers';
import { FileIcon } from './file-icon';

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
// 28px 比 24 更松,Lokus / VSCode 同档(他们用 32);保持紧凑同时呼吸感更好
const ROW_HEIGHT = 28;
const INDENT = 16;

/** 订阅插件装饰器 registry,plugin enable/disable 时所有 FileRow 自动重渲. */
function useDecoration(path: string, isDirectory: boolean) {
  const [snap, setSnap] = useState(() => coApp.explorerDecorators.getAll());
  useEffect(
    () =>
      coApp.explorerDecorators.subscribe(() =>
        setSnap(coApp.explorerDecorators.getAll()),
      ),
    [],
  );
  return useMemo(
    () => mergeDecorations({ path, isDirectory }, snap),
    [path, isDirectory, snap],
  );
}

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
  const decoration = useDecoration(data.path, isDir);

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
        // 缩进指南线用 CSS gradient 一笔画 N 条,替代之前每行 N 个 absolute span:
        // 起点 12px = padding(4) + i=0 + 8(中线) ; 周期 INDENT=16px ; 1px 线宽。
        // background-size 限定为 level*INDENT,no-repeat 防止画到内容区。
        ...(level > 0 && {
          backgroundImage: `repeating-linear-gradient(to right, var(--color-line) 0 1px, transparent 1px ${INDENT}px)`,
          backgroundPosition: '12px 0',
          backgroundSize: `${level * INDENT}px 100%`,
          backgroundRepeat: 'no-repeat',
        }),
      }}
      className={[
        'flex items-center gap-1 text-xs select-none',
        'border-l-2',
        isFocused ? 'border-accent' : 'border-transparent',
        isDropHover
          ? 'bg-accent/20 text-fg'
          : isSelected
            ? 'bg-hover text-fg'
            : 'text-fg-muted hover:bg-panel-soft',
      ].join(' ')}
      title={
        decoration?.tooltip
          ? `${data.path} · ${decoration.tooltip}`
          : data.path
      }
    >
      <span className="inline-flex w-3 shrink-0 items-center justify-center text-[10px] text-fg-dim">
        {isDir ? (isExpanded ? '▾' : '▸') : ''}
      </span>
      <span className="inline-flex shrink-0 items-center" aria-hidden="true">
        {/* V2:plugin 通过 ExplorerDecoratorRegistry 贡献的 icon 替换默认.
         *  decoration.icon 为 undefined 时 fallback 到 ext 映射的 FileIcon. */}
        {decoration?.icon ?? (
          <FileIcon name={data.name} isDirectory={isDir} size={ICON_SIZE} />
        )}
      </span>
      {isRenaming ? (
        <Input
          {...item.getRenameInputProps()}
          size="xs"
          ref={(el: HTMLInputElement | null) => {
            if (el) requestAnimationFrame(() => el.focus());
          }}
          className="w-full"
          spellCheck={false}
          autoComplete="off"
        />
      ) : (
        <span
          className="truncate"
          style={decoration?.textColor ? { color: decoration.textColor } : undefined}
        >
          {data.name}
        </span>
      )}
      {/* 插件装饰 badge(右侧),loading 优先级更高,加载完才显 */}
      {!isLoading && decoration?.badge && (
        <span
          className="ml-auto pr-2 text-[10px] tabular-nums"
          style={decoration.badgeColor ? { color: decoration.badgeColor } : undefined}
          aria-label={`badge ${decoration.badge}`}
        >
          {decoration.badge}
        </span>
      )}
      {isLoading && (
        <span className="ml-auto pr-2 text-[10px] text-fg-dim">…</span>
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
