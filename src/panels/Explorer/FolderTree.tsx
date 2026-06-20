import { useCallback, useMemo, useRef, useState } from 'react';
import { useTree } from '@headless-tree/react';
import { useVirtualizer } from '@tanstack/react-virtual';
import type { ItemInstance, SetStateFn, TreeInstance } from '@headless-tree/core';
import type { FileEntry } from '@/lib/fs/types';
import { TERMINAL_PANEL_TYPE } from '@/panels/Terminal/constants';
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
import { useEditorStore } from '@/stores/editor.store';
import { useExplorerStore } from '@/stores/explorer.store';
import { coApi } from '@/lib/co-api';
import { notify } from '@/notifications/notify';
import { getCachedClipboard } from '@/plugins/sandbox-sweep';
import { useSettingValue } from '@/plugins/settings/values-store';
import { useTheme } from '@/theme';
import { useExplorerClipboardStore } from './clipboard-store';
import { t, useT } from '@/i18n';

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

function isWithinRoot(path: string, root: string): boolean {
  const normalizedRoot = root.replace(/[\\/]+$/, '') || root;
  if (normalizedRoot === '/') return path.startsWith('/');
  return (
    path === normalizedRoot ||
    path.startsWith(`${normalizedRoot}/`) ||
    path.startsWith(`${normalizedRoot}\\`)
  );
}

