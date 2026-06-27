// headless-tree 配置工厂(Step 4)。
// 纯逻辑层,不依赖 React;UI 组件 import 后传给 useTree。
// fs 通过 deps 注入便于单测,默认调 coApi.fs(由调用方在 deps 注入).

import { basename, dirname } from './path-utils';
import { hasFiles } from '@/lib/window-drop'; // 边界(E225,E224 兄弟):共享早停 hasFiles 替代 types.includes('Files')
import { isSameOrInsidePath } from '@/lib/path-cross';
import {
  asyncDataLoaderFeature,
  dragAndDropFeature,
  expandAllFeature,
  hotkeysCoreFeature,
  renamingFeature,
  selectionFeature,
  type DragTarget,
  type ItemInstance,
  type SetStateFn,
  type TreeConfig,
} from '@headless-tree/core';
import type { FileEntry, IpcResult } from '@/lib/fs/types';

// 仅依赖 listDir 的最小 fs api 形状,便于 spec mock
export interface FsForTree {
  listDir: (
    path: string,
  ) => Promise<IpcResult<ReadonlyArray<FileEntry>>>;
}

export interface CreateTreeConfigDeps {
  root: string;
  fs: FsForTree;
  /** spec 注入断言;默认 console.warn. */
  onIpcWarn?: (message: string, code: string) => void;
  /** 用户在 inline rename input 按 Enter 时触发(headless-tree renamingFeature). */
  onRename?: (item: ItemInstance<FileEntry>, newName: string) => void;
  /** 内部多选拖动 → drop 到目标(目录或文件→父目录). 业务侧执行 fs.move. */
  onDropItems?: (
    items: ItemInstance<FileEntry>[],
    destDir: string,
  ) => void;
  /** 外部 OS 文件拖入 row 上 → drop 到目标(目录或文件→父目录). */
  onDropForeign?: (
    dataTransfer: DataTransfer,
    destDir: string,
  ) => void;
  /** 受控展开状态:接 store.expandedPaths 时由 FolderTree 注入。 */
  expandedItems?: string[];
  setExpandedItems?: SetStateFn<string[]>;
}

const INDENT = 16;

// 窄类型 dataLoader 接口(头部 TreeDataLoader 是两种形态的 union,
// spec 直接访问 getChildrenWithData 时 TS 不会窄化)。
// 单独导出便于 spec 无 cast 测试。
export interface FileTreeDataLoader {
  getItem: (itemId: string) => Promise<FileEntry>;
  getChildrenWithData: (
    itemId: string,
  ) => Promise<FileTreeChild[]>;
}

type FileTreeChild = { id: string; data: FileEntry };
const EMPTY_TREE_CHILDREN: FileTreeChild[] = [];

export function buildTreeChildrenWithData(
  entries: readonly FileEntry[],
): FileTreeChild[] {
  if (entries.length === 0) return EMPTY_TREE_CHILDREN;
  const out = new Array<FileTreeChild>(entries.length);
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i]!;
    out[i] = { id: entry.path, data: entry };
  }
  return out;
}

export function findFileEntryByPath(
  entries: readonly FileEntry[],
  path: string,
): FileEntry | null {
  for (const entry of entries) {
    if (entry.path === path) return entry;
  }
  return null;
}

export function createDataLoader(deps: CreateTreeConfigDeps): FileTreeDataLoader {
  const { root, fs, onIpcWarn = (m, c) => console.warn('[explorer-tree]', m, c) } = deps;

  return {
    getItem: async (itemId) => {
      // root 没有父目录,直接构造
      if (itemId === root) {
        return { path: itemId, name: basename(itemId), isDirectory: true };
      }
      // 非 root:从父目录的 listDir 找。getChildrenWithData 一般已 cache,
      // 这里是 cache miss 的兜底路径
      const parent = dirname(itemId);
      try {
        const r = await fs.listDir(parent);
        if (!r.ok) {
          onIpcWarn(`getItem: listDir failed for ${parent}: ${r.message}`, r.code);
        } else {
          const found = findFileEntryByPath(r.data, itemId);
          if (found) return found;
        }
      } catch (err) {
        onIpcWarn(
          `getItem: listDir threw for ${parent}: ${(err as Error).message}`,
          'IPC_HANDLER_ERROR',
        );
      }
      // 兜底:返回最小信息(name 用 basename,假定非目录)
      return { path: itemId, name: basename(itemId), isDirectory: false };
    },

    getChildrenWithData: async (itemId) => {
      try {
        const r = await fs.listDir(itemId);
        if (!r.ok) {
          onIpcWarn(`listDir failed for ${itemId}: ${r.message}`, r.code);
          return EMPTY_TREE_CHILDREN;
        }
        return buildTreeChildrenWithData(r.data);
      } catch (err) {
        onIpcWarn(
          `listDir threw for ${itemId}: ${(err as Error).message}`,
          'IPC_HANDLER_ERROR',
        );
        return EMPTY_TREE_CHILDREN;
      }
    },
  };
}

