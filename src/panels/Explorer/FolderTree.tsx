import { useCallback, useMemo, useRef, useState } from 'react';
import { useTree } from '@headless-tree/react';
import { useVirtualizer } from '@tanstack/react-virtual';
import type { ItemInstance, TreeInstance } from '@headless-tree/core';
import type { FileEntry } from '@/lib/fs/types';
import { useExplorerStore } from '@/stores/explorer.store';
import { ContextMenu, type ContextMenuActions } from './ContextMenu';
import { CreateInput } from './CreateInput';
import { DropOverlay } from './DropOverlay';
import { ExplorerHeader } from './ExplorerHeader';
import { createTreeConfig } from './tree-config';
import { FILE_ROW_HEIGHT, FileRow } from './FileRow';
import {
  createNewDir,
  createNewFile,
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
import { useEditorStore } from '@/stores/editor.store';
import { coApi } from '@/lib/co-api';
import { useExplorerClipboardStore } from './clipboard-store';

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
        fs: coApi.fs,
        onRename: (item: ItemInstance<FileEntry>, newName: string) => {
          // headless-tree onRename 是 sync 签名,我们 fire-and-forget 走 mutate-actions
          void (async () => {
            const r = await renameItem(
              item.getId(),
              newName,
              { fs: coApi.fs },
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
  const mutateDeps = { fs: coApi.fs };

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

  const hasClipboard = useExplorerClipboardStore(
    (s) => s.kind !== null && s.paths.length > 0,
  );

  const stripRoot = (p: string): string => {
    const prefix = root.endsWith('/') ? root : `${root}/`;
    return p.startsWith(prefix) ? p.slice(prefix.length) : p;
  };

  const contextActions: ContextMenuActions = {
    onRename: (path) => tree.getItemInstance(path)?.startRenaming(),
    onNewFile: (parentDir) => setCreating({ type: 'file', parentDir }),
    onNewDir: (parentDir) => setCreating({ type: 'dir', parentDir }),
    onCopyPath: (path: string) => {
      void navigator.clipboard.writeText(path).catch((err) => {
        console.warn('[explorer] copy path failed', err);
      });
    },
    onCopyRelativePath: (path: string) => {
      void navigator.clipboard.writeText(stripRoot(path)).catch((err) => {
        console.warn('[explorer] copy relative path failed', err);
      });
    },
    onRevealInFinder: (path: string) => {
      void coApi.fs.reveal(path).then((r) => {
        if (!r.ok) console.warn('[explorer] reveal failed', r.code, r.message);
      });
    },
    onOpenInTerminal: (dir: string) => {
      // 新建 terminal session,cwd 设到该目录;sessions_changed 推送会自动
      // 触发 TerminalPanel 切到新 session(activeId 设)。打开 dockview
      // terminal panel 让用户立即看到。
      void (async () => {
        const r = await coApi.terminal.create({ cwd: dir });
        if (!r.ok) {
          console.warn('[explorer] open in terminal failed', r.code, r.message);
          alert(`新建终端失败:[${r.code}] ${r.message}`);
          return;
        }
        // 动态 import dock-api-ref 防早期加载循环
        const { openOrFocusPanel } = await import('@/shell/dock/dock-api-ref');
        openOrFocusPanel('terminal', 'terminal', 'Terminal');
      })();
    },
    onTrash: (paths: string[]) => {
      void (async () => {
        for (const p of paths) {
          const r = await coApi.fs.trash(p);
          if (!r.ok) {
            console.warn('[explorer] trash failed', p, r.code, r.message);
            alert(`移到废纸篓失败:${p}\n[${r.code}] ${r.message}`);
            return;
          }
          // 文件删除 → 关闭对应 editor tab(目录则关其下所有 tab)
          useEditorStore.getState().removePath(p);
        }
      })();
    },
    onCut: (paths: string[]) => {
      useExplorerClipboardStore.getState().set('cut', paths);
    },
    onCopy: (paths: string[]) => {
      useExplorerClipboardStore.getState().set('copy', paths);
    },
    onPaste: (destDir: string) => {
      void (async () => {
        const { kind, paths } = useExplorerClipboardStore.getState();
        if (!kind || paths.length === 0) return;
        for (const src of paths) {
          // 计算 dest:destDir + src basename;若已存在,自动加 ` copy` 后缀
          const dest = await pickUniqueDest(destDir, basename(src));
          const r =
            kind === 'cut'
              ? await coApi.fs.move(src, dest)
              : await coApi.fs.copy(src, dest);
          if (!r.ok) {
            console.warn(`[explorer] paste(${kind}) failed`, src, r.code, r.message);
            alert(`粘贴失败:${src}\n[${r.code}] ${r.message}`);
            return;
          }
        }
        // cut 用完即清(避免重复 move 同一文件);copy 保留(允许多次粘贴)
        if (kind === 'cut') {
          useExplorerClipboardStore.getState().clear();
        }
        // 触发树刷新:目标父目录 invalidate
        treeApi.invalidateChildrenIds(destDir);
        // cut 时源父目录也要刷新(文件不在源了)
        if (kind === 'cut') {
          const srcParents = new Set(paths.map((p) => dirname(p)));
          for (const sp of srcParents) treeApi.invalidateChildrenIds(sp);
        }
      })();
    },
  };

  function basename(p: string): string {
    const idx = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'));
    return idx >= 0 ? p.slice(idx + 1) : p;
  }

  // 在 destDir 下找一个不存在的路径名:basename / `${stem} copy${ext}` /
  // `${stem} copy 2${ext}` / ... 上限 100 次。复用 main 端 resolveUniqueDest
  // 同款逻辑(renderer 侧 listDir 探测,避免每次都打 IPC 多次)。
  async function pickUniqueDest(destDir: string, name: string): Promise<string> {
    const dot = name.lastIndexOf('.');
    const stem = dot > 0 ? name.slice(0, dot) : name;
    const ext = dot > 0 ? name.slice(dot) : '';
    // 先列目录拿现有 basename 集合(IPC 一次,后续纯本地匹配)
    const r = await coApi.fs.listDir(destDir);
    const existing = new Set<string>();
    if (r.ok) {
      for (const e of r.data) existing.add(e.name);
    }
    for (let i = 0; i < 100; i++) {
      const candidate =
        i === 0 ? name : i === 1 ? `${stem} copy${ext}` : `${stem} copy ${i}${ext}`;
      if (!existing.has(candidate)) {
        return `${destDir}/${candidate}`;
      }
    }
    // 极端情况兜底:加时间戳
    return `${destDir}/${stem}-${Date.now()}${ext}`;
  }

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
    const r = await performDrop(files, target, coApi.fs);
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
        hasClipboard={hasClipboard}
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

    </div>
  );
}
