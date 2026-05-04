import { useMemo, useRef, useState } from 'react';
import { useTree } from '@headless-tree/react';
import { useVirtualizer } from '@tanstack/react-virtual';
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

interface CreatingState {
  type: 'file' | 'dir';
  parentDir: string;
}

export function FolderTree({ root }: { root: string }) {
  const config = useMemo(
    () => createTreeConfig({ root, fs: window.api.fs }),
    [root],
  );
  const tree = useTree<FileEntry>(config);
  const items = tree.getItems();
  const selectedPaths = useExplorerStore((s) => s.selectedPaths);

  // ── 本地 UI 状态:rename / create / 删除确认 ────────────────────────
  const [renamingPath, setRenamingPath] = useState<string | null>(null);
  const [creating, setCreating] = useState<CreatingState | null>(null);
  const [deleteCandidate, setDeleteCandidate] = useState<string[] | null>(null);

  // ── 虚拟滚动 ───────────────────────────────────────────────────────
  const scrollRef = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => FILE_ROW_HEIGHT,
    overscan: 8,
  });

  // ── mutate 调用桥(invalidate 用 tree 的 itemInstance 刷父) ────────
  const refreshParent = (parentPath: string) => {
    try {
      const parentItem = tree.getItemInstance(parentPath);
      parentItem?.invalidateChildrenIds();
    } catch {
      // parent 不在树里(比如祖父级),整树重建兜底
      tree.rebuildTree();
    }
  };
  const treeApi = { invalidateChildrenIds: refreshParent };
  const mutateDeps = { fs: window.api.fs };

  // ── ContextMenu 动作 ───────────────────────────────────────────────
  const contextActions: ContextMenuActions = {
    onRename: (path) => setRenamingPath(path),
    onDelete: (paths) => setDeleteCandidate(paths),
    onNewFile: (parentDir) => setCreating({ type: 'file', parentDir }),
    onNewDir: (parentDir) => setCreating({ type: 'dir', parentDir }),
  };

  // ── 提交 / 取消 handlers ───────────────────────────────────────────
  const submitRename = async (oldPath: string, newName: string) => {
    setRenamingPath(null);
    const r = await renameItem(oldPath, newName, mutateDeps, treeApi);
    if (!r.ok) {
      // MVP:alert 临时兜底,后续接 toast 库
      alert(`重命名失败:[${r.code}] ${r.message}`);
    }
  };

  const submitCreate = async (name: string) => {
    if (!creating) return;
    const { type, parentDir } = creating;
    setCreating(null);
    const action = type === 'dir' ? createNewDir : createNewFile;
    const r = await action(parentDir, name, mutateDeps, treeApi);
    if (!r.ok) {
      alert(`新建失败:[${r.code}] ${r.message}`);
    }
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

  // ── 渲染 ───────────────────────────────────────────────────────────
  const blankAreaActions = contextActions; // 空白区也走同一套(target 传 null)

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
        actions={blankAreaActions}
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
                    renamingPath={renamingPath}
                    onRenameSubmit={submitRename}
                    onRenameCancel={() => setRenamingPath(null)}
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
