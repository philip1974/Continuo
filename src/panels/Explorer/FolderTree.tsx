import { useCallback, useMemo, useRef, useState } from 'react';
import { hasFiles } from '@/lib/window-drop'; // 边界(E225):共享早停 hasFiles
import { basenamePreserveTrailing, dirname } from './path-utils';
import { joinPath, stripRootPrefix, isSameOrInsidePath } from '@/lib/path-cross';
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
import { DEFAULT_INDENT, FILE_ROW_HEIGHT, FileRow } from './FileRow';
import { createNewDir, createNewFile, removeItems, renameItem } from './mutate-actions';
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
import { copyToClipboardOrNotify } from './copy-to-clipboard';
import { revealPathOrNotify } from './reveal-or-notify';
import { useSettingValue } from '@/plugins/settings/values-store';
import { coApp } from '@/plugins/co-app';
import { useRegistry } from '@/plugins/registries/useRegistry';
import { useTheme } from '@/theme';
import { useExplorerClipboardStore } from './clipboard-store';
import { t, useT } from '@/i18n';
import { localizeErrorByCode } from '@/lib/localize-error';

interface CreatingState {
  type: 'file' | 'dir';
  parentDir: string;
}

const EMPTY_SELECTED_PATHS: ReadonlySet<string> = new Set();
const EMPTY_EXPANDED_ITEMS: readonly string[] = [];
const EMPTY_PATH_LIST: string[] = [];

// 跨平台(codex 复查 P2):复用单一来源 path-cross.isSameOrInsidePath —— 此前手写
// startsWith 对 Windows 大小写敏感,持久化的 expandedPaths(`C:\Repo\src`)与 root
// (`c:\repo`)仅大小写不同时被判 out-of-root → 树恢复展开错乱/旧展开项滞留。
function isWithinRoot(path: string, root: string): boolean {
  return isSameOrInsidePath(root, path);
}

export function joinRelativePaths(root: string, paths: readonly string[]): string {
  let out = '';
  for (let i = 0; i < paths.length; i++) {
    if (i > 0) out += '\n';
    out += stripRootPrefix(root, paths[i]!);
  }
  return out;
}

export function selectVisibleTreeItems(
  allItems: readonly ItemInstance<FileEntry>[],
  showHidden: boolean,
): readonly ItemInstance<FileEntry>[] {
  if (showHidden) return allItems;

  let items: ItemInstance<FileEntry>[] | null = null;
  let count = 0;
  for (let i = 0; i < allItems.length; i++) {
    const item = allItems[i]!;
    if (item.getItemData().name.startsWith('.')) {
      if (items === null) {
        items = new Array<ItemInstance<FileEntry>>(allItems.length);
        for (let j = 0; j < i; j++) items[j] = allItems[j]!;
        count = i;
      }
      continue;
    }
    if (items !== null) items[count++] = item;
  }
  if (items === null) return allItems;
  items.length = count;
  return items;
}

export function selectRootDropMoveablePaths(
  draggedItems: readonly Pick<ItemInstance<FileEntry>, 'getId'>[],
  root: string,
): string[] {
  if (draggedItems.length === 0) return EMPTY_PATH_LIST;
  const moveable = new Array<string>(draggedItems.length);
  let count = 0;
  for (const item of draggedItems) {
    const src = item.getId();
    if (dirname(src) !== root) moveable[count++] = src;
  }
  if (count === 0) return EMPTY_PATH_LIST;
  moveable.length = count;
  return moveable;
}

export function selectDraggedItemPaths(
  draggedItems: readonly Pick<ItemInstance<FileEntry>, 'getId'>[],
): string[] {
  if (draggedItems.length === 0) return EMPTY_PATH_LIST;
  const paths = new Array<string>(draggedItems.length);
  for (let i = 0; i < draggedItems.length; i++) {
    paths[i] = draggedItems[i]!.getId();
  }
  return paths;
}

export function buildSelectedPathSet(
  selectedItems: readonly string[] | undefined,
): ReadonlySet<string> {
  if (!selectedItems || selectedItems.length === 0) return EMPTY_SELECTED_PATHS;
  return new Set(selectedItems);
}

interface DropFailureLine {
  readonly name: string;
  readonly code: string;
  readonly message: string;
}

