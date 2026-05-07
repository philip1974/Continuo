import { useEffect, useState } from 'react';
import * as Menu from '@radix-ui/react-context-menu';
import type { FileEntry } from '@/lib/fs/types';
import { coApp } from '@/plugins/co-app';
import {
  filterVisible,
  type ExplorerContextMenuItemSpec,
  type ExplorerContextMenuItemContext,
} from '@/plugins/registries/ExplorerContextMenuRegistry';

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

/** 订阅 explorerContextMenu registry,plugin 注册/dispose 自动重渲. */
function useExplorerContextMenuItems(): readonly ExplorerContextMenuItemSpec[] {
  const [snap, setSnap] = useState(() => coApp.explorerContextMenu.getAll());
  useEffect(
    () =>
      coApp.explorerContextMenu.subscribe(() =>
        setSnap(coApp.explorerContextMenu.getAll()),
      ),
    [],
  );
  return snap;
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
  children,
}: ContextMenuProps) {
  const isFile = target !== null && !target.isDirectory;
  const isFolder = target !== null && target.isDirectory;
  const isBlank = target === null;

  const allPluginItems = useExplorerContextMenuItems();
  const pluginCtx: ExplorerContextMenuItemContext = {
    target,
    selectedPaths,
    rootPath,
  };
  const pluginGroups = groupPluginItems(allPluginItems, pluginCtx);

  // 删除目标:若 target 在多选集中,批量删 selectedPaths;否则只删 target
  const deleteTargets = (): string[] => {
    if (target === null) return [];
    if (selectedPaths.has(target.path) && selectedPaths.size > 1) {
      return Array.from(selectedPaths);
    }
    return [target.path];
  };

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

  // 内置 4 项是否会显:决定 plugin 段是否需要前置分隔符
  const builtinHasItems = isFolder || isBlank || !isBlank;

  return (
    <Menu.Root>
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
                新建文件
              </Menu.Item>
              <Menu.Item
                className={itemCls}
                onSelect={() => actions.onNewDir(createParent())}
              >
                新建文件夹
              </Menu.Item>
              {hasClipboard && (
                <Menu.Item
                  className={itemCls}
                  onSelect={() => actions.onPaste(createParent())}
                >
                  粘贴
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
                onSelect={() => actions.onCut(deleteTargets())}
              >
                剪切
              </Menu.Item>
              <Menu.Item
                className={itemCls}
                onSelect={() => actions.onCopy(deleteTargets())}
              >
                复制
              </Menu.Item>
              <Menu.Separator className={sepCls} />

              <Menu.Item
                className={itemCls}
                onSelect={() => actions.onRename(target!.path)}
              >
                重命名
                <span className="ml-auto text-2xs text-fg-dim">F2</span>
              </Menu.Item>
              <Menu.Separator className={sepCls} />

              {/* 路径剪贴板段:多选时复制全部(\n 拼接,VSCode 同款) */}
              <Menu.Item
                className={itemCls}
                onSelect={() => actions.onCopyPath(deleteTargets())}
              >
                复制路径
                {deleteTargets().length > 1 && (
                  <span className="ml-auto text-2xs text-fg-dim">
                    {deleteTargets().length} 项
                  </span>
                )}
              </Menu.Item>
              <Menu.Item
                className={itemCls}
                onSelect={() => actions.onCopyRelativePath(deleteTargets())}
              >
                复制相对路径
                {deleteTargets().length > 1 && (
                  <span className="ml-auto text-2xs text-fg-dim">
                    {deleteTargets().length} 项
                  </span>
                )}
              </Menu.Item>
              <Menu.Separator className={sepCls} />

              {/* 系统集成段 */}
              <Menu.Item
                className={itemCls}
                onSelect={() => actions.onRevealInFinder(target!.path)}
              >
                在 Finder 中显示
              </Menu.Item>
              {isFolder && (
                <Menu.Item
                  className={itemCls}
                  onSelect={() => actions.onOpenInTerminal(target!.path)}
                >
                  在集成终端中打开
                </Menu.Item>
              )}
              <Menu.Separator className={sepCls} />

              {/* 移到废纸篓(安全删除,可恢复) */}
              <Menu.Item
                className={itemCls}
                onSelect={() => actions.onTrash(deleteTargets())}
              >
                移到废纸篓
                {deleteTargets().length > 1 && (
                  <span className="ml-auto text-2xs text-fg-dim">
                    {deleteTargets().length} 项
                  </span>
                )}
              </Menu.Item>
            </>
          )}

          {/* Plugin 贡献项,按 group 分组,group 间分隔线 */}
          {pluginGroups.length > 0 && builtinHasItems && (
            <Menu.Separator className={sepCls} />
          )}
          {pluginGroups.map((bucket, gi) => (
            <div key={bucket.group}>
              {gi > 0 && <Menu.Separator className={sepCls} />}
              {bucket.items.map((item) => (
                <Menu.Item
                  key={item.id}
                  className={itemCls}
                  onSelect={() => {
                    void Promise.resolve(item.fn(pluginCtx)).catch((err) => {
                      console.warn(
                        `[explorer-context-menu] item "${item.id}" fn threw`,
                        err,
                      );
                    });
                  }}
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
