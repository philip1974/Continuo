// headless-tree 配置工厂(Step 4)。
// 纯逻辑层,不依赖 React;UI 组件 import 后传给 useTree。
// fs 通过 deps 注入便于单测,默认调 coApi.fs(由调用方在 deps 注入).

import {
  asyncDataLoaderFeature,
  expandAllFeature,
  hotkeysCoreFeature,
  renamingFeature,
  selectionFeature,
  type ItemInstance,
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
}

const INDENT = 16;

// 跨平台 basename(避免引 path-browserify)
function basename(p: string): string {
  const trimmed = p.replace(/[\\/]+$/, '');
  const idx = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'));
  return idx >= 0 ? trimmed.slice(idx + 1) : trimmed;
}

function dirname(p: string): string {
  const trimmed = p.replace(/[\\/]+$/, '');
  const idx = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'));
  if (idx < 0) return '';
  return trimmed.slice(0, idx) || '/';
}

// 窄类型 dataLoader 接口(头部 TreeDataLoader 是两种形态的 union,
// spec 直接访问 getChildrenWithData 时 TS 不会窄化)。
// 单独导出便于 spec 无 cast 测试。
export interface FileTreeDataLoader {
  getItem: (itemId: string) => Promise<FileEntry>;
  getChildrenWithData: (
    itemId: string,
  ) => Promise<Array<{ id: string; data: FileEntry }>>;
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
          const found = r.data.find((e) => e.path === itemId);
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
          return [];
        }
        return r.data.map((entry) => ({
          id: entry.path,
          data: entry,
        }));
      } catch (err) {
        onIpcWarn(
          `listDir threw for ${itemId}: ${(err as Error).message}`,
          'IPC_HANDLER_ERROR',
        );
        return [];
      }
    },
  };
}

export function createTreeConfig(
  deps: CreateTreeConfigDeps,
): TreeConfig<FileEntry> {
  return {
    rootItemId: deps.root,
    indent: INDENT,
    getItemName: (item) => item.getItemData().name,
    isItemFolder: (item) => item.getItemData().isDirectory,
    dataLoader: createDataLoader(deps),
    onRename: deps.onRename,
    // headless-tree 默认不渲染 root 自身,只渲染已展开节点的 children。
    // root 必须显式 expand 才会触发 children 加载,否则 getItems() 返回 []。
    // Step 5/6 接入 store.expandedPaths 后,这个初始值会被持久化版覆盖。
    initialState: {
      expandedItems: [deps.root],
    },
    features: [
      asyncDataLoaderFeature,
      selectionFeature,
      hotkeysCoreFeature,
      renamingFeature, // F2 / Enter / Esc 由它接管,自动 stop hotkeys 干扰
      expandAllFeature, // tree.expandAll() / collapseAll() — UI-3 Header 按钮用
    ],
  };
}