export function formatDropFailureLines(failed: readonly DropFailureLine[]): string {
  let out = '';
  for (let i = 0; i < failed.length; i += 1) {
    const f = failed[i]!;
    if (i > 0) out += '\n';
    out += `  ${f.name}: [${f.code}] ${localizeErrorByCode(f.code, f.message)}`;
  }
  return out;
}

/**
 * 纯唯一名 picker:给定 destDir 与已存在 basename 集合,返回一个 pick(name) 函数。
 * 候选序:basename / `${stem} copy${ext}` / `${stem} copy 2${ext}` / ...(上限 100,
 * 兜底加时间戳)。**每次 pick 把选中的候选名加进 existing**,故同一批次内多个同名项
 * 不会都选到同一个 ` copy` 名(批量重名碰撞 → 第二个 move 覆盖第一个的潜在数据丢失)。
 * 抽成模块级纯函数以便单测;makeUniqueDestPicker 先 listDir 一次再委托它。
 */
export function makeNamePicker(destDir: string, existing: Set<string>): (name: string) => string {
  return (name: string): string => {
    const dot = name.lastIndexOf('.');
    const stem = dot > 0 ? name.slice(0, dot) : name;
    const ext = dot > 0 ? name.slice(dot) : '';
    for (let i = 0; i < 100; i++) {
      const candidate = i === 0 ? name : i === 1 ? `${stem} copy${ext}` : `${stem} copy ${i}${ext}`;
      if (!existing.has(candidate)) {
        existing.add(candidate); // 预留,防同批后续项再撞同名
        return joinPath(destDir, candidate);
      }
    }
    const fallback = `${stem}-${Date.now()}${ext}`;
    existing.add(fallback);
    return joinPath(destDir, fallback);
  };
}