export function FolderTree({ root }: { root: string }) {
  const tt = useT();
  // tree ref:onRename callback 在 useMemo 里引用,需要稳定 handle 拿到最新 tree
  const treeRef = useRef<TreeInstance<FileEntry> | null>(null);
  const { resolved: theme } = useTheme();
  const [creating, setCreating] = useState<CreatingState | null>(null);
  // dnd 状态:hoverTarget 由 FileRow onDragEnter 回报;dragDepth 用计数器
  // 防止 child enter/leave 误清(每次 enter +1,leave -1,归零才真离开)
  const [hoverTarget, setHoverTarget] = useState<DropTargetEntry | null>(null);
  const dragDepthRef = useRef(0);
  const [dragActive, setDragActive] = useState(false);
  const persistedExpandedPaths = useExplorerStore((s) => s.expandedPaths);
  const setPersistedExpandedPaths = useExplorerStore((s) => s.setExpandedPaths);
  const expandedItems = useMemo(() => {
    const next = new Set<string>([root]);
    for (const path of persistedExpandedPaths) {
      if (isWithinRoot(path, root)) next.add(path);
    }
    return [...next];
  }, [persistedExpandedPaths, root]);
  const setExpandedItems = useCallback<SetStateFn<string[]>>(
    (updater) => {
      // expandedPaths 是跨 root 共享的单一 Set;headless-tree 只看到 isWithinRoot
      // 过滤后的 in-root 子集,回写也只给 in-root 路径。直接整体替换会丢掉其它 root
      // 的展开状态(切 root 后第一次折叠/展开即触发)。保留 out-of-root 段,只更新
      // in-root 段;函数 updater 也喂 in-root 子集(与 headless-tree 视图一致)。见 P2-AF。
      const all = [...useExplorerStore.getState().expandedPaths];
      const inRootCurrent = all.filter((p) => isWithinRoot(p, root));
      const outOfRoot = all.filter((p) => !isWithinRoot(p, root));
      const next =
        typeof updater === 'function' ? updater(inRootCurrent) : updater;
      setPersistedExpandedPaths([...outOfRoot, ...next]);
    },
    [setPersistedExpandedPaths, root],
  );

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
            const oldPath = item.getId();
            const r = await renameItem(
              oldPath,
              newName,
              { fs: coApi.fs },
              { invalidateChildrenIds: refreshParent },
            );
            if (!r.ok) {
              notify.error(r.message, { code: r.code });
              return;
            }
            // 同步打开的 editor tab 路径(目录 rename 时其下所有 tab 也会前缀 rewrite)
            useEditorStore.getState().renamePath(oldPath, r.newPath);
            // 改名后旧路径已不存在 → 剪除剪贴板里引用旧路径的 cut/copy 项。
            useExplorerClipboardStore.getState().prune([oldPath]);
          })();
        },
        // 内部多选拖动 → 批量 fs.move,语义同 cut→paste(但不经剪贴板)
        onDropItems: (items, destDir) => {
          void (async () => {
            const srcs = items.map((it) => it.getId());
            // 记录已成功移动项涉及的源父目录。即使中途某项失败提前中止,也要在
            // finally 里刷新这些目录 + destDir,否则已移动文件会在树上凭空消失
            // (源目录没刷=还显示,目标目录没刷=不显示),而其 editor tab 路径已改 →
            // 树/tab/磁盘三者不一致。对齐 mutate-actions.removeItems 的部分成功刷新。
            const touchedSrcParents = new Set<string>();
            const movedSrcs: string[] = [];
            let movedAny = false;
            try {
              for (const src of srcs) {
                // 拖到原父目录 → no-op(canDrop 已挡掉拖到自身,父同位置只跳)
                if (dirname(src) === destDir) continue;
                const dest = await pickUniqueDest(destDir, basename(src));
                const r = await coApi.fs.move(src, dest);
                if (!r.ok) {
                  console.warn('[explorer] drop move failed', src, r.code, r.message);
                  notify.error(
                    t('errors.folder.move_failed', { src, message: r.message }),
                    { code: r.code, mirror: false },
                  );
                  return;
                }
                useEditorStore.getState().renamePath(src, dest);
                touchedSrcParents.add(dirname(src));
                movedSrcs.push(src);
                movedAny = true;
              }
            } finally {
              if (movedAny) {
                refreshParent(destDir);
                for (const sp of touchedSrcParents) {
                  if (sp !== destDir) refreshParent(sp);
                }
                // 移走的源旧路径已不存在 → 剪除剪贴板里引用它的 cut/copy 项。
                useExplorerClipboardStore.getState().prune(movedSrcs);
              }
            }
          })();
        },
        // 外部 OS 文件 drop 到具体 row → 走与容器 onDrop 同一套 performDrop
        onDropForeign: (dataTransfer, destDir) => {
          void (async () => {
            const { files, skippedDirs } = partitionDropItems(dataTransfer.items);
            if (files.length === 0 && skippedDirs.length === 0) return;
            const r = await performDrop(files, destDir, coApi.fs);
            refreshParent(destDir);
            const msgs: string[] = [];
            if (skippedDirs.length > 0) {
              msgs.push(
                t('errors.folder.skipped_dirs', { count: skippedDirs.length }),
              );
            }
            if (!r.ok) {
              msgs.push(
                t('errors.folder.batch_failed', { count: r.failed.length }) +
                  '\n' +
                  r.failed.map((f) => `  ${f.name}: [${f.code}] ${f.message}`).join('\n'),
              );
            }
            msgs.forEach((m) => notify.error(m));
          })();
        },
        expandedItems,
        setExpandedItems,
      }),
    [expandedItems, root, setExpandedItems],
  );
  const tree = useTree<FileEntry>(config);
  treeRef.current = tree;

  const allItems = tree.getItems();
  // explorer.showHiddenFiles=false(默认)过滤 . 开头的 entries(.git / .env 等)
  const showHidden = useSettingValue<boolean>(
    'explorer.showHiddenFiles',
    false,
  );
  const items = useMemo(
    () =>
      showHidden
        ? allItems
        : allItems.filter((it) => !it.getItemData().name.startsWith('.')),
    [allItems, showHidden],
  );

  // 多选集合数据源 = headless-tree selectionFeature 真实状态。
  // 不再读 explorer.store.selectedPaths(从未被同步,留 cleanup 单独提交)。
  // 数组引用变 → Set 重建;Click/Cmd-Click/Shift-Click 由 selectionFeature 内部
  // 维护,任何变化都会引起组件重渲,Set 自动跟新。
  const selectedItemsArr = tree.getState().selectedItems;
  const selectedPaths = useMemo<ReadonlySet<string>>(
    () => new Set(selectedItemsArr ?? []),
    [selectedItemsArr],
  );

  // ── fs.watch 增量更新(Step 6) ───────────────────────────────────
  // 跟随 headless-tree 受控展开集合,同步到 main 进程 watcher。
  const expandedPaths = useMemo(() => new Set(expandedItems), [expandedItems]);
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
        // 点击文件是 Explorer 的主操作,打开失败(外部删除/权限/损坏)必须给反馈,
        // 不再静默 —— 否则用户"点了没反应"。trash/paste/move 已有 notify,补齐 open。
        // 见第二十一轮 P1-AX。
        console.warn('[explorer] open file failed:', r.code, r.message);
        notify.error(
          `${t('quick_open.open_failed')} ${basename(path)}: ${r.message ?? r.code}`,
          { code: r.code, mirror: false },
        );
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
    onCopyPath: (paths: string[]) => {
      // 多选 → \n 拼接;空数组(防御性)→ 不动.
      // 走 cached clipboard:PROD sandboxSweep 后 navigator.clipboard 已被涂掉,
      // LM UI 自身必须用 module 顶部缓存的 raw ref 才能写系统剪贴板.
      if (paths.length === 0) return;
      void getCachedClipboard()
        .writeText(paths.join('\n'))
        .catch((err) => {
          console.warn('[explorer] copy path failed', err);
        });
    },
    onCopyRelativePath: (paths: string[]) => {
      if (paths.length === 0) return;
      const rels = paths.map(stripRoot).join('\n');
      void getCachedClipboard()
        .writeText(rels)
        .catch((err) => {
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
      // COLORFGBG 让 P10k 等 prompt 框架启动时检测到当前主题亮度
      // —— 已在跑的 PTY 不会因主题切换而重渲。
      void (async () => {
        const r = await coApi.terminal.create({
          cwd: dir,
          env: { COLORFGBG: theme === 'dark' ? '15;0' : '0;15' },
          // 归属当前 workspace(虽然 cwd 是子目录),便于跨 workspace 切换时
          // 该 terminal 跟随显示/隐藏。
          workspaceRoot: root,
        });
        if (!r.ok) {
          console.warn('[explorer] open in terminal failed', r.code, r.message);
          notify.error(r.message, { code: r.code, mirror: false });
          return;
        }
        // 动态 import dock-api-ref 防早期加载循环
        const { openOrFocusPanel } = await import('@/shell/dock/dock-api-ref');
        openOrFocusPanel(
          TERMINAL_PANEL_TYPE,
          TERMINAL_PANEL_TYPE,
          'Terminal',
          'panels.terminal.title',
        );
      })();
    },
    onTrash: (paths: string[]) => {
      void (async () => {
        // 走规范的 mutate-actions.removeItems(遍历全部项、收集所有失败、刷新所有
        // 成功项父目录),而非内联首失早退 —— 旧实现一旦某项 trash 失败就 return,
        // 静默跳过其余选中项(多选删除时后续项既不删也不报错)。removeItems 是
        // 纯 fs+tree helper(已测,且本为唯一生产 trash 路径却从未被调用),editor
        // tab 关闭(removePath)仍由本处对成功项补做。见第七 session R6 完整性批判。
        const result = await removeItems(paths, { trash: true }, mutateDeps, treeApi);
        const failed = new Set(result.ok ? [] : result.failures.map((f) => f.path));
        const removed: string[] = [];
        for (const p of paths) {
          // 文件删除 → 关闭对应 editor tab(目录则关其下所有 tab)。仅对成功项。
          if (!failed.has(p)) {
            useEditorStore.getState().removePath(p);
            removed.push(p);
          }
        }
        // 删除的源若在剪贴板里(cut/copy 后又删),剪除避免幻影 cut 灰显 + 失效 Paste。
        if (removed.length > 0) {
          useExplorerClipboardStore.getState().prune(removed);
        }
        if (!result.ok) {
          for (const f of result.failures) {
            console.warn('[explorer] trash failed', f.path, f.code, f.message);
            notify.error(
              t('errors.folder.trash_failed', { path: f.path, message: f.message }),
              { code: f.code, mirror: false },
            );
          }
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
        // 记录已成功 cut 移动项的源父目录 + 是否有成功项。即使中途失败提前中止,
        // 也要在 finally 刷新已成功项涉及的目录,否则已移动/复制文件在树上不显示
        // 而 editor tab 路径已改 → 三者不一致(同 onDropItems 的修复)。
        const touchedSrcParents = new Set<string>();
        const movedSrcs: string[] = [];
        let okAny = false;
        try {
          for (const src of paths) {
            // 计算 dest:destDir + src basename;若已存在,自动加 ` copy` 后缀
            const dest = await pickUniqueDest(destDir, basename(src));
            const r =
              kind === 'cut'
                ? await coApi.fs.move(src, dest)
                : await coApi.fs.copy(src, dest);
            if (!r.ok) {
              console.warn(`[explorer] paste(${kind}) failed`, src, r.code, r.message);
              notify.error(
                t('errors.folder.paste_failed', { src, message: r.message }),
                { code: r.code, mirror: false },
              );
              return;
            }
            // cut = move:同步 editor tab 路径(目录则前缀 rewrite 全部子 tab)
            if (kind === 'cut') {
              useEditorStore.getState().renamePath(src, dest);
              touchedSrcParents.add(dirname(src));
              movedSrcs.push(src);
            }
            okAny = true;
          }
        } finally {
          // cut 是 move:已成功移走的源旧路径已失效,从剪贴板剪除。全成功 → 剪空(等价
          // 原 clear());**部分成功 → 只剪走已移走的,保留未移项供重试**。此前只在 allOk
          // 时 clear,部分成功把已移走的幻影源留在剪贴板(灰显 + 失效 Paste)——与兄弟
          // onDropItems/root-drop 的 finally prune(movedSrcs) 不对等(第八 session R7 完整性
          // 批判揪出的同族遗漏入口)。copy 不动源,不剪。
          if (kind === 'cut' && movedSrcs.length > 0) {
            useExplorerClipboardStore.getState().prune(movedSrcs);
          }
          if (okAny) {
            // 触发树刷新:目标父目录 invalidate
            treeApi.invalidateChildrenIds(destDir);
            // cut 时已成功移动项的源父目录也要刷新(文件不在源了)
            if (kind === 'cut') {
              for (const sp of touchedSrcParents) treeApi.invalidateChildrenIds(sp);
            }
          }
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
    if (!r.ok) notify.error(r.message, { code: r.code });
  };

  // ── Drop 上传(Step 5d) ───────────────────────────────────────
  const dropTargetDir = resolveDropTarget(hoverTarget, root);

  const handleDragEnter = (e: React.DragEvent) => {
    if (!e.dataTransfer.types.includes('Files')) return;
    dragDepthRef.current += 1;
    if (!dragActive) setDragActive(true);
  };
  const handleDragOver = (e: React.DragEvent) => {
    if (e.dataTransfer.types.includes('Files')) {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
      return;
    }
    // 内部 drag drop 到空白(root level)— root row 不渲染,headless-tree
    // 接不到,需要容器 div 自己 preventDefault 把空白也变成有效 drop target
    const dnd = tree.getState().dnd;
    if (dnd?.draggedItems && dnd.draggedItems.length > 0) {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
    }
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
    // 内部 drag drop 到空白(root level)— headless-tree row onDrop 接不到 root row
    if (!e.dataTransfer.types.includes('Files')) {
      const dnd = tree.getState().dnd;
      if (!dnd?.draggedItems || dnd.draggedItems.length === 0) return;
      e.preventDefault();
      const items = dnd.draggedItems.slice();
      // 同步清掉 dnd 状态,避免后续 dragend 处理脏状态
      const srcs = items.map((it) => it.getId());
      // 已经在 root 下的不动(VSCode 同款)
      const moveable = srcs.filter((s) => dirname(s) !== root);
      if (moveable.length === 0) return;
      // 与 onDropItems/onPaste 同款部分成功刷新(README P2-BB):中途某项失败提前
      // 中止时,已成功移动项也要在 finally 刷新源父目录 + root,否则已移走的文件在
      // 树上凭空消失(源没刷=还显示,root 没刷=不显示)而其 editor tab 路径已改 →
      // 树/tab/磁盘三者不一致。此前 P2-BB 只修了 onDropItems/onPaste 两个兄弟调用点,
      // 漏了这个 root-drop 分支(「修复未传播到平行调用点」)。
      const touchedSrcParents = new Set<string>();
      const movedSrcs: string[] = [];
      let movedAny = false;
      try {
        for (const src of moveable) {
          const dest = await pickUniqueDest(root, basename(src));
          const r = await coApi.fs.move(src, dest);
          if (!r.ok) {
            console.warn('[explorer] root drop move failed', src, r.code, r.message);
            notify.error(
              t('errors.folder.move_failed', { src, message: r.message }),
              { code: r.code, mirror: false },
            );
            return;
          }
          useEditorStore.getState().renamePath(src, dest);
          touchedSrcParents.add(dirname(src));
          movedSrcs.push(src);
          movedAny = true;
        }
      } finally {
        if (movedAny) {
          refreshParent(root);
          for (const sp of touchedSrcParents) {
            if (sp !== root) refreshParent(sp);
          }
          // 移走的源旧路径已不存在 → 剪除剪贴板里引用它的 cut/copy 项。
          useExplorerClipboardStore.getState().prune(movedSrcs);
        }
      }
      return;
    }
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
      msgs.push(t('errors.folder.skipped_dirs', { count: skippedDirs.length }));
    }
    if (!r.ok) {
      msgs.push(
        t('errors.folder.batch_failed', { count: r.failed.length }) +
          '\n' +
          r.failed.map((f) => `  ${f.name}: [${f.code}] ${f.message}`).join('\n'),
      );
    }
    msgs.forEach((m) => notify.error(m));
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
        onRefresh={() => {
          // 刷新 = invalidate 当前所有展开目录,触发重新 listDir。
          // 单点 invalidate(root)对 cache 中已 list 过的子目录无效,
          // 所以遍历 expandedItems 全部 invalidate 一遍。
          const expanded = tree.getState().expandedItems ?? [];
          // root 也算「已展开」(根 children 已 list),始终 invalidate
          for (const path of [root, ...expanded]) {
            try {
              const it = tree.getItemInstance(path);
              void it?.invalidateChildrenIds();
            } catch {
              // 节点已不存在(外部进程删了),跳过
            }
          }
        }}
        onNewFile={() => setCreating({ type: 'file', parentDir: root })}
        onNewDir={() => setCreating({ type: 'dir', parentDir: root })}
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
              {tt('panels.explorer.loading_or_empty')}
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
