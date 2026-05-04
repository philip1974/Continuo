import * as Menu from '@radix-ui/react-context-menu';
import type { FileEntry } from '@/lib/fs/types';

export interface ContextMenuActions {
  onRename: (path: string) => void;
  onDelete: (paths: string[]) => void;
  onNewFile: (parentDir: string) => void;
  onNewDir: (parentDir: string) => void;
}

interface ContextMenuProps {
  /** 触发右键的目标 entry;null 表示空白(根目录场景) */
  target: FileEntry | null;
  /** 当前 selectedPaths,用于多选时批量删除提示 */
  selectedPaths: ReadonlySet<string>;
  /** root path,空白右键创建文件 / 文件夹时作为父目录 */
  rootPath: string;
  actions: ContextMenuActions;
  children: React.ReactNode;
}

const itemCls =
  'flex items-center gap-2 rounded px-2 py-1 text-xs text-neutral-200 outline-none data-[highlighted]:bg-neutral-800 data-[disabled]:opacity-40';

const sepCls = 'my-1 h-px bg-neutral-800';

const contentCls =
  'min-w-[180px] rounded-md border border-neutral-800 bg-neutral-950 p-1 shadow-xl outline-none';

// 右键菜单包装。children 为接收右键的可见区域(行 / 空白容器)。
// 菜单项由 target 类型(文件 / 文件夹 / null=空白)决定。
export function ContextMenu({
  target,
  selectedPaths,
  rootPath,
  actions,
  children,
}: ContextMenuProps) {
  const isFile = target !== null && !target.isDirectory;
  const isFolder = target !== null && target.isDirectory;
  const isBlank = target === null;

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

  return (
    <Menu.Root>
      <Menu.Trigger asChild>{children}</Menu.Trigger>
      <Menu.Portal>
        <Menu.Content className={contentCls} collisionPadding={8}>
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
              {!isBlank && <Menu.Separator className={sepCls} />}
            </>
          )}

          {!isBlank && (
            <>
              <Menu.Item
                className={itemCls}
                onSelect={() => actions.onRename(target!.path)}
              >
                重命名
                <span className="ml-auto text-[10px] text-neutral-500">F2</span>
              </Menu.Item>
              <Menu.Separator className={sepCls} />
              <Menu.Item
                className={`${itemCls} text-red-300 data-[highlighted]:bg-red-950/40 data-[highlighted]:text-red-200`}
                onSelect={() => actions.onDelete(deleteTargets())}
              >
                删除
                {deleteTargets().length > 1 && (
                  <span className="ml-auto text-[10px] text-neutral-500">
                    {deleteTargets().length} 项
                  </span>
                )}
              </Menu.Item>
            </>
          )}
        </Menu.Content>
      </Menu.Portal>
    </Menu.Root>
  );
}
