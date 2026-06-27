import { useMemo } from 'react';
import { hasFiles } from '@/lib/window-drop'; // 边界(E225):共享早停 hasFiles
import type { ItemInstance } from '@headless-tree/core';
import type { FileEntry } from '@/lib/fs/types';
import { Input } from '@/design';
import { t } from '@/i18n';
import { FS_NAME_MAX } from '../../../electron/shared/leaf-name';
import { SR_ONLY_STYLE } from '@/lib/sr-only';
import {
  mergeDecorations,
  type DecoratorFn,
} from '@/plugins/registries/ExplorerDecoratorRegistry';
import { coApp } from '@/plugins/co-app';
import type { ExplorerContextMenuItemSpec } from '@/plugins/registries/ExplorerContextMenuRegistry';
import { ContextMenu, type ContextMenuActions } from './ContextMenu';
import { useExplorerClipboardStore } from './clipboard-store';
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
  /** 插件装饰器快照(FolderTree 一次订阅后下传,避免每行各自订阅). */
  decorators: readonly DecoratorFn[];
  /** 剪贴板是否非空(FolderTree 已订阅,下传避免每行各自订阅同一布尔值). */
  hasClipboard: boolean;
  /** 插件右键菜单项全量快照(FolderTree 一次订阅后下传,透传给本行 ContextMenu). */
  pluginMenuItems: readonly ExplorerContextMenuItemSpec[];
  /** 缩进宽度(explorer.indentSize 全树一致,FolderTree 一次订阅后下传). */
  indent: number;
}

const ICON_SIZE = 16;
// 28px 比 24 更松,Lokus / VSCode 同档(他们用 32);保持紧凑同时呼吸感更好
const ROW_HEIGHT = 28;
export const DEFAULT_INDENT = 16;
const FILE_ROW_BASE_CLASS_NAME =
  'flex items-center gap-1 text-xs select-none border-l-2';
const FILE_ROW_DROP_CLASS_NAME =
  'bg-accent/30 text-fg ring-1 ring-inset ring-accent/60';
const FILE_ROW_SELECTED_CLASS_NAME = 'bg-hover text-fg';
const FILE_ROW_IDLE_CLASS_NAME = 'text-fg-muted hover:bg-panel-soft';

export interface FileRowClassNameState {
  readonly isFocused: boolean;
  readonly isSelected: boolean;
  readonly isDropTarget: boolean;
  readonly isCutMarked: boolean;
}

export function fileRowClassName({
  isFocused,
  isSelected,
  isDropTarget,
  isCutMarked,
}: FileRowClassNameState): string {
  const focusClass = isFocused ? 'border-accent' : 'border-transparent';
  const stateClass = isDropTarget
    ? FILE_ROW_DROP_CLASS_NAME
    : isSelected
      ? FILE_ROW_SELECTED_CLASS_NAME
      : FILE_ROW_IDLE_CLASS_NAME;
  const base = `${FILE_ROW_BASE_CLASS_NAME} ${focusClass} ${stateClass}`;
  return isCutMarked ? `${base} opacity-50` : base;
}

/**
 * 由 FolderTree 一次订阅的装饰器快照(打磨 R7)合成本行装饰。原先每个可见
 * FileRow 各自 useRegistry(explorerDecorators) → 虚拟列表 N 行 = N 份订阅 +
 * 插件启停时每行各取一次 getAll();现在订阅上提到 FolderTree,本行只 memo 合成。
 */