export function FolderTree({ root }: { root: string }) {
  const tt = useT();
  // tree ref:onRename callback 在 useMemo 里引用,需要稳定 handle 拿到最新 tree
  const treeRef = useRef<TreeInstance<FileEntry> | null>(null);
  // a11y(A148):tree listDir 失败(root/子目录)此前仅 console.warn(FolderTree 未传 onIpcWarn)
  // → 加载失败无反馈。但展开深树会触发多次 listDir,无差别弹会刷屏 —— 3s 限流(对齐 A144)。
  const lastIpcWarnAtRef = useRef(0);
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
    const items = new Array<string>(persistedExpandedPaths.size + 1);
    let count = 0;
    items[count++] = root;
    for (const path of persistedExpandedPaths) {
      if (path !== root && isWithinRoot(path, root)) items[count++] = path;
    }
    items.length = count;
    return items;
  }, [persistedExpandedPaths, root]);
  const setExpandedItems = useCallback<SetStateFn<string[]>>(
    (updater) => {
      // expandedPaths 是跨 root 共享的单一 Set;headless-tree 只看到 isWithinRoot
      // 过滤后的 in-root 子集,回写也只给 in-root 路径。直接整体替换会丢掉其它 root
      // 的展开状态(切 root 后第一次折叠/展开即触发)。保留 out-of-root 段,只更新
      // in-root 段;函数 updater 也喂 in-root 子集(与 headless-tree 视图一致)。见 P2-AF。
      // 单次分区(打磨 R8):原先 filter 两遍各跑一次 isWithinRoot,跨 root 累积
      // 集合越大重复扫描越明显。一次 for...of 分出 in/out-of-root,各分区内部
      // 顺序与原 filter 一致 → 行为等价(见 P2-AF 契约测试)。
      const expandedPaths = useExplorerStore.getState().expandedPaths;
      const inRootCurrent = new Array<string>(expandedPaths.size);
      const outOfRoot = new Array<string>(expandedPaths.size);
      let inRootCount = 0;
      let outOfRootCount = 0;
      for (const p of expandedPaths) {
        if (isWithinRoot(p, root)) {
          inRootCurrent[inRootCount++] = p;
        } else {
          outOfRoot[outOfRootCount++] = p;
        }
      }
      inRootCurrent.length = inRootCount;
      outOfRoot.length = outOfRootCount;
      const next = typeof updater === 'function' ? updater(inRootCurrent) : updater;
      if (outOfRoot.length === 0) {
        setPersistedExpandedPaths(next);
        return;
      }
      if (next.length === 0) {
        setPersistedExpandedPaths(outOfRoot);
        return;
      }
      const merged = new Array<string>(outOfRoot.length + next.length);
      let count = 0;
      for (const path of outOfRoot) merged[count++] = path;
      for (const path of next) merged[count++] = path;
      setPersistedExpandedPaths(merged);
    },
    [setPersistedExpandedPaths, root],
  );

  const refreshParent = useCallback((parentPath: string) => {
    try {
      const parentItem = treeRef.current?.getItemInstance(parentPath);
      parentItem?.invalidateChildrenIds();
    } catch {
      treeRef.current?.rebuildTree();
    }
  }, []);

  // 为「单批移动/复制到同一 destDir」建一个唯一名 picker:listDir 一次拿现有
  // basename 集合,之后每次 pick 纯本地匹配(打磨 R20→R21:批量循环原先逐项
  // listDir → N 次同目录 IPC,现降为 1 次)。pick 还把已分配的候选名加进集合,
  // 防同一批次内两个同名项各自只看到磁盘旧态、都选到同一个 ` copy` 名 → 第二个
  // move 覆盖第一个(批量重名碰撞,潜在数据丢失)。候选序:basename /
  // `${stem} copy${ext}` / `${stem} copy 2${ext}` / ... 上限 100 次,兜底加时间戳。
  const makeUniqueDestPicker = useCallback(
    async (destDir: string): Promise<(name: string) => string> => {
      const r = await coApi.fs.listDir(destDir);
      const existing = new Set<string>();
      if (r.ok) {
        for (const e of r.data) existing.add(e.name);
      }
      return makeNamePicker(destDir, existing);
    },
    [],
  );

  const config = useMemo(
    () =>
      createTreeConfig({
        root,
        fs: coApi.fs,
        // a11y(A148):listDir 失败 → console.warn(诊断)+ 限流 notify.error(用户/AT 可感知)。
        onIpcWarn: (message: string, code: string) => {
          console.warn('[explorer-tree]', message, code);
          const now = Date.now();
          if (now - lastIpcWarnAtRef.current < 3000) return;
          lastIpcWarnAtRef.current = now;
          notify.error(localizeErrorByCode(code, message), { code });
        },
        onRename: (item: ItemInstance<FileEntry>, newName: string) => {
          // headless-tree onRename 是 sync 签名,我们 fire-and-forget 走 mutate-actions
          void (async () => {
            const oldPath = item.getId();
            // a11y(A133,A50 同族):try/catch 包住 —— renameItem 的 fs.rename IPC reject 此前
            // 被 fire-and-forget void 丢弃(只处理 ok:false),键盘用户重命名异常时无反馈。
            try {
              const r = await renameItem(
                oldPath,
                newName,
                { fs: coApi.fs },
                { invalidateChildrenIds: refreshParent },
              );
              if (!r.ok) {
                notify.error(localizeErrorByCode(r.code, r.message), { code: r.code });
                return;
              }
              // 同步打开的 editor tab 路径(目录 rename 时其下所有 tab 也会前缀 rewrite)
              useEditorStore.getState().renamePath(oldPath, r.newPath);
              // 改名后旧路径已不存在 → 剪除剪贴板里引用旧路径的 cut/copy 项。
              useExplorerClipboardStore.getState().prune([oldPath]);
            } catch (err) {
              const code = (err as { code?: string })?.code ?? 'EXCEPTION';
              notify.error(localizeErrorByCode(code, (err as Error)?.message), { code });
            }
          })();
        },
        // 内部多选拖动 → 批量 fs.move,语义同 cut→paste(但不经剪贴板)
        onDropItems: (items, destDir) => {
          void (async () => {
            const srcs = selectDraggedItemPaths(items);
            // 记录已成功移动项涉及的源父目录。即使中途某项失败提前中止,也要在
            // finally 里刷新这些目录 + destDir,否则已移动文件会在树上凭空消失
            // (源目录没刷=还显示,目标目录没刷=不显示),而其 editor tab 路径已改 →
            // 树/tab/磁盘三者不一致。对齐 mutate-actions.removeItems 的部分成功刷新。
            const touchedSrcParents = new Set<string>();
            const movedSrcs = new Array<string>(srcs.length);
            let movedSrcCount = 0;
            let movedAny = false;
            try {
              // a11y(A134,A133 同族):makeUniqueDestPicker(目标名探测)与 move 循环都包进 try —
              // 此前 picker 在 try 外、move 只处理 !r.ok,IPC reject 直接丢到 unhandled promise,
              // 拖放移动失败无 toast/live 反馈。catch 统一 notify;finally 仍刷新已移动目录。
              const pickDest = await makeUniqueDestPicker(destDir);
              for (const src of srcs) {
                // 拖到原父目录 → no-op(canDrop 已挡掉拖到自身,父同位置只跳)
                if (dirname(src) === destDir) continue;
                const dest = pickDest(basenamePreserveTrailing(src));
                const r = await coApi.fs.move(src, dest);
                if (!r.ok) {
                  console.warn('[explorer] drop move failed', src, r.code, r.message);
                  notify.error(
                    t('errors.folder.move_failed', {
                      src,
                      message: localizeErrorByCode(r.code, r.message),
                    }),
                    { code: r.code, mirror: false },
                  );
                  return;
                }
                useEditorStore.getState().renamePath(src, dest);
                touchedSrcParents.add(dirname(src));
                movedSrcs[movedSrcCount++] = src;
                movedAny = true;
              }
            } catch (err) {
              const code = (err as { code?: string })?.code ?? 'EXCEPTION';
              notify.error(localizeErrorByCode(code, (err as Error)?.message), { code });
            } finally {
              if (movedAny) {
                refreshParent(destDir);
                for (const sp of touchedSrcParents) {
                  if (sp !== destDir) refreshParent(sp);
                }
                // 移走的源旧路径已不存在 → 剪除剪贴板里引用它的 cut/copy 项。
                movedSrcs.length = movedSrcCount;
                useExplorerClipboardStore.getState().prune(movedSrcs);
              }
            }
          })();
        },
        // 外部 OS 文件 drop 到具体 row → 走与容器 onDrop 同一套 performDrop
        onDropForeign: (dataTransfer, destDir) => {
          void (async () => {
            // a11y(A150,A141 同族):row 级外部文件 drop 的 fire-and-forget async 包 try/catch ——
            // performDrop 已恒返 DropResult(A137),但 partitionDropItems / refreshParent 仍可能抛,
            // 无 catch 则成 unhandled rejection 且批量错误无 toast/live region 反馈。
            try {
              const { files, skippedDirs } = partitionDropItems(dataTransfer.items);
              if (files.length === 0 && skippedDirs.length === 0) return;
              const r = await performDrop(files, destDir, coApi.fs);
              refreshParent(destDir);
              if (skippedDirs.length > 0) {
                notify.error(t('errors.folder.skipped_dirs', { count: skippedDirs.length }));
              }
              if (!r.ok) {
                notify.error(
                  t('errors.folder.batch_failed', { count: r.failed.length }) +
                    '\n' +
                    formatDropFailureLines(r.failed),
                );
              }
            } catch (err) {
              const code = (err as { code?: string })?.code ?? 'EXCEPTION';
              notify.error(localizeErrorByCode(code, (err as Error)?.message ?? code), {
                code,
              });
            }
          })();
        },
        expandedItems,
        setExpandedItems,
      }),
    [expandedItems, makeUniqueDestPicker, refreshParent, root, setExpandedItems],
  );
  const tree = useTree<FileEntry>(config);
  treeRef.current = tree;

  const allItems = tree.getItems();
  // explorer.showHiddenFiles=false(默认)过滤 . 开头的 entries(.git / .env 等)
  const showHidden = useSettingValue<boolean>('explorer.showHiddenFiles', false);
  const items = useMemo(() => selectVisibleTreeItems(allItems, showHidden), [allItems, showHidden]);

  // 多选集合数据源 = headless-tree selectionFeature 真实状态。
  // 不再读 explorer.store.selectedPaths(从未被同步,留 cleanup 单独提交)。
  // 数组引用变 → Set 重建;Click/Cmd-Click/Shift-Click 由 selectionFeature 内部
  // 维护,任何变化都会引起组件重渲,Set 自动跟新。
  const selectedItemsArr = tree.getState().selectedItems;
  const selectedPaths = useMemo<ReadonlySet<string>>(
    () => buildSelectedPathSet(selectedItemsArr),
    [selectedItemsArr],
  );

  // 插件装饰器 registry 一次订阅(打磨 R7):下传给每个 FileRow,避免虚拟列表
  // N 行各自 useRegistry(N 份订阅 + 插件启停时每行各取一次快照)。
  const decorators = useRegistry(coApp.explorerDecorators);
  // 插件右键菜单项 registry 一次订阅(打磨 R10):下传给根 ContextMenu 与每个
  // FileRow 的 ContextMenu,避免 N+1 份同质订阅。可见性仍由各菜单按上下文计算。
  const pluginMenuItems = useRegistry(coApp.explorerContextMenu);
  // explorer.indentSize 对整棵树一致,一次订阅后下传(打磨 R14),避免每个可见
  // FileRow 各订阅一份同值 setting。
  const indent = useSettingValue<number>('explorer.indentSize', DEFAULT_INDENT);

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

  const treeApi = useMemo(() => ({ invalidateChildrenIds: refreshParent }), [refreshParent]);
  const mutateDeps = useMemo(() => ({ fs: coApi.fs }), []);

  // Explorer ↔ Editor 联动(Step E5):单击文件 → openFileByPath
  const { openFileByPath } = useEditorFile();
  const handleFileOpen = useCallback(
    async (path: string) => {
      // a11y(A141 同族):openFileByPath 的 reject(抛错而非返回 {ok:false})此前未捕获 →
      // 行 onClick 的 fire-and-forget 调用变 unhandled rejection,点击文件打开异常时无反馈。
      // catch 复用 !r.ok 同款 open_failed 提示(code 取 err.code ?? 'EXCEPTION')。
      try {
        const r = await openFileByPath(path);
        if (!r.ok) {
          // 点击文件是 Explorer 的主操作,打开失败(外部删除/权限/损坏)必须给反馈,
          // 不再静默 —— 否则用户"点了没反应"。trash/paste/move 已有 notify,补齐 open。
          // 见第二十一轮 P1-AX。
          console.warn('[explorer] open file failed:', r.code, r.message);
          notify.error(
            `${t('quick_open.open_failed')} ${basenamePreserveTrailing(path)}: ${localizeErrorByCode(r.code, r.message ?? r.code)}`,
            { code: r.code, mirror: false },
          );
        }
      } catch (err) {
        const code = (err as { code?: string })?.code ?? 'EXCEPTION';
        console.warn('[explorer] open file rejected:', code, err);
        notify.error(
          `${t('quick_open.open_failed')} ${basenamePreserveTrailing(path)}: ${localizeErrorByCode(code, (err as Error)?.message)}`,
          { code, mirror: false },
        );
      }
    },
    [openFileByPath],
  );

  const hasClipboard = useExplorerClipboardStore((s) => s.kind !== null && s.paths.length > 0);

  const contextActions = useMemo<ContextMenuActions>(
    () => ({
      onRename: (path) => treeRef.current?.getItemInstance(path)?.startRenaming(),
      onNewFile: (parentDir) => setCreating({ type: 'file', parentDir }),
      onNewDir: (parentDir) => setCreating({ type: 'dir', parentDir }),
      onCopyPath: (paths: string[]) => {
        // 多选 → \n 拼接;空数组(防御性)→ 不动.
        // 走 cached clipboard:PROD sandboxSweep 后 navigator.clipboard 已被涂掉,
        // LM UI 自身必须用 module 顶部缓存的 raw ref 才能写系统剪贴板.
        if (paths.length === 0) return;
        // a11y(A48):剪贴板写失败须给可见+可播报反馈(toast),否则用户以为已复制(见 copy-to-clipboard.ts)。
        void copyToClipboardOrNotify(paths.join('\n'), tt('panels.explorer.copy_path_failed'));
      },
      onCopyRelativePath: (paths: string[]) => {
        if (paths.length === 0) return;
        const rels = joinRelativePaths(root, paths);
        void copyToClipboardOrNotify(rels, tt('panels.explorer.copy_path_failed'));
      },
      // a11y(A49,A47/A48 同族):reveal 失败须可见+可播报反馈(toast),不静默(见 reveal-or-notify.ts)。
      onRevealInFinder: (path: string) => {
        void revealPathOrNotify(path);
      },
      onOpenInTerminal: (dir: string) => {
        // 新建 terminal session,cwd 设到该目录;sessions_changed 推送会自动
        // 触发 TerminalPanel 切到新 session(activeId 设)。打开 dockview
        // terminal panel 让用户立即看到。
        // COLORFGBG 让 P10k 等 prompt 框架启动时检测到当前主题亮度
        // —— 已在跑的 PTY 不会因主题切换而重渲。
        void (async () => {
          // a11y(A140,A139 同族):fire-and-forget async 包 try/catch —— terminal.create()
          // 的 IPC reject(抛错而非返回 {ok:false})与动态 import dock-api-ref 的 reject 此前
          // 未捕获 → unhandled rejection,右键「在终端打开」失败时无 toast/live region 反馈。
          try {
            const r = await coApi.terminal.create({
              cwd: dir,
              env: { COLORFGBG: theme === 'dark' ? '15;0' : '0;15' },
              // 归属当前 workspace(虽然 cwd 是子目录),便于跨 workspace 切换时
              // 该 terminal 跟随显示/隐藏。
              workspaceRoot: root,
            });
            if (!r.ok) {
              console.warn('[explorer] open in terminal failed', r.code, r.message);
              notify.error(localizeErrorByCode(r.code, r.message), {
                code: r.code,
                mirror: false,
              });
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
          } catch (err) {
            const code = (err as { code?: string })?.code ?? 'EXCEPTION';
            notify.error(localizeErrorByCode(code, (err as Error)?.message), {
              code,
            });
          }
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
          const failed = new Set<string>();
          if (!result.ok) {
            for (const f of result.failures) failed.add(f.path);
          }
          const removed = new Array<string>(paths.length);
          let removedCount = 0;
          for (const p of paths) {
            // 文件删除 → 关闭对应 editor tab(目录则关其下所有 tab)。仅对成功项。
            if (!failed.has(p)) {
              useEditorStore.getState().removePath(p);
              removed[removedCount++] = p;
            }
          }
          // 删除的源若在剪贴板里(cut/copy 后又删),剪除避免幻影 cut 灰显 + 失效 Paste。
          if (removedCount > 0) {
            removed.length = removedCount;
            useExplorerClipboardStore.getState().prune(removed);
          }
          if (!result.ok) {
            for (const f of result.failures) {
              console.warn('[explorer] trash failed', f.path, f.code, f.message);
              notify.error(
                t('errors.folder.trash_failed', {
                  path: f.path,
                  message: localizeErrorByCode(f.code, f.message),
                }),
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
          const movedSrcs = kind === 'cut' ? new Array<string>(paths.length) : null;
          let movedSrcCount = 0;
          let okAny = false;
          try {
            // a11y(A135,A134/A133 同族):makeUniqueDestPicker(目标名探测)与 move/copy 循环都
            // 包进 try —— 此前 picker 在 try 外、循环只处理 !r.ok,move/copy/listDir 的 IPC reject
            // 直接丢到 unhandled promise(void 链),粘贴失败无 toast/live 反馈。catch 统一 notify;
            // finally 仍剪贴板清理 + 部分成功刷新。
            const pickDest = await makeUniqueDestPicker(destDir);
            for (const src of paths) {
              // 计算 dest:destDir + src basename;若已存在,自动加 ` copy` 后缀
              const dest = pickDest(basenamePreserveTrailing(src));
              const r =
                kind === 'cut' ? await coApi.fs.move(src, dest) : await coApi.fs.copy(src, dest);
              if (!r.ok) {
                console.warn(`[explorer] paste(${kind}) failed`, src, r.code, r.message);
                notify.error(
                  t('errors.folder.paste_failed', {
                    src,
                    message: localizeErrorByCode(r.code, r.message),
                  }),
                  { code: r.code, mirror: false },
                );
                return;
              }
              // cut = move:同步 editor tab 路径(目录则前缀 rewrite 全部子 tab)
              if (kind === 'cut') {
                useEditorStore.getState().renamePath(src, dest);
                touchedSrcParents.add(dirname(src));
                movedSrcs![movedSrcCount++] = src;
              }
              okAny = true;
            }
          } catch (err) {
            const code = (err as { code?: string })?.code ?? 'EXCEPTION';
            notify.error(localizeErrorByCode(code, (err as Error)?.message), {
              code,
            });
          } finally {
            // cut 是 move:已成功移走的源旧路径已失效,从剪贴板剪除。全成功 → 剪空(等价
            // 原 clear());**部分成功 → 只剪走已移走的,保留未移项供重试**。此前只在 allOk
            // 时 clear,部分成功把已移走的幻影源留在剪贴板(灰显 + 失效 Paste)——与兄弟
            // onDropItems/root-drop 的 finally prune(movedSrcs) 不对等(第八 session R7 完整性
            // 批判揪出的同族遗漏入口)。copy 不动源,不剪。
            if (kind === 'cut' && movedSrcs !== null && movedSrcCount > 0) {
              movedSrcs.length = movedSrcCount;
              useExplorerClipboardStore.getState().prune(movedSrcs);
            }
            if (okAny) {
              // 触发树刷新:目标父目录 invalidate
              treeApi.invalidateChildrenIds(destDir);
              // cut 时已成功移动项的源父目录也要刷新(文件不在源了)
              if (kind === 'cut') {
                for (const sp of touchedSrcParents) {
                  treeApi.invalidateChildrenIds(sp);
                }
              }
            }
          }
        })();
      },
    }),
    [makeUniqueDestPicker, mutateDeps, root, theme, treeApi, tt],
  );

  const submitCreate = async (name: string) => {
    if (!creating) return;
    const { type, parentDir } = creating;
    setCreating(null);
    const action = type === 'dir' ? createNewDir : createNewFile;
    const r = await action(parentDir, name, mutateDeps, treeApi);
    if (!r.ok) notify.error(localizeErrorByCode(r.code, r.message), { code: r.code });
  };

  // ── Drop 上传(Step 5d) ───────────────────────────────────────
  const dropTargetDir = resolveDropTarget(hoverTarget, root);

  const handleDragEnter = (e: React.DragEvent) => {
    if (!hasFiles(e.dataTransfer)) return;
    dragDepthRef.current += 1;
    if (!dragActive) setDragActive(true);
  };
  const handleDragOver = (e: React.DragEvent) => {
    if (hasFiles(e.dataTransfer)) {
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
    if (!hasFiles(e.dataTransfer)) return;
    dragDepthRef.current -= 1;
    if (dragDepthRef.current <= 0) {
      dragDepthRef.current = 0;
      setDragActive(false);
      setHoverTarget(null);
    }
  };
  const handleDrop = async (e: React.DragEvent) => {
    // 内部 drag drop 到空白(root level)— headless-tree row onDrop 接不到 root row
    if (!hasFiles(e.dataTransfer)) {
      const dnd = tree.getState().dnd;
      if (!dnd?.draggedItems || dnd.draggedItems.length === 0) return;
      e.preventDefault();
      // 已经在 root 下的不动(VSCode 同款)
      const moveable = selectRootDropMoveablePaths(dnd.draggedItems, root);
      if (moveable.length === 0) return;
      // 与 onDropItems/onPaste 同款部分成功刷新(README P2-BB):中途某项失败提前
      // 中止时,已成功移动项也要在 finally 刷新源父目录 + root,否则已移走的文件在
      // 树上凭空消失(源没刷=还显示,root 没刷=不显示)而其 editor tab 路径已改 →
      // 树/tab/磁盘三者不一致。此前 P2-BB 只修了 onDropItems/onPaste 两个兄弟调用点,
      // 漏了这个 root-drop 分支(「修复未传播到平行调用点」)。
      const touchedSrcParents = new Set<string>();
      const movedSrcs = new Array<string>(moveable.length);
      let movedSrcCount = 0;
      let movedAny = false;
      try {
        // a11y(A136,A135/A134/A133 同族):root-drop(拖到空白)是 async 事件处理器,React 不
        // await → 此前 makeUniqueDestPicker(root)在 try 外、循环只处理 !r.ok,move/listDir 的
        // IPC reject 直接成 unhandled rejection,无 toast/live 反馈。catch 统一 notify;finally
        // 仍部分成功刷新 + 剪贴板 prune。
        const pickDest = await makeUniqueDestPicker(root);
        for (const src of moveable) {
          const dest = pickDest(basenamePreserveTrailing(src));
          const r = await coApi.fs.move(src, dest);
          if (!r.ok) {
            console.warn('[explorer] root drop move failed', src, r.code, r.message);
            notify.error(
              t('errors.folder.move_failed', {
                src,
                message: localizeErrorByCode(r.code, r.message),
              }),
              { code: r.code, mirror: false },
            );
            return;
          }
          useEditorStore.getState().renamePath(src, dest);
          touchedSrcParents.add(dirname(src));
          movedSrcs[movedSrcCount++] = src;
          movedAny = true;
        }
      } catch (err) {
        const code = (err as { code?: string })?.code ?? 'EXCEPTION';
        notify.error(localizeErrorByCode(code, (err as Error)?.message), { code });
      } finally {
        if (movedAny) {
          refreshParent(root);
          for (const sp of touchedSrcParents) {
            if (sp !== root) refreshParent(sp);
          }
          // 移走的源旧路径已不存在 → 剪除剪贴板里引用它的 cut/copy 项。
          movedSrcs.length = movedSrcCount;
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
    // a11y(A151,A150 同族):空白/root 区域外部文件 drop。handleDrop 是 async 事件处理器(React
    // 不 await),partitionDropItems / refreshParent 抛会成 unhandled rejection 且批量错误无反馈。
    try {
      const { files, skippedDirs } = partitionDropItems(e.dataTransfer.items);
      if (files.length === 0 && skippedDirs.length === 0) return;
      const r = await performDrop(files, target, coApi.fs);
      refreshParent(target);
      // 仅在有问题时提示;成功 fs.watch 已自动刷新树
      if (skippedDirs.length > 0) {
        notify.error(t('errors.folder.skipped_dirs', { count: skippedDirs.length }));
      }
      if (!r.ok) {
        notify.error(
          t('errors.folder.batch_failed', { count: r.failed.length }) +
            '\n' +
            formatDropFailureLines(r.failed),
        );
      }
    } catch (err) {
      const code = (err as { code?: string })?.code ?? 'EXCEPTION';
      notify.error(localizeErrorByCode(code, (err as Error)?.message ?? code), { code });
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
        onRefresh={() => {
          // 刷新 = invalidate 当前所有展开目录,触发重新 listDir。
          // 单点 invalidate(root)对 cache 中已 list 过的子目录无效,
          // 所以遍历 expandedItems 全部 invalidate 一遍。
          const expanded = tree.getState().expandedItems ?? EMPTY_EXPANDED_ITEMS;
          // root 也算「已展开」(根 children 已 list),始终 invalidate
          const refreshPath = (path: string) => {
            try {
              const it = tree.getItemInstance(path);
              void it?.invalidateChildrenIds();
            } catch {
              // 节点已不存在(外部进程删了),跳过
            }
          };
          refreshPath(root);
          for (const path of expanded) {
            if (path !== root) refreshPath(path);
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
        pluginItems={pluginMenuItems}
      >
        <div ref={scrollRef} className="min-h-0 flex-1 overflow-auto bg-canvas">
          {items.length === 0 ? (
            <div className="p-4 text-xs text-fg-dim">{tt('panels.explorer.loading_or_empty')}</div>
          ) : (
            <div
              // a11y(A25):headless-tree role="tree" 默认 aria-label="" → 屏幕阅读器进主文件树
              // 只感知无名 tree。传本地化 treeLabel 给容器一个可访问名。
              {...tree.getContainerProps(tt('panels.explorer.tree_aria'))}
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
                    isDropHover={dragActive && hoverTarget?.path === item.getId()}
                    onFileOpen={handleFileOpen}
                    decorators={decorators}
                    hasClipboard={hasClipboard}
                    pluginMenuItems={pluginMenuItems}
                    indent={indent}
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
