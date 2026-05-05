import { useCallback, useMemo, useRef, useState } from 'react';
import { useTree } from '@headless-tree/react';
import { useVirtualizer } from '@tanstack/react-virtual';
import type { ItemInstance, TreeInstance } from '@headless-tree/core';
import type { FileEntry } from '@/lib/fs/types';
import { useExplorerStore } from '@/stores/explorer.store';
import { ConfirmDialog } from './ConfirmDialog';
import { ContextMenu, type ContextMenuActions } from './ContextMenu';
import { CreateInput } from './CreateInput';
import { DropOverlay } from './DropOverlay';
import { ExplorerHeader } from './ExplorerHeader';
import { createTreeConfig } from './tree-config';
import { FILE_ROW_HEIGHT, FileRow } from './FileRow';
import {
  createNewDir,
  createNewFile,
  removeItems,
  renameItem,
} from './mutate-actions';
import {
  partitionDropItems,
  performDrop,
  resolveDropTarget,
  type DropTargetEntry,
} from './drop-handlers';
import { useFsWatcher } from './hooks/useFsWatcher';
import { useEditorFile } from '@/panels/Editor/useEditorFile';
import { lmApi } from '@/lib/lm-api';

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
  // dnd 状态:hoverTarget 由 FileRow onDragEnter 回报;dragDepth 用计数器
  // 防止 child enter/leave 误清(每次 enter +1,leave -1,归零才真离开)
  const [hoverTarget, setHoverTarget] = useState<DropTargetEntry | null>(null);
  const dragDepthRef = useRef(0);
  const [dragActive, setDragActive] = useState(false);

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
        fs: lmApi.fs,
        onRename: (item: ItemInstance<FileEntry>, newName: string) => {
          // headless-tree onRename 是 sync 签名,我们 fire-and-forget 走 mutate-actions
          void (async () => {
            const r = await renameItem(
              item.getId(),
              newName,
              { fs: lmApi.fs },
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
  const mutateDeps = { fs: lmApi.fs };

  // Explorer ↔ Editor 联动(Step E5):单击文件 → openFileByPath
  const { openFileByPath } = useEditorFile();
  const handleFileOpen = useCallback(
    async (path: string) => {
      const r = await openFileByPath(path);
      if (!r.ok) {
        // eslint-disable-next-line no-console
        console.warn('[explorer] open file failed:', r.code, r.message);
      }
    },
    [openFileByPath],
  );

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

  // ── Drop 上传(Step 5d) ───────────────────────────────────────
  const dropTargetDir = resolveDropTarget(hoverTarget, root);

  const handleDragEnter = (e: React.DragEvent) => {
    if (!e.dataTransfer.types.includes('Files')) return;
    dragDepthRef.current += 1;
    if (!dragActive) setDragActive(true);
  };
  const handleDragOver = (e: React.DragEvent) => {
    if (!e.dataTransfer.types.includes('Files')) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
  };
  const handleDragLeave = (e: React.DragEvent) => {
    if (!e.dataTransfer.types.includes('Files')) return;
    dragDepthRef.current -= 1;
    if (dragDepthRef.current <= 0) {
      dragDepthRef.current = 0;
      setDragActive(false);
      setHoverTarget(null);
    }
  };
  const handleDrop = async (e: React.DragEvent) => {
    if (!e.dataTransfer.types.includes('Files')) return;
    e.preventDefault();
    dragDepthRef.current = 0;
    setDragActive(false);
    const target = resolveDropTarget(hoverTarget, root);
    setHoverTarget(null);
    const { files, skippedDirs } = partitionDropItems(e.dataTransfer.items);
    if (files.length === 0 && skippedDirs.length === 0) return;
    const r = await performDrop(files, target, lmApi.fs);
    refreshParent(target);
    // 仅在有问题时提示;成功 fs.watch 已自动刷新树
    const msgs: string[] = [];
    if (skippedDirs.length > 0) {
      msgs.push(`跳过 ${skippedDirs.length} 个文件夹(暂不支持目录拖入)`);
    }
    if (!r.ok) {
      msgs.push(
        `失败 ${r.failed.length} 个:\n` +
          r.failed.map((f) => `  ${f.name}: [${f.code}] ${f.message}`).join('\n'),
      );
    }
    if (msgs.length > 0) alert(msgs.join('\n\n'));
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
    <div
      className="relative flex h-full w-full flex-col"
      onDragEnter={handleDragEnter}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      <ExplorerHeader
        root={root}
        onExpandAll={() => {
          // 异步,大目录会触发大量 listDir;用户主动行为,不防抖
          void tree.expandAll();
        }}
        onCollapseAll={() => tree.collapseAll()}
      />
      {dragActive && <DropOverlay targetDir={dropTargetDir} />}
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
          className="min-h-0 flex-1 overflow-auto bg-canvas"
        >
          {items.length === 0 ? (
            <div className="p-4 text-xs text-fg-dim">
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
                    onHoverDropTarget={setHoverTarget}
                    isDropHover={
                      dragActive && hoverTarget?.path === item.getId()
                    }
                    onFileOpen={handleFileOpen}
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
              将 <code className="text-fg">{deleteCandidate[0]}</code> 移到系统回收站?
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