function useDecoration(
  path: string,
  isDirectory: boolean,
  decorators: readonly DecoratorFn[],
) {
  // race(R57,R55/R56 同族):memo 仍以 props 的 decorators 快照作**失效键**(R7:订阅集中在
  // FolderTree,其快照引用在插件启停时变化 → 驱动本 memo 重算,保持原有重算频率/性能);但真正
  // 合并时读 **live** coApp.explorerDecorators.getAll()(this.fns.slice() 即时反映 unregister)。
  // decorator 是裸函数无 id;useRegistry 快照(useState 订阅)滞后 registry 一帧,若直接合并快照,
  // 在滞后窗口内因 path/isDirectory 变化触发的重算会执行已移除 decorator(虚拟树渲染热路径,访问
  // 已释放资源 / 加陈旧 badge)。读 live 列表 → 已移除函数不再被调。
  return useMemo(
    () => {
      void decorators; // 失效键(见上);执行用 live 列表。
      return mergeDecorations(
        { path, isDirectory },
        coApp.explorerDecorators.getAll(),
      );
    },
    [path, isDirectory, decorators],
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
  decorators,
  hasClipboard,
  pluginMenuItems,
  indent,
}: FileRowProps) {
  const data = item.getItemData();
  const isDir = item.isFolder();
  const isSelected = item.isSelected();
  const isFocused = item.isFocused();
  const isExpanded = isDir && item.isExpanded();
  const isLoading = item.isLoading();
  const isRenaming = item.isRenaming();
  const level = item.getItemMeta().level;
  const decoration = useDecoration(data.path, isDir, decorators);
  // VSCode 同款:已剪切的项目灰显,提示「等待粘贴」;copy 不灰
  const isCutMarked = useExplorerClipboardStore(
    (s) => s.kind === 'cut' && s.paths.includes(data.path),
  );
  // headless-tree 内部 drag 时,drop 目标行高亮(drag preview 可能遮挡视线,
  // 没有这个 hover 反馈用户看不清要 drop 到哪)。
  const isInternalDropOver = item.isDraggingOver();

  const row = (
    <div
      {...item.getProps()}
      // a11y(A110):目录加载子项时 treeitem 标 aria-busy,AT 知该行正在加载(配下方 sr-only 文本)。
      aria-busy={isLoading || undefined}
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
        if (!hasFiles(e.dataTransfer)) return;
        // 文件夹 → 自身;文件 → 父目录(由 resolveDropTarget 算)
        onHoverDropTarget?.({ path: data.path, isDirectory: isDir });
      }}
      style={{
        ...style,
        height: ROW_HEIGHT,
        paddingLeft: 4 + level * indent,
        // 缩进指南线用 CSS gradient 一笔画 N 条,替代之前每行 N 个 absolute span:
        // 起点 = padding(4) + indent/2 ; 周期 indent ; 1px 线宽。
        // background-size 限定为 level*indent,no-repeat 防止画到内容区。
        backgroundImage: level > 0
          ? `repeating-linear-gradient(to right, var(--color-line) 0 1px, transparent 1px ${indent}px)`
          : undefined,
        backgroundPosition: level > 0 ? `${4 + indent / 2}px 0` : undefined,
        backgroundSize: level > 0 ? `${level * indent}px 100%` : undefined,
        backgroundRepeat: level > 0 ? 'no-repeat' : undefined,
      }}
      className={fileRowClassName({
        isFocused,
        isSelected,
        isDropTarget: isDropHover || isInternalDropOver,
        isCutMarked,
      })}
      title={
        decoration?.tooltip
          ? `${data.path} · ${decoration.tooltip}`
          : data.path
      }
    >
      {/* a11y(A71,A70 同族装饰符号):treeitem 展开态由 headless-tree row props 的 aria-expanded
          表达,视觉箭头 ▾/▸ 纯装饰 → aria-hidden,否则混进行可访问名,SR 读文件名时夹杂三角噪声。 */}
      <span
        className="inline-flex w-3 shrink-0 items-center justify-center text-2xs text-fg-dim"
        aria-hidden="true"
      >
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
          // a11y(A26,A5 同族):headless-tree getRenameInputProps() 不含 aria-label → 重命名
          // 编辑框无可访问名。补 aria-label(含文件名),屏幕阅读器知在重命名哪个文件。
          aria-label={t('panels.explorer.rename_input_aria', { name: data.name })}
          // 边界(E290,CreateInput leaf 名截断兄弟):重命名输入原生 maxLength 截断到 FS_NAME_MAX,
          // 防超长 paste 跨 IPC 到 main 才被 assertValidBasename 拒(>FS_NAME_MAX 名 ENAMETOOLONG 建不出)。
          maxLength={FS_NAME_MAX}
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
        // a11y(A109):去掉硬编码英文 aria-label(`badge ${x}` 覆盖可见文本且 zh/ko 读英文「badge」)
        // → 让可见 badge 文本自然进入 treeitem 朗读路径(badge 语义由插件决定,无通用本地化)。
        <span
          className="ml-auto pr-2 text-2xs tabular-nums"
          style={decoration.badgeColor ? { color: decoration.badgeColor } : undefined}
        >
          {decoration.badge}
        </span>
      )}
      {isLoading && (
        // a11y(A110):视觉 … 纯装饰 aria-hidden;加载语义由 aria-busy(根)+ 视觉隐藏「加载中」表达。
        <span className="ml-auto pr-2 text-2xs text-fg-dim">
          <span aria-hidden="true">…</span>
          <span style={SR_ONLY_STYLE}>{t('common.loading')}</span>
        </span>
      )}
    </div>
  );

  return (
    <ContextMenu
      target={data}
      selectedPaths={selectedPaths}
      rootPath={rootPath}
      actions={contextActions}
      hasClipboard={hasClipboard}
      pluginItems={pluginMenuItems}
    >
      {row}
    </ContextMenu>
  );
}

export const FILE_ROW_HEIGHT = ROW_HEIGHT;
