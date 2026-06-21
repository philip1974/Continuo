import * as Menu from '@radix-ui/react-context-menu';
import { useState } from 'react';
import type { FileEntry } from '@/lib/fs/types';
import { useT } from '@/i18n';
import {
  filterVisible,
  type ExplorerContextMenuItemSpec,
  type ExplorerContextMenuItemContext,
} from '@/plugins/registries/ExplorerContextMenuRegistry';
import { runContributedAction } from '@/lib/run-contributed-action';

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
  /** 移到系统废纸篓(可恢复). 删除路径只此一项,VSCode 同款. */
  onTrash: (paths: string[]) => void;
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

const itemCls =
  'flex items-center gap-2 rounded px-2 py-1 text-xs text-fg outline-none data-[highlighted]:bg-hover data-[disabled]:opacity-40';

const sepCls = 'my-1 h-px bg-line';

const contentCls =
  'min-w-[180px] rounded-md border border-line bg-panel p-1 shadow-xl outline-none';

/** group 渲染顺序:内置 4 类固定,其它(plugin 自定义)按字母序追加. */
const BUILTIN_GROUP_ORDER: readonly string[] = ['new', 'edit', 'plugin', 'danger'];

function groupOrderIndex(group: string): number {
  const i = BUILTIN_GROUP_ORDER.indexOf(group);
  return i >= 0 ? i : BUILTIN_GROUP_ORDER.length; // 自定义 group 排在 'danger' 后
}

interface PluginItemBucket {
  readonly group: string;
  readonly items: readonly ExplorerContextMenuItemSpec[];
}

