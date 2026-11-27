import { memo, useCallback, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { hasFiles } from '@/lib/window-drop'; // 边界(E225):共享早停 hasFiles
import type { ItemInstance, TreeInstance } from '@headless-tree/core';
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
import { PluginRenderBoundary } from '@/plugins/PluginRenderBoundary';
import type { ExplorerContextMenuItemSpec } from '@/plugins/registries/ExplorerContextMenuRegistry';
import { ContextMenu, type ContextMenuActions } from './ContextMenu';
import { clipboardPathSet, useExplorerClipboardStore } from './clipboard-store';
import type { DropTargetEntry } from './drop-handlers';
import { FileIcon } from './file-icon';
import { renameStemEnd, type RenameInputError } from './path-utils';
import { finishRenamingOnBlur, renameErrorFor } from './tree-config';
import { GIT_KIND_LABEL_KEY, GIT_KIND_TEXT_CLASS } from './git-decorations';
import type { GitStatusKind } from '../../../electron/shared/git-status';

/**
 * 行状态快照(perf):由 FolderTree 在渲染期从 item 读出后作为 primitive 下传。FileRow 是 memo 组件,
 * 而 headless-tree 的 item 实例按 id 缓存、引用恒定 —— 若行内直接读 item.isSelected() 等,memo 浅比较
 * 看不到状态变化。凡影响本行渲染(含 item.getProps() 产出的 aria-* / tabIndex / draggable)的状态都必须
 * 列在这里,否则 memo 会让行停在旧状态。
 */
export interface FileRowState {
  /** item.getItemData():数据刷新(listDir 失效重载)时换新对象。 */
  data: FileEntry;
  isDir: boolean;
  isSelected: boolean;
  isFocused: boolean;
  isExpanded: boolean;
  isLoading: boolean;
  isRenaming: boolean;
  /** 仅重命名中的行有值(受控 input 的 value);其它行恒 undefined,输入时不牵动它们。 */
  renamingValue: string | undefined;
  level: number;
  /** aria-posinset / aria-setsize(getProps 产出,兄弟增删时变化)。 */
  posInSet: number;
  setSize: number;
  /** headless-tree 内部 drag 的 hover 落点。 */
  isDraggingOver: boolean;
}

/**
 * 从 headless-tree item 读出 FileRow 渲染所需的全部状态(perf:FileRow 是 memo 组件,item 实例按 id
 * 缓存、引用恒定,状态必须以 primitive 下传才能被 memo 浅比较看见)。字段清单见 FileRowState。
 */
export function readFileRowState(
  item: ItemInstance<FileEntry>,
  tree: Pick<TreeInstance<FileEntry>, 'getRenamingValue'>,
): FileRowState {
  const isDir = item.isFolder();
  const isRenaming = item.isRenaming();
  const meta = item.getItemMeta();
  return {
    data: item.getItemData(),
    isDir,
    isSelected: item.isSelected(),
    isFocused: item.isFocused(),
    isExpanded: isDir && item.isExpanded(),
    isLoading: item.isLoading(),
    isRenaming,
    renamingValue: isRenaming ? tree.getRenamingValue() : undefined,
    level: meta.level,
    posInSet: meta.posInSet,
    setSize: meta.setSize,
    isDraggingOver: item.isDraggingOver(),
  };
}

interface FileRowProps extends FileRowState {
  item: ItemInstance<FileEntry>;
  /** react-virtual 行起点(px);绝对定位 style 在行内构造,避免每次父渲染新建 style 对象击穿 memo. */
  start: number;
  /**
   * 当前选中集合(稳定引用的读取函数)。只在打开本行右键菜单时读取一次作快照:选中随方向键高频变化,
   * 若作为 prop 直接下传,每次选中变化都会击穿全部可见行的 memo(perf)。
   */
  getSelectedPaths: () => ReadonlySet<string>;
  rootPath: string;
  contextActions: ContextMenuActions;
  /** dnd:鼠标拖入此行时回报本 entry,供 FolderTree 计算落点. */
  onHoverDropTarget?: (target: DropTargetEntry | null) => void;
  /** dnd:此行是当前 hover 落点时高亮. */
  isDropHover?: boolean;
  /**
   * 单击 / 双击文件触发(目录的展开仍由 headless-tree mousedown 接管)。focusEditor:双击(click.detail ≥ 2)——
   * VSCode 单击预览、焦点留在树里;双击打开后焦点交给编辑器。toSide:按住 ⌥(Alt)单击 = 在侧边打开(VSCode 列表多选键为
   * ⌘ / Ctrl 时 Alt 单击即 sideBySide;BDD: src/__tests__/explorer-open-to-side/)。
   */
  onFileOpen?: (path: string, focusEditor: boolean, toSide: boolean) => void;
  /** perf:文件行 pointerdown(早于 click)预热打开所需资源,如编辑引擎 chunk。 */
  onFileIntent?: (path: string) => void;
  /** 插件装饰器快照(FolderTree 一次订阅后下传,避免每行各自订阅). */
  decorators: readonly DecoratorFn[];
  /** 剪贴板是否非空(FolderTree 已订阅,下传避免每行各自订阅同一布尔值). */
  hasClipboard: boolean;
  /** 插件右键菜单项全量快照(FolderTree 一次订阅后下传,透传给本行 ContextMenu). */
  pluginMenuItems: readonly ExplorerContextMenuItemSpec[];
  /** 缩进宽度(explorer.indentSize 全树一致,FolderTree 一次订阅后下传). */
  indent: number;
  /**
   * git 状态装饰(FolderTree 按 git 快照 + explorer.decorations.* 设置算好后以 primitive 下传,不击穿 memo)。
   * gitKind:无装饰 / 两项设置都关 → undefined;gitColor:名称是否着色(decorations.colors);
   * gitLetter:右侧徽标字母(decorations.badges 关、文件夹、忽略项 → 空串)。BDD: src/__tests__/explorer-git-decorations/
   */
  gitKind?: GitStatusKind;
  gitColor?: boolean;
  gitLetter?: string;
}

const ICON_SIZE = 16;
// 28px 比 24 更松,Lokus / VSCode 同档(他们用 32);保持紧凑同时呼吸感更好
const ROW_HEIGHT = 28;
// 键盘焦点:去掉浏览器默认焦点环(macOS 为系统强调色框),:focus-visible 时画 1px 内嵌 focus-ring 轮廓
// (设计系统焦点色 --md-focus-ring;内嵌避免被滚动容器裁掉)。树焦点行另有左侧 accent 指示(isFocused)。
const FILE_ROW_BASE_CLASS_NAME =
  'flex items-center gap-1 text-xs select-none border-l-2 outline-none focus-visible:outline-solid focus-visible:outline-1 focus-visible:-outline-offset-1 focus-visible:outline-focus-ring';
const FILE_ROW_DROP_CLASS_NAME =
  'bg-accent/30 text-fg ring-1 ring-inset ring-accent/60';
const FILE_ROW_SELECTED_CLASS_NAME = 'bg-hover text-fg';
const FILE_ROW_IDLE_CLASS_NAME = 'text-fg-muted hover:bg-panel-soft';

/** 行悬浮提示:路径 [· 符号链接] [· git 状态] [· 插件装饰提示]。 */
function rowTitle(data: FileEntry, tooltip: string | undefined, gitLabel: string | undefined): string {
  let title = data.path;
  if (data.isSymlink) title += ` · ${t('panels.explorer.symlink')}`;
  if (gitLabel) title += ` · ${gitLabel}`;
  if (tooltip) title += ` · ${tooltip}`;
  return title;
}

/** 重命名校验错误的提示文案(VSCode validateFileName 同义)。 */
function renameErrorMessage(error: RenameInputError): string {
  if (error.kind === 'empty') return t('panels.explorer.rename_empty');
  if (error.kind === 'exists') return t('panels.explorer.rename_exists', { name: error.name });
  return t('panels.explorer.rename_invalid', { name: error.name });
}

/** 最近的会裁剪内容的祖先(overflow-y 非 visible,即 Explorer 的滚动区)。 */
function clippingAncestor(el: HTMLElement): HTMLElement | null {
  for (let p = el.parentElement; p; p = p.parentElement) {
    if (getComputedStyle(p).overflowY !== 'visible') return p;
  }
  return null;
}

/**
 * 重命名校验提示(VSCode 同款:紧贴输入框下方、覆盖下一行,不挤动虚拟列表)。对齐 VSCode InputBox:渲染后测量,下方到
 * 滚动区底边放不下、且上方更宽裕 → 翻到输入框上方(滚动到最后一行重命名时提示不被裁掉)。role=alert 让读屏即时播报。
 */
function RenameErrorHint({ id, message }: { readonly id: string; readonly message: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [above, setAbove] = useState(false);
  useLayoutEffect(() => {
    const el = ref.current;
    const anchor = el?.parentElement;
    const scroller = el ? clippingAncestor(el) : null;
    if (!el || !anchor || !scroller) return;
    const box = scroller.getBoundingClientRect();
    const at = anchor.getBoundingClientRect();
    const below = box.bottom - at.bottom;
    setAbove(below < el.getBoundingClientRect().height && at.top - box.top > below);
  }, [message]);
  return (
    <div
      ref={ref}
      id={id}
      role="alert"
      className={`absolute left-0 right-0 ${above ? 'bottom-full' : 'top-full'} z-10 whitespace-normal break-words border border-error bg-panel px-1.5 py-1 text-2xs text-error`}
    >
      {message}
    </div>
  );
}

/** 多选修饰键(⌘ / Ctrl / Shift):与 headless-tree selectionFeature 判定多选的键一致。 */
function hasSelectionModifier(e: { metaKey: boolean; ctrlKey: boolean; shiftKey: boolean }): boolean {
  return e.metaKey || e.ctrlKey || e.shiftKey;
}

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
//
// perf:memo —— 滚动时 virtualizer 每跨一行经 flushSync 同步重渲 FolderTree,未进出视口的行
// props 全不变(状态 primitive + start + 父级稳定引用的回调/快照)→ 跳过整行(含 Radix ContextMenu)。
export const FileRow = memo(function FileRow({
  item,
  start,
  data,
  isDir,
  isSelected,
  isFocused,
  isExpanded,
  isLoading,
  isRenaming,
  renamingValue,
  level,
  isDraggingOver: isInternalDropOver,
  getSelectedPaths,
  rootPath,
  contextActions,
  onHoverDropTarget,
  isDropHover = false,
  onFileOpen,
  onFileIntent,
  decorators,
  hasClipboard,
  pluginMenuItems,
  indent,
  gitKind,
  gitColor = false,
  gitLetter = '',
}: FileRowProps) {
  // posInSet / setSize 不在此解构:它们只作 memo 失效键 —— 行内 item.getProps() 现取 aria-posinset/setsize,
  // 这些 props 变化时本行必重渲,现取值与 props 一致(见 FileRowState)。renamingValue 用于输入时校验。
  const decoration = useDecoration(data.path, isDir, decorators);
  // VSCode 同款:已剪切的项目灰显,提示「等待粘贴」;copy 不灰
  const isCutMarked = useExplorerClipboardStore(
    (s) => s.kind === 'cut' && clipboardPathSet(s.paths).has(data.path),
  );
  // headless-tree 内部 drag 时,drop 目标行高亮(isDraggingOver):drag preview 可能遮挡视线,
  // 没有这个 hover 反馈用户看不清要 drop 到哪。
  // 右键菜单用的选中快照:contextmenu 事件(鼠标右键 / 键盘菜单键)里读取;与 Radix 打开菜单的 setState
  // 同批提交,菜单内容首帧即用到最新选中。
  const [menuSelectedPaths, setMenuSelectedPaths] = useState<ReadonlySet<string>>(getSelectedPaths);
  // 重命名输入框挂载时聚焦并预选主名(VSCode:文件不含扩展名,目录 / 无扩展名全选)。稳定回调:内联 ref
  // 每次渲染(每次键入)都会重调,把用户的光标 / 选区打回预选。下一帧再聚焦:让 Radix 右键菜单的焦点还原先跑完。
  const name = data.name;
  const renameInputRef = useCallback(
    (el: HTMLInputElement | null) => {
      if (!el) return;
      requestAnimationFrame(() => {
        el.focus();
        el.setSelectionRange(0, renameStemEnd(name, isDir));
      });
    },
    [name, isDir],
  );

  // 重命名输入时校验(VSCode:空名 / 同目录重名 / 非法名即时在输入框下方提示,Enter 不提交;见 tree-config)。
  const renameError =
    isRenaming && renamingValue !== undefined ? renameErrorFor(item, renamingValue) : null;
  const renameErrorId = useId();
  // git 状态文案:悬浮提示 + 读屏(VSCode 装饰 tooltip「Modified」等)。只给文件:文件夹继承的颜色只是「含变更」提示,
  // 忽略项 VSCode 也不带提示。
  const gitLabel = gitKind !== undefined && !isDir && gitKind !== 'ignored' ? t(GIT_KIND_LABEL_KEY[gitKind]) : undefined;

  const row = (
    <div
      {...item.getProps()}
      // a11y(A110):目录加载子项时 treeitem 标 aria-busy,AT 知该行正在加载(配下方 sr-only 文本)。
      aria-busy={isLoading || undefined}
      onPointerDown={(e) => {
        // 保留上游可能注入的 pointerdown(当前 headless-tree 未注入,防御升级)
        (item.getProps() as { onPointerDown?: (e: React.PointerEvent) => void }).onPointerDown?.(e);
        // 仅主键且无 Ctrl:右键 / macOS Ctrl+点击打开上下文菜单而非文件,不预热(⌘ / Shift 多选单击
        // 不打开文件,仅多一次无害的预热)。
        if (e.button === 0 && !e.ctrlKey && !isDir && !isRenaming) onFileIntent?.(data.path);
      }}
      onClick={(e) => {
        // 上游 selectionFeature 用 mousedown,onClick 不冲突
        const upstream = (item.getProps() as { onClick?: (e: React.MouseEvent) => void })
          .onClick;
        upstream?.(e);
        // 单击文件 → 通知 FolderTree 触发 Editor 打开;
        // 单击目录由 headless-tree 默认行为处理(展开/折叠)。
        // 带 ⌘ / Ctrl / Shift 的单击是多选(selectionFeature 已改选中),只改选中不打开(VSCode 同款)。
        if (!isDir && !isRenaming && !hasSelectionModifier(e)) {
          onFileOpen?.(data.path, e.detail >= 2, e.altKey);
        }
      }}
      onContextMenu={() => {
        setMenuSelectedPaths(getSelectedPaths());
        // VSCode 同款:右键把列表焦点移到该行(选中不变)。菜单操作结束后(如取消删除确认)焦点据此回到这一行。
        item.setFocused();
      }}
      onDragEnter={(e) => {
        if (!hasFiles(e.dataTransfer)) return;
        // 文件夹 → 自身;文件 → 父目录(由 resolveDropTarget 算)
        onHoverDropTarget?.({ path: data.path, isDirectory: isDir });
      }}
      style={{
        position: 'absolute',
        top: 0,
        left: 0,
        width: '100%',
        transform: `translateY(${start}px)`,
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
        // 重命名的错误提示浮在下一行之上:行有 transform(各自层叠上下文),须抬高本行。
        zIndex: renameError ? 1 : undefined,
      }}
      className={fileRowClassName({
        isFocused,
        isSelected,
        isDropTarget: isDropHover || isInternalDropOver,
        isCutMarked,
      })}
      title={rowTitle(data, decoration?.tooltip, gitLabel)}
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
        {decoration?.icon != null && decoration.iconSource ? (
          // 插件图标渲染抛错只替换成错误图标(BDD: plugin-render-isolation)。
          <PluginRenderBoundary owner={decoration.iconSource} variant="inline">
            {decoration.icon}
          </PluginRenderBoundary>
        ) : (
          <FileIcon name={data.name} isDirectory={isDir} size={ICON_SIZE} />
        )}
      </span>
      {isRenaming ? (
        <div className="relative w-full min-w-0">
        <Input
          {...item.getRenameInputProps()}
          // a11y(A26,A5 同族):headless-tree getRenameInputProps() 不含 aria-label → 重命名
          // 编辑框无可访问名。补 aria-label(含文件名),屏幕阅读器知在重命名哪个文件。
          aria-label={t('panels.explorer.rename_input_aria', { name: data.name })}
          // 边界(E290,CreateInput leaf 名截断兄弟):重命名输入原生 maxLength 截断到 FS_NAME_MAX,
          // 防超长 paste 跨 IPC 到 main 才失败(>FS_NAME_MAX 的名文件系统 ENAMETOOLONG 建不出)。
          maxLength={FS_NAME_MAX}
          size="xs"
          ref={renameInputRef}
          // 失焦 = 提交(VSCode 同款);库默认 onBlur 是放弃,改名到一半点别处会丢输入。Enter / Esc 已结束重命名时
          // renamingItem 已清空,其后的失焦不再提交。不调库的 completeRenaming:它随后 updateDomFocus 会把焦点
          // 从用户刚点的地方(编辑器等)拉回树行;这里只做它的提交与退出两步。
          // 输入无效时失焦 = 放弃(VSCode),见 finishRenamingOnBlur。
          onBlur={() => {
            const tree = item.getTree();
            if (tree.getState().renamingItem !== item.getId()) return;
            finishRenamingOnBlur(tree);
          }}
          className="w-full"
          spellCheck={false}
          autoComplete="off"
          aria-invalid={renameError ? true : undefined}
          aria-describedby={renameError ? renameErrorId : undefined}
        />
        {renameError && <RenameErrorHint id={renameErrorId} message={renameErrorMessage(renameError)} />}
        </div>
      ) : (
        <span
          className={gitKind !== undefined && gitColor ? `truncate ${GIT_KIND_TEXT_CLASS[gitKind]}` : 'truncate'}
          style={decoration?.textColor ? { color: decoration.textColor } : undefined}
        >
          {data.name}
        </span>
      )}
      {/* 读屏:git 状态进 treeitem 朗读(「a.ts, 已修改」);视觉上由颜色 / 徽标表达 */}
      {gitLabel && <span style={SR_ONLY_STYLE}>{`, ${gitLabel}`}</span>}
      {data.isSymlink && (
        // VSCode 同款:符号链接行名称后带链接角标(↪,目录链接可展开、文件 / 悬空链接按文件)。视觉符号
        // aria-hidden,读屏读视觉隐藏的「符号链接」。
        <span className="shrink-0 text-2xs text-fg-dim">
          {/* U+FE0E:强制文本字形,否则 macOS 把 ↪ 渲染成彩色 emoji 方块 */}
          <span aria-hidden="true">{'\u21AA\uFE0E'}</span>
          <span style={SR_ONLY_STYLE}>{t('panels.explorer.symlink')}</span>
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
      {/* git 状态徽标字母(VSCode 同款,与名称同色);视觉符号 aria-hidden,语义见上方读屏文案 */}
      {!isLoading && gitKind !== undefined && gitLetter !== '' && (
        <span
          aria-hidden="true"
          className={`${decoration?.badge ? '' : 'ml-auto '}shrink-0 pr-2 font-medium ${GIT_KIND_TEXT_CLASS[gitKind]}`}
        >
          {gitLetter}
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
      selectedPaths={menuSelectedPaths}
      rootPath={rootPath}
      actions={contextActions}
      hasClipboard={hasClipboard}
      pluginItems={pluginMenuItems}
    >
      {row}
    </ContextMenu>
  );
});

export const FILE_ROW_HEIGHT = ROW_HEIGHT;