export function createTreeConfig(
  deps: CreateTreeConfigDeps,
): TreeConfig<FileEntry> {
  // drop 落点归一化:目录 → 自身;文件 → 父目录
  const resolveDest = (target: DragTarget<FileEntry>): string => {
    const item = target.item;
    return item.isFolder() ? item.getId() : dirname(item.getId());
  };

  const config: TreeConfig<FileEntry> = {
    rootItemId: deps.root,
    indent: INDENT,
    getItemName: (item) => item.getItemData().name,
    isItemFolder: (item) => item.getItemData().isDirectory,
    dataLoader: createDataLoader(deps),
    onRename: deps.onRename,
    // headless-tree 默认不渲染 root 自身,只渲染已展开节点的 children。
    // root 必须显式 expand 才会触发 children 加载,否则 getItems() 返回 []。
    initialState: {
      expandedItems: [deps.root],
    },
    // 文件树 drop 语义:只允许 drop into folder(no reorder);
    // 不能 drop 到自身或自身子树(loop);drop 到 file → 进父目录
    canReorder: false,
    // hover 折叠的文件夹达到此阈值时自动展开,方便拖到深层子目录
    // (VSCode 同款)。headless-tree 默认 800ms,我们调到 500ms 更跟手。
    openOnDropDelay: 500,
    canDrop: (items, target) => {
      const destDir = resolveDest(target);
      for (const it of items) {
        const srcId = it.getId();
        // drop 到自身
        if (srcId === target.item.getId()) return false;
        // 目录 drop 到自身子树:srcId 是 destDir 的祖先(含相等)。跨平台(codex 复查 P2):
        // 复用 path-cross.isSameOrInsidePath —— 此前大小写敏感,Windows 源/目标仅大小写
        // 不同时误判可 drop → 放行 move-into-self/descendant → 底层 move 报错/UI 错乱。
        if (isSameOrInsidePath(srcId, destDir)) return false;
      }
      // 注意:dirname(srcId) === destDir(拖到当前父目录 = no-op)在这里 *不* 拦,
      // 否则 headless-tree 的 getDragTarget(canReorder=false)会因 canBecomeSibling=false
      // 递归到 parent 把 target 解析回源的当前父目录,反而触发整体 silent fail。
      // 实际处理时(onDropItems)再按 src parent === destDir skip 即可(VSCode 同款)。
      return true;
    },
    onDrop: (items, target) => {
      deps.onDropItems?.(items, resolveDest(target));
    },
    canDropForeignDragObject: (dataTransfer) =>
      hasFiles(dataTransfer),
    canDragForeignDragObjectOver: (dataTransfer) =>
      hasFiles(dataTransfer),
    onDropForeignDragObject: (dataTransfer, target) => {
      deps.onDropForeign?.(dataTransfer, resolveDest(target));
    },
    features: [
      asyncDataLoaderFeature,
      selectionFeature,
      hotkeysCoreFeature,
      renamingFeature, // F2 / Enter / Esc 由它接管,自动 stop hotkeys 干扰
      expandAllFeature, // tree.expandAll() / collapseAll() — UI-3 Header 按钮用
      dragAndDropFeature, // 内部多选 move + 外部文件 drop on row
    ],
  };

  if (deps.expandedItems) {
    config.state = { expandedItems: deps.expandedItems };
    config.setExpandedItems = deps.setExpandedItems;
  }

  return config;
}
