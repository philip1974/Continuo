import * as Menu from '@radix-ui/react-context-menu';
import { useContext, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { MenuItem, type MenuItemVariant } from '@/design';
import { ExplorerVisibleContext } from './visibility';
import { createMenuFocusRestore, type MenuFocusRestore } from './menu-close-focus';
import type { FileEntry } from '@/lib/fs/types';
import { useT } from '@/i18n';
import {
  filterVisible,
  isExplorerContextMenuItemVisible,
  type ExplorerContextMenuItemSpec,
  type ExplorerContextMenuItemContext,
} from '@/plugins/registries/ExplorerContextMenuRegistry';
import { runContributedAction } from '@/lib/run-contributed-action';
import { coApp } from '@/plugins/co-app';
import { groupKeepingOrder } from '@/lib/group-keeping-order';
import { isSortedBy } from '@/lib/is-sorted-by';

export interface ContextMenuActions {
  onRename: (path: string) => void;
  onNewFile: (parentDir: string) => void;
  onNewDir: (parentDir: string) => void;
  /** 复制绝对路径到剪贴板. 多选时 \n 拼接. */
  onCopyPath: (paths: string[]) => void;
  /** 复制相对 rootPath 的路径到剪贴板. 多选时 \n 拼接. */
  onCopyRelativePath: (paths: string[]) => void;
  /** 在系统文件管理器(Finder / 资源管理器)中显示. */
  onRevealInFinder: (path: string) => void;
  /** 新建终端,cwd 设为目录路径. */
  onOpenInTerminal: (dir: string) => void;
  /**
   * 移到系统废纸篓(可恢复). 删除路径只此一项,VSCode 同款;按 explorer.confirmDelete 先确认。
   * afterConfirm:确认(或无需确认)后、实际删除前调用(键盘删除用它移动焦点;取消则不调)。
   * 右键菜单调用时跳过 Radix 的关闭焦点还原:焦点去向由实现方负责。
   */
  onTrash: (paths: string[], afterConfirm?: () => void) => void;
  /** 剪切到 in-app 剪贴板(粘贴时移动). */
  onCut: (paths: string[]) => void;
  /** 复制到 in-app 剪贴板(粘贴时复制). */
  onCopy: (paths: string[]) => void;
  /** 粘贴 in-app 剪贴板的内容到目标目录. */
  onPaste: (destDir: string) => void;
}

interface ContextMenuProps {
  /** 触发右键的目标 entry;null 表示空白(根目录场景) */
  target: FileEntry | null;
  /** 当前 selectedPaths,用于多选时批量删除提示 */
  selectedPaths: ReadonlySet<string>;
  /** root path,空白右键创建文件 / 文件夹时作为父目录 */
  rootPath: string;
  actions: ContextMenuActions;
  /** 当前剪贴板是否非空(决定"粘贴"项是否显示). */
  hasClipboard: boolean;
  /**
   * 插件贡献的右键菜单项全量快照(打磨 R10:由 FolderTree 一次订阅后下传)。
   * 可见性仍由各菜单按自己的 target/selectedPaths/rootPath 计算,语义不变。
   */
  pluginItems: readonly ExplorerContextMenuItemSpec[];
  children: React.ReactNode;
}

const sepCls = 'my-1 h-px bg-line';

// 与 DropdownMenu(src/lib/dropdown-menu.tsx)同一浮层外观:panel 底 + line 描边 + shadow-popover(两主题各有取值)。
const contentCls =
  'min-w-[180px] overflow-hidden rounded-md border border-line bg-panel py-1 shadow-popover outline-none';

interface CtxItemProps {
  readonly onSelect: () => void;
  readonly variant?: MenuItemVariant;
  /** 右侧快捷键 / 计数(design MenuItem trailing 槽)。 */
  readonly trailing?: ReactNode;
  readonly children: ReactNode;
}

/**
 * 菜单项 = Radix ContextMenu.Item(asChild)包 design MenuItem:外观与 DropdownMenu 等其它菜单同一实现,
 * 键盘漫游 / Enter·Space 选中 / 关闭焦点还原 / 越界定位仍由 Radix 负责(MenuItem 透传 Radix 注入的 ref 与事件)。
 */
function CtxItem({ onSelect, variant, trailing, children }: CtxItemProps) {
  return (
    <Menu.Item asChild onSelect={onSelect}>
      <MenuItem variant={variant} trailing={trailing}>
        {children}
      </MenuItem>
    </Menu.Item>
  );
}

/** group 渲染顺序:内置 4 类固定,其它(plugin 自定义)按字母序追加. */
const BUILTIN_GROUP_ORDER: readonly string[] = ['new', 'edit', 'plugin', 'danger'];

function groupOrderIndex(group: string): number {
  const i = BUILTIN_GROUP_ORDER.indexOf(group);
  return i >= 0 ? i : BUILTIN_GROUP_ORDER.length; // 自定义 group 排在 'danger' 后
}

function comparePluginItemBuckets(a: PluginItemBucket, b: PluginItemBucket): number {
  const ai = groupOrderIndex(a.group);
  const bi = groupOrderIndex(b.group);
  if (ai !== bi) return ai - bi;
  return a.group.localeCompare(b.group);
}

interface PluginItemBucket {
  readonly group: string;
  readonly items: readonly ExplorerContextMenuItemSpec[];
}

const EMPTY_CONTEXT_ACTION_TARGETS: string[] = [];
const EMPTY_PLUGIN_ITEM_BUCKETS: PluginItemBucket[] = [];

export function getContextActionTargets(
  target: FileEntry | null,
  selectedPaths: ReadonlySet<string>,
): string[] {
  if (target === null) return EMPTY_CONTEXT_ACTION_TARGETS;
  if (selectedPaths.has(target.path) && selectedPaths.size > 1) {
    const paths = new Array<string>(selectedPaths.size);
    let i = 0;
    for (const path of selectedPaths) {
      paths[i++] = path;
    }
    return paths;
  }
  return [target.path];
}

/** 把 plugin 贡献项按 group 排序、聚合,过滤不可见. */
export function groupPluginItems(
  raw: readonly ExplorerContextMenuItemSpec[],
  ctx: ExplorerContextMenuItemContext,
): PluginItemBucket[] {
  const visible = filterVisible(raw, ctx);
  if (visible.length === 0) return EMPTY_PLUGIN_ITEM_BUCKETS;
  const groups = groupKeepingOrder(visible, (item) => item.group ?? 'plugin');
  const buckets = new Array<PluginItemBucket>(groups.length);
  for (let i = 0; i < groups.length; i++) {
    buckets[i] = { group: groups[i]!.key, items: groups[i]!.items };
  }
  if (!isSortedBy(buckets, comparePluginItemBuckets)) {
    buckets.sort(comparePluginItemBuckets);
  }
  return buckets;
}

// 右键菜单包装。children 为接收右键的可见区域(行 / 空白容器)。
// 菜单项由 target 类型(文件 / 文件夹 / null=空白)决定。
// V1(2026-05):内置 4 项之后追加 plugin 贡献项,按 group 分组 + 分隔。
export function ContextMenu({
  target,
  selectedPaths,
  rootPath,
  actions,
  hasClipboard,
  pluginItems,
  children,
}: ContextMenuProps) {
  // 插件 when / 菜单文案 / action targets 都延迟到菜单真正打开时执行。虚拟列表每个
  // 可见 FileRow 都挂 ContextMenu,关闭态只保留 Root+Trigger,避免常规滚动/hover/剪贴板
  // 变化触发整批菜单内容构建与 i18n 订阅。
  const [open, setOpen] = useState(false);
  // a11y(A27):默认保留 Radix 关闭后焦点还原;仅「新建/重命名」(会打开自聚焦输入框)一次性跳过。
  const focusRestore = useRef(createMenuFocusRestore()).current;

  return (
    <Menu.Root onOpenChange={setOpen}>
      <Menu.Trigger asChild>{children}</Menu.Trigger>
      {open && (
        <ContextMenuContent
          target={target}
          selectedPaths={selectedPaths}
          rootPath={rootPath}
          actions={actions}
          hasClipboard={hasClipboard}
          pluginItems={pluginItems}
          focusRestore={focusRestore}
          onHidden={() => setOpen(false)}
        />
      )}
    </Menu.Root>
  );
}

interface ContextMenuContentProps extends Omit<ContextMenuProps, 'children'> {
  readonly focusRestore: MenuFocusRestore;
  /** 侧栏保活隐藏时调用:卸载菜单内容(见 ContextMenuContent 内注释)。 */
  readonly onHidden: () => void;
}

function ContextMenuContent({
  target,
  selectedPaths,
  rootPath,
  actions,
  hasClipboard,
  pluginItems,
  focusRestore,
  onHidden,
}: ContextMenuContentProps) {
  const t = useT();
  // 交互回归修复:侧栏关闭改为保活隐藏(aside hidden)后,菜单 Portal 在 body 上不随隐藏消失 →
  // 悬浮可操作看不见的树,且 Radix 模态菜单令 body pointer-events:none 残留。隐藏即卸载内容
  //(DismissableLayer 卸载即还原 body 样式);layout effect 在绘制前生效,隐藏帧不会画出菜单。
  // 只在打开态订阅可见性,关闭态的每行菜单不因侧栏显隐重渲。Radix ContextMenu.Root 不支持受控
  // open,其内部 open 仍为 true 无副作用:下次右键照常回调 onOpenChange(true) 重新打开。
  const visible = useContext(ExplorerVisibleContext);
  useLayoutEffect(() => {
    if (!visible) onHidden();
  }, [visible, onHidden]);
  const isFolder = target !== null && target.isDirectory;
  const isBlank = target === null;

  // 插件 when 过滤延迟到菜单真正打开时执行(打磨 R13):groupPluginItems →
  // filterVisible 会逐个跑第三方同步 when() 谓词;虚拟列表里每个可见 FileRow 都
  // 挂一个菜单,常规滚动/hover/剪贴板变化触发的行重渲染本不需要这些计算。
  const pluginCtx: ExplorerContextMenuItemContext = {
    target,
    selectedPaths,
    rootPath,
  };
  const pluginGroups = groupPluginItems(pluginItems, pluginCtx);

  // 本次菜单操作目标:若 target 在多选集中,批量作用于 selectedPaths;否则只
  // target 自身。ContextMenuContent 仅打开时挂载,因此这里不会影响关闭态行渲染。
  const actionTargets = getContextActionTargets(target, selectedPaths);
  const actionTargetCount = actionTargets.length;
  // 多选时「复制路径 / 复制相对路径 / 移到废纸篓」右侧显示条目数(MenuItem trailing 槽)。
  const countTrailing =
    actionTargetCount > 1
      ? t('panels.explorer.ctx.items_count', { count: actionTargetCount })
      : undefined;

  // 创建上下文目录:文件夹 right-click → 它本身;空白 → root(文件行不显示「新建 / 粘贴」)。
  const createParent = (): string => (isFolder ? target!.path : rootPath);

  return (
    <Menu.Portal>
      <Menu.Content
        className={contentCls}
        collisionPadding={8}
        // a11y(A27):默认保留 Radix 关闭后焦点还原(Esc / 普通项关闭 → 焦点回触发行,键盘可用)。
        // 仅「新建/重命名」一次性跳过还原 —— 它们随后打开 CreateInput/RenameInput 并 rAF
        // 自聚焦,还原会把焦点抢回行 div(导致 Esc 落错元素被树 hotkeys 吞)。见 menu-close-focus.ts。
        onCloseAutoFocus={focusRestore.onCloseAutoFocus}
      >
        {(isFolder || isBlank) && (
          <>
            <CtxItem
              onSelect={() => {
                focusRestore.skipOnce(); // 将打开 CreateInput 并自聚焦 → 跳过还原
                actions.onNewFile(createParent());
              }}
            >
              {t('panels.explorer.ctx.new_file')}
            </CtxItem>
            <CtxItem
              onSelect={() => {
                focusRestore.skipOnce(); // 将打开 CreateInput 并自聚焦 → 跳过还原
                actions.onNewDir(createParent());
              }}
            >
              {t('panels.explorer.ctx.new_folder')}
            </CtxItem>
            {hasClipboard && (
              <CtxItem onSelect={() => actions.onPaste(createParent())}>
                {t('panels.explorer.ctx.paste')}
              </CtxItem>
            )}
            {!isBlank && <Menu.Separator className={sepCls} />}
          </>
        )}

        {!isBlank && (
          <>
            {/* 剪切 / 复制(in-app 剪贴板) */}
            <CtxItem onSelect={() => actions.onCut(actionTargets)}>
              {t('panels.explorer.ctx.cut')}
            </CtxItem>
            <CtxItem onSelect={() => actions.onCopy(actionTargets)}>
              {t('panels.explorer.ctx.copy')}
            </CtxItem>
            <Menu.Separator className={sepCls} />

            <CtxItem
              onSelect={() => {
                focusRestore.skipOnce(); // 将打开 RenameInput 并自聚焦 → 跳过还原
                actions.onRename(target!.path);
              }}
              trailing="F2"
            >
              {t('panels.explorer.ctx.rename')}
            </CtxItem>
            <Menu.Separator className={sepCls} />

            {/* 路径剪贴板段:多选时复制全部(\n 拼接,VSCode 同款) */}
            <CtxItem onSelect={() => actions.onCopyPath(actionTargets)} trailing={countTrailing}>
              {t('panels.explorer.ctx.copy_path')}
            </CtxItem>
            <CtxItem
              onSelect={() => actions.onCopyRelativePath(actionTargets)}
              trailing={countTrailing}
            >
              {t('panels.explorer.ctx.copy_relative_path')}
            </CtxItem>
            <Menu.Separator className={sepCls} />

            {/* 系统集成段 */}
            <CtxItem onSelect={() => actions.onRevealInFinder(target!.path)}>
              {t('panels.explorer.ctx.reveal_in_finder')}
            </CtxItem>
            {isFolder && (
              <CtxItem onSelect={() => actions.onOpenInTerminal(target!.path)}>
                {t('panels.explorer.ctx.open_in_terminal')}
              </CtxItem>
            )}
            <Menu.Separator className={sepCls} />

            {/* 移到废纸篓(安全删除,可恢复) */}
            <CtxItem
              variant="danger"
              onSelect={() => {
                // 焦点由 onTrash 接管(FolderTree:确认框打开期间在框内,取消回到该行,删除后到相邻项)。
                // Radix 的还原在 setTimeout 里把焦点还给触发行,会抢走确认框的自聚焦(焦点落在遮罩后的树行)。
                focusRestore.skipOnce();
                actions.onTrash(actionTargets);
              }}
              trailing={countTrailing}
            >
              {t('panels.explorer.ctx.trash')}
            </CtxItem>
          </>
        )}

        {/* Plugin 贡献项,按 group 分组,group 间分隔线。三种菜单状态(文件 /
                文件夹 / 空白)都必有内置项,故有 plugin 段时总要前置分隔符(打磨 R11:
                删除恒真的 builtinHasItems 伪条件)。 */}
        {pluginGroups.length > 0 && <Menu.Separator className={sepCls} />}
        {pluginGroups.map((bucket, gi) => (
          <div key={bucket.group}>
            {gi > 0 && <Menu.Separator className={sepCls} />}
            {bucket.items.map((item) => (
              <CtxItem
                key={item.id}
                // 插件右键项抛错经 runContributedAction 弹 error toast,不再只
                // console.warn(菜单已关,用户看不到失败)。见第二十一轮 P1-AX。
                // race(R54,R51/R52/R53 同族):select 时按 id 从 live coApp.explorerContextMenu
                // 重查 + 用当前 pluginCtx 复检 when 再执行,而非调菜单打开时捕获的 item.fn。
                // 菜单打开期间插件 disable/reload unregister 后旧菜单仍可触发;重查使死项 / 当前
                // ctx 下不可见项静默忽略,不执行已卸载插件代码。
                onSelect={() =>
                  runContributedAction(item.label, () => {
                    const live = coApp.explorerContextMenu.get(item.id);
                    if (!live) return;
                    if (!isExplorerContextMenuItemVisible(live, pluginCtx)) return;
                    return live.fn(pluginCtx);
                  })
                }
              >
                {item.icon && <span className="mr-2 inline-flex shrink-0 align-middle">{item.icon}</span>}
                {item.label}
              </CtxItem>
            ))}
          </div>
        ))}
      </Menu.Content>
    </Menu.Portal>
  );
}