/** 把 plugin 贡献项按 group 排序、聚合,过滤不可见. */
function groupPluginItems(
  raw: readonly ExplorerContextMenuItemSpec[],
  ctx: ExplorerContextMenuItemContext,
): PluginItemBucket[] {
  const visible = filterVisible(raw, ctx);
  const map = new Map<string, ExplorerContextMenuItemSpec[]>();
  for (const item of visible) {
    const g = item.group ?? 'plugin';
    let arr = map.get(g);
    if (!arr) {
      arr = [];
      map.set(g, arr);
    }
    arr.push(item);
  }
  return Array.from(map.entries())
    .sort(([a], [b]) => {
      const ai = groupOrderIndex(a);
      const bi = groupOrderIndex(b);
      if (ai !== bi) return ai - bi;
      return a.localeCompare(b);
    })
    .map(([group, items]) => ({ group, items }));
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
  const t = useT();
  const isFile = target !== null && !target.isDirectory;
  const isFolder = target !== null && target.isDirectory;
  const isBlank = target === null;

  // 插件 when 过滤延迟到菜单真正打开时执行(打磨 R13):groupPluginItems →
  // filterVisible 会逐个跑第三方同步 when() 谓词;虚拟列表里每个可见 FileRow 都
  // 挂一个菜单,常规滚动/hover/剪贴板变化触发的行重渲染本不需要这些计算。用
  // onOpenChange 维护 open,未打开时 pluginGroups 直接为空,弹出时才按当前上下文算。
  const [open, setOpen] = useState(false);
  const pluginCtx: ExplorerContextMenuItemContext = {
    target,
    selectedPaths,
    rootPath,
  };
  const pluginGroups = open ? groupPluginItems(pluginItems, pluginCtx) : [];

  // 本次菜单操作目标:若 target 在多选集中,批量作用于 selectedPaths;否则只
  // target 自身。每次渲染算一次(打磨 R12):cut/copy/path/trash 等 6+ 处都复用,
  // 原先各调一次 deleteTargets() → 多选时重复 Array.from(selectedPaths)。
  const computeActionTargets = (): string[] => {
    if (target === null) return [];
    if (selectedPaths.has(target.path) && selectedPaths.size > 1) {
      return Array.from(selectedPaths);
    }
    return [target.path];
  };
  const actionTargets = computeActionTargets();
  const actionTargetCount = actionTargets.length;

  // 创建上下文目录:文件夹 right-click → 它本身;文件 → 它的父;空白 → root
  const createParent = (): string => {
    if (isFolder) return target!.path;
    if (isFile) {
      const idx = Math.max(
        target!.path.lastIndexOf('/'),
        target!.path.lastIndexOf('\\'),
      );
      return idx >= 0 ? target!.path.slice(0, idx) : rootPath;
    }
    return rootPath;
  };

  return (
    <Menu.Root onOpenChange={setOpen}>
      <Menu.Trigger asChild>{children}</Menu.Trigger>
      <Menu.Portal>
        <Menu.Content
          className={contentCls}
          collisionPadding={8}
          // 关闭后不要把 focus 还给行 div(默认行为)。
          // 否则 RenameInput / CreateInput 的 useEffect.focus 会被它抢回去,
          // 导致 Esc 在错误元素上触发,被树容器 hotkeys 吃掉。
          onCloseAutoFocus={(e) => e.preventDefault()}
        >
          {(isFolder || isBlank) && (
            <>
              <Menu.Item
                className={itemCls}
                onSelect={() => actions.onNewFile(createParent())}
              >
                {t('panels.explorer.ctx.new_file')}
              </Menu.Item>
              <Menu.Item
                className={itemCls}
                onSelect={() => actions.onNewDir(createParent())}
              >
                {t('panels.explorer.ctx.new_folder')}
              </Menu.Item>
              {hasClipboard && (
                <Menu.Item
                  className={itemCls}
                  onSelect={() => actions.onPaste(createParent())}
                >
                  {t('panels.explorer.ctx.paste')}
                </Menu.Item>
              )}
              {!isBlank && <Menu.Separator className={sepCls} />}
            </>
          )}

          {!isBlank && (
            <>
              {/* 剪切 / 复制(in-app 剪贴板) */}
              <Menu.Item
                className={itemCls}
                onSelect={() => actions.onCut(actionTargets)}
              >
                {t('panels.explorer.ctx.cut')}
              </Menu.Item>
              <Menu.Item
                className={itemCls}
                onSelect={() => actions.onCopy(actionTargets)}
              >
                {t('panels.explorer.ctx.copy')}
              </Menu.Item>
              <Menu.Separator className={sepCls} />

              <Menu.Item
                className={itemCls}
                onSelect={() => actions.onRename(target!.path)}
              >
                {t('panels.explorer.ctx.rename')}
                <span className="ml-auto text-2xs text-fg-dim">F2</span>
              </Menu.Item>
              <Menu.Separator className={sepCls} />

              {/* 路径剪贴板段:多选时复制全部(\n 拼接,VSCode 同款) */}
              <Menu.Item
                className={itemCls}
                onSelect={() => actions.onCopyPath(actionTargets)}
              >
                {t('panels.explorer.ctx.copy_path')}
                {actionTargetCount > 1 && (
                  <span className="ml-auto text-2xs text-fg-dim">
                    {t('panels.explorer.ctx.items_count', { count: actionTargetCount })}
                  </span>
                )}
              </Menu.Item>
              <Menu.Item
                className={itemCls}
                onSelect={() => actions.onCopyRelativePath(actionTargets)}
              >
                {t('panels.explorer.ctx.copy_relative_path')}
                {actionTargetCount > 1 && (
                  <span className="ml-auto text-2xs text-fg-dim">
                    {t('panels.explorer.ctx.items_count', { count: actionTargetCount })}
                  </span>
                )}
              </Menu.Item>
              <Menu.Separator className={sepCls} />

              {/* 系统集成段 */}
              <Menu.Item
                className={itemCls}
                onSelect={() => actions.onRevealInFinder(target!.path)}
              >
                {t('panels.explorer.ctx.reveal_in_finder')}
              </Menu.Item>
              {isFolder && (
                <Menu.Item
                  className={itemCls}
                  onSelect={() => actions.onOpenInTerminal(target!.path)}
                >
                  {t('panels.explorer.ctx.open_in_terminal')}
                </Menu.Item>
              )}
              <Menu.Separator className={sepCls} />

              {/* 移到废纸篓(安全删除,可恢复) */}
              <Menu.Item
                className={itemCls}
                onSelect={() => actions.onTrash(actionTargets)}
              >
                {t('panels.explorer.ctx.trash')}
                {actionTargetCount > 1 && (
                  <span className="ml-auto text-2xs text-fg-dim">
                    {t('panels.explorer.ctx.items_count', { count: actionTargetCount })}
                  </span>
                )}
              </Menu.Item>
            </>
          )}

          {/* Plugin 贡献项,按 group 分组,group 间分隔线。三种菜单状态(文件 /
              文件夹 / 空白)都必有内置项,故有 plugin 段时总要前置分隔符(打磨 R11:
              删除恒真的 builtinHasItems 伪条件)。 */}
          {pluginGroups.length > 0 && (
            <Menu.Separator className={sepCls} />
          )}
          {pluginGroups.map((bucket, gi) => (
            <div key={bucket.group}>
              {gi > 0 && <Menu.Separator className={sepCls} />}
              {bucket.items.map((item) => (
                <Menu.Item
                  key={item.id}
                  className={itemCls}
                  // 插件右键项抛错经 runContributedAction 弹 error toast,不再只
                  // console.warn(菜单已关,用户看不到失败)。见第二十一轮 P1-AX。
                  onSelect={() =>
                    runContributedAction(item.label, () => item.fn(pluginCtx))
                  }
                >
                  {item.icon && (
                    <span className="inline-flex shrink-0">{item.icon}</span>
                  )}
                  <span className="truncate">{item.label}</span>
                </Menu.Item>
              ))}
            </div>
          ))}
        </Menu.Content>
      </Menu.Portal>
    </Menu.Root>
  );
}
