import { useMemo, useRef, useState } from 'react';
import { useTree } from '@headless-tree/react';
import { useVirtualizer } from '@tanstack/react-virtual';
import type { ItemInstance, TreeInstance } from '@headless-tree/core';
import type { FileEntry } from '@/lib/fs/types';
import { useExplorerStore } from '@/stores/explorer.store';
import { ConfirmDialog } from './ConfirmDialog';
import { ContextMenu, type ContextMenuActions } from './ContextMenu';
import { CreateInput } from './CreateInput';
import { createTreeConfig } from './tree-config';
import { FILE_ROW_HEIGHT, FileRow } from './FileRow';
import {
  createNewDir,
  createNewFile,
  removeItems,
  renameItem,
} from './mutate-actions';
import { useFsWatcher } from './hooks/useFsWatcher';

interface CreatingState {
  type: 'file' | 'dir';
  parentDir: string;
}

function dirname(p: string): string {
  const trimmed = p.replace(/[\\/]+$/, '');
  const idx = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'));
  if (idx < 0) return '';
  return trimmed.slice(0, idx) || '/';
}

export function FolderTree({ root }: { root: string }) {
  // tree ref:onRename callback 在 useMemo 里引用,需要稳定 handle 拿到最新 tree
  const treeRef = useRef<TreeInstance<FileEntry> | null>(null);
  const selectedPaths = useExplorerStore((s) => s.selectedPaths);
  const [creating, setCreating] = useState<CreatingState | null>(null);
  const [deleteCandidate, setDeleteCandidate] = useState<string[] | null>(null);

  const refreshParent = (parentPath: string) => {
    try {
      const parentItem = treeRef.current?.getItemInstance(parentPath);
      parentItem?.invalidateChildrenIds();
    } catch {
      treeRef.current?.rebuildTree();
    }
  };

  const config = useMemo(
    () =>
      createTreeConfig({
        root,
        fs: window.api.fs,
        onRename: (item: ItemInstance<FileEntry>, newName: string) => {
          // headless-tree onRename 是 sync 签名,我们 fire-and-forget 走 mutate-actions
          void (async () => {
            const r = await renameItem(
              item.getId(),
              newName,
              { fs: window.api.fs },
              { invalidateChildrenIds: refreshParent },
            );
            if (!r.ok) alert(`重命名失败:[${r.code}] ${r.message}`);
          })();
        },
      }),
    [root],
  );
  const tree = useTree<FileEntry>(config);
  treeRef.current = tree;

  const items = tree.getItems();

  // ── fs.watch 增量更新(Step 6) ───────────────────────────────────
  // 跟随 headless-tree 真实展开集合(我们的 store.expandedPaths 还没接,
  // 用 tree.getState().expandedItems 即时读)。
  const expandedPaths = useMemo(
    () => new Set(tree.getState().expandedItems ?? []),
    // tree.getState().expandedItems 是数组引用,变化时 useMemo 重算;
    // 同时 items 引用也会随 expand 变,加进 deps 兜底
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [items, tree.getState().expandedItems],
  );
  useFsWatcher(expandedPaths, (changedPath) => {
    refreshParent(changedPath);
  });

  const scrollRef = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => FILE_ROW_HEIGHT,
    overscan: 8,
  });

  const treeApi = { invalidateChildrenIds: refreshParent };
  const mutateDeps = { fs: window.api.fs };

  const contextActions: ContextMenuActions = {
    onRename: (path) => tree.getItemInstance(path)?.startRenaming(),
    onDelete: (paths) => setDeleteCandidate(paths),
    onNewFile: (parentDir) => setCreating({ type: 'file', parentDir }),
    onNewDir: (parentDir) => setCreating({ type: 'dir', parentDir }),
  };

  const submitCreate = async (name: string) => {
    if (!creating) return;
    const { type, parentDir } = creating;
    setCreating(null);
    const action = type === 'dir' ? createNewDir : createNewFile;
    const r = await action(parentDir, name, mutateDeps, treeApi);
    if (!r.ok) alert(`新建失败:[${r.code}] ${r.message}`);
  };

  const confirmDelete = async () => {
    if (!deleteCandidate) return;
    const paths = deleteCandidate;
    setDeleteCandidate(null);
    const r = await removeItems(paths, { trash: true }, mutateDeps, treeApi);
    if (!r.ok) {
      alert(
        `删除失败:\n` +
          r.failures.map((f) => `  [${f.code}] ${f.path}: ${f.message}`).join('\n'),
      );
    }
  };

  return (
    <div className="flex h-full w-full flex-col">
      {creating && (
        <CreateInput
          type={creating.type}
          parentDir={creating.parentDir}
          onSubmit={submitCreate}
          onCancel={() => setCreating(null)}
        />
      )}
      <ContextMenu
        target={null}
        selectedPaths={selectedPaths}
        rootPath={root}
        actions={contextActions}
      >
        <div
          ref={scrollRef}
          className="min-h-0 flex-1 overflow-auto bg-[#020617]"
        >
          {items.length === 0 ? (
            <div className="p-4 text-xs text-neutral-500">
              读取中或空目录
            </div>
          ) : (
            <div
              {...tree.getContainerProps()}
              style={{
                height: virtualizer.getTotalSize(),
                width: '100%',
                position: 'relative',
              }}
            >
              {virtualizer.getVirtualItems().map((vRow) => {
                const item = items[vRow.index];
                if (!item) return null;
                return (
                  <FileRow
                    key={item.getId()}
                    item={item}
                    style={{
                      position: 'absolute',
                      top: 0,
                      left: 0,
                      width: '100%',
                      transform: `translateY(${vRow.start}px)`,
                    }}
                    selectedPaths={selectedPaths}
                    rootPath={root}
                    contextActions={contextActions}
                  />
                );
              })}
            </div>
          )}
        </div>
      </ContextMenu>

      <ConfirmDialog
        open={deleteCandidate !== null}
        title="确认删除"
        description={
          deleteCandidate && deleteCandidate.length === 1 ? (
            <>
              将 <code className="text-neutral-200">{deleteCandidate[0]}</code> 移到系统回收站?
            </>
          ) : (
            <>将 {deleteCandidate?.length ?? 0} 项移到系统回收站?</>
          )
        }
        confirmLabel="移到回收站"
        destructive
        onConfirm={confirmDelete}
        onCancel={() => setDeleteCandidate(null)}
      />
    </div>
  );
}
