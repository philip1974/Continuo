import { useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { hasFiles } from '@/lib/window-drop'; // 边界(E225):共享早停 hasFiles
import { basenamePreserveTrailing, dirname } from './path-utils';
import { joinPath, stripRootPrefix, isSameOrInsidePath } from '@/lib/path-cross';
import { useTree } from '@headless-tree/react';
import { useVirtualizer, type Virtualizer } from '@tanstack/react-virtual';
import type {
  AsyncDataLoaderDataRef,
  ItemInstance,
  SetStateFn,
  TreeInstance,
} from '@headless-tree/core';
import type { FileEntry } from '@/lib/fs/types';
import { ContextMenu, type ContextMenuActions } from './ContextMenu';
import { CreateInput } from './CreateInput';
import { DropOverlay } from './DropOverlay';
import { ExplorerHeader } from './ExplorerHeader';
import { buildTreeChildrenWithData, createTreeConfig, sameTreeChildren } from './tree-config';
import { DEFAULT_INDENT, FILE_ROW_HEIGHT, FileRow, readFileRowState } from './FileRow';
import { createNewDir, createNewFile, renameItem, trashItemsAndCleanup } from './mutate-actions';
import { resolveDropTarget, type DropTargetEntry } from './drop-handlers';
import {
  dropForeignFilesInto,
  transferEntriesInto,
  type BatchTransferKind,
} from './batch-transfer';

import { useFsWatcher } from './hooks/useFsWatcher';
import { ExplorerVisibleContext } from './visibility';
import { useEditorFile } from '@/panels/Editor/useEditorFile';
import { warmEditorEngineFor } from '@/panels/Editor/editor-file-actions';
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
import { setPendingFocus } from '@/shell/dock/DockReconciler';
import { notifyFailure, notifyThrownError } from '@/notifications/notify-thrown-error';
import { errorCodeOf } from '../../../electron/shared/error-message';
import { lowerIfNeeded } from '../../../electron/shared/lower-if-needed';

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

/**
 * perf:子项从未加载过的非 root 目录无缓存可失效。macOS/Win 根目录 recursive watcher 对任意深度变更
 * 都上报其所在目录(含 .git / node_modules 等树上不显示的目录);headless-tree 的 getItemInstance 对
 * 未知 id 现建临时实例,invalidateChildrenIds 仍会 listDir + 写缓存 + rebuildTree。未加载目录日后展开
 * 时自会按需加载;加载中的目录 invalidate 本就只复用在途加载。已加载(含已折叠但仍缓存)的目录与 root
 * 需要刷新。
 */
function isUnloadedNonRootDir(t: TreeInstance<FileEntry> | null, path: string): boolean {
  return (
    t !== null &&
    path !== t.getConfig().rootItemId &&
    t.getDataRef<AsyncDataLoaderDataRef>().current.childrenIds?.[path] === undefined
  );
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

/**
 * 纯唯一名 picker:给定 destDir 与已存在 basename 集合,返回一个 pick(name) 函数。
 * 候选序:basename / `${stem} copy${ext}` / `${stem} copy 2${ext}` / ...(上限 100,
 * 兜底加时间戳)。**每次 pick 把选中的候选名加进判重集合**,故同一批次内多个同名项
 * 不会都选到同一个 ` copy` 名(批量重名碰撞 → 第二个 move 覆盖第一个的潜在数据丢失)。
 * 抽成模块级纯函数以便单测;makeUniqueDestPicker 先 listDir 一次再委托它。
 * 判重按大小写折叠 + NFC:macOS 默认 / Windows 盘大小写不敏感,已有 Readme.md 时选原名 README.md
 * 会被 main 报 FS_EEXIST 中止整批(大小写敏感的 Linux 上多一个 ` copy` 后缀是可接受的保守行为)。
 * 返回的实际文件名保持原大小写。
 */
export function makeNamePicker(destDir: string, existing: Set<string>): (name: string) => string {
  const fold = (n: string): string => lowerIfNeeded(n.normalize('NFC'));
  const taken = new Set<string>();
  for (const n of existing) taken.add(fold(n));
  return (name: string): string => {
    const dot = name.lastIndexOf('.');
    const stem = dot > 0 ? name.slice(0, dot) : name;
    const ext = dot > 0 ? name.slice(dot) : '';
    for (let i = 0; i < 100; i++) {
      const candidate = i === 0 ? name : i === 1 ? `${stem} copy${ext}` : `${stem} copy ${i}${ext}`;
      if (!taken.has(fold(candidate))) {
        taken.add(fold(candidate)); // 预留,防同批后续项再撞同名
        return joinPath(destDir, candidate);
      }
    }
    const fallback = `${stem}-${Date.now()}${ext}`;
    taken.add(fold(fallback));
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
  // 键盘导航(End / Home / ArrowLeft 回父目录)焦点跳出虚拟窗口时,headless-tree updateDomFocus 先调
  // config.scrollToItem 再轮询等行挂载,超时把焦点打回首项。照官方虚拟化示例接 virtualizer.scrollToIndex;
  // 但下标必须取实际渲染的 items(隐藏文件过滤后),不能用 getItemMeta().index。virtualizer 在 tree 之后
  // 创建,故经 ref 持有;找不到下标(目标被过滤)则不滚。
  const virtualizerRef = useRef<Virtualizer<HTMLDivElement, Element> | null>(null);
  const renderedItemsRef = useRef<readonly ItemInstance<FileEntry>[]>([]);
  // 拖放结束不滚:headless-tree 行 onDrop 在 config.onDrop / onDropForeignDragObject 之后
  // draggedItems[0].setFocused() + updateDomFocus(),后者在 setTimeout 里调 scrollToItem(无焦点回退首项)
  // → 长列表拖到下方目录 / 从 Finder 拖入后列表跳回源行或首项。drop 回调里置一次性标志,scrollToItem
  // 读到即清除并跳过。库未调用(如容器级 root drop 不 updateDomFocus)时标志不能残留到下次键盘导航:
  // 嵌套两层 setTimeout 清除 —— 外层排在库 updateDomFocus 的 setTimeout(drop 回调之后的微任务里才排)
  // 之前,内层排在其后,故库那一次总能读到标志,之后必定清掉。
  const suppressDropScrollRef = useRef(false);
  const suppressNextDropScroll = useCallback(() => {
    suppressDropScrollRef.current = true;
    setTimeout(() => setTimeout(() => (suppressDropScrollRef.current = false)));
  }, []);
  const scrollToItem = useCallback((item: ItemInstance<FileEntry>) => {
    if (suppressDropScrollRef.current) {
      suppressDropScrollRef.current = false;
      return;
    }
    const id = item.getId();
    const index = renderedItemsRef.current.findIndex((it) => it.getId() === id);
    if (index >= 0) virtualizerRef.current?.scrollToIndex(index, { align: 'auto' });
  }, []);
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
  // 「全部展开」批量期(perf):headless-tree 的 expandAll 逐目录 item.expand(),每步都把整份
  // expandedItems 经 setExpandedItems 回写;若每步都分区 + 写 store(重建 Set)+ 触发重渲
  // (expandedItems 换新数组 → setConfig 再 rebuild 一次)→ 展开 D 个目录累计 O(D²)。
  // 批量期内只把库给的最新数组暂存在 latest,批末一次写 store。渲染期 config.state 也必须
  // 用 latest(与库内部 state 同一引用),否则重渲时 setConfig 会拿 store 旧值覆盖库内部
  // 已展开的状态。depth 计数允许多次点击重叠,最后一个结束才落盘。
  const expandBatchRef = useRef<{ depth: number; latest: string[] | null }>({
    depth: 0,
    latest: null,
  });
  const writeInRootExpanded = useCallback(
    (updater: string[] | ((old: string[]) => string[])) => {
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
  const setExpandedItems = useCallback<SetStateFn<string[]>>(
    (updater) => {
      const batch = expandBatchRef.current;
      if (batch.depth > 0) {
        batch.latest =
          typeof updater === 'function' ? updater(batch.latest ?? expandedItems) : updater;
        return;
      }
      writeInRootExpanded(updater);
    },
    [expandedItems, writeInRootExpanded],
  );
  const expandAll = useCallback(
    (tree: TreeInstance<FileEntry>): void => {
      const batch = expandBatchRef.current;
      batch.depth += 1;
      void tree.expandAll().finally(() => {
        batch.depth -= 1;
        if (batch.depth > 0) return;
        const latest = batch.latest;
        batch.latest = null;
        if (latest) writeInRootExpanded(latest);
      });
    },
    [writeInRootExpanded],
  );
  // 批量期 render 用库内部同一引用(ref 读取:库每步 rebuildTree 都会触发重渲),批外用 store 派生值。
  const treeExpandedItems = expandBatchRef.current.latest ?? expandedItems;

  // 每目录刷新代际:同目录并发刷新只应用最后发起的那次 listDir(迟到的旧结果不覆盖新结果);
  // 卸载时清空 → 在途结果全部作废。编号取组件级单调序号(不按目录从 1 重新计数):完成后会删掉该目录
  // 的登记,若按 `旧值 + 1` 取号,删号后新发起的刷新会与仍在途的更早请求撞号 → 旧快照被应用、新结果被丢。
  const refreshGenRef = useRef<Map<string, number>>(new Map());
  const refreshSeqRef = useRef(0);
  useEffect(() => {
    const gens = refreshGenRef.current;
    return () => gens.clear();
  }, []);
  const refreshParent = useCallback((parentPath: string) => {
    const t = treeRef.current;
    // perf:子项从未加载过的非 root 目录跳过(见 isUnloadedNonRootDir);root 永远刷新。
    if (t === null || isUnloadedNonRootDir(t, parentPath)) return;
    const invalidate = (): void => {
      try {
        void t.getItemInstance(parentPath).invalidateChildrenIds();
      } catch {
        t.rebuildTree();
      }
    };
    // perf:原子保存(本应用 / 外部编辑器写 tmp 再 rename)只产生 rename 事件,但目录列表不变。listDir
    // 便宜,贵的是 headless-tree 整树 rebuild → 先 listDir 与缓存子项比较(sameTreeChildren),相同则
    // 什么都不做;不同则直接用这次结果写缓存并 rebuild 一次(同 asyncDataLoader 的 loadChildrenIds,
    // 不二次 listDir)。listDir 失败 / 缓存已失效 → 走原 invalidate 路径(原语义)。
    const gens = refreshGenRef.current;
    const gen = ++refreshSeqRef.current;
    gens.set(parentPath, gen);
    void (async () => {
      let entries: readonly FileEntry[] | null = null;
      try {
        const r = await coApi.fs.listDir(parentPath);
        if (r.ok) entries = r.data;
      } catch {
        // 落到 invalidate(原路径自带失败告警)
      }
      if (gens.get(parentPath) !== gen) return; // 已被更新的刷新取代,或已卸载
      gens.delete(parentPath);
      const data = t.getDataRef<AsyncDataLoaderDataRef<FileEntry>>().current;
      const cachedIds = data.childrenIds?.[parentPath];
      // 缓存缺失 = 该目录被别处 invalidate、正在重新加载 → 原路径会复用那次在途加载。
      if (entries === null || cachedIds === undefined) {
        invalidate();
        return;
      }
      if (sameTreeChildren(cachedIds, data.itemData, entries)) return;
      const children = buildTreeChildrenWithData(entries);
      for (const c of children) data.itemData[c.id] = c.data;
      try {
        t.getItemInstance(parentPath).updateCachedChildrenIds(children.map((c) => c.id));
      } catch {
        t.rebuildTree();
      }
    })();
  }, []);

  // 为「单批移动/复制到同一 destDir」建一个唯一名 picker:listDir 一次拿现有
  // basename 集合,之后每次 pick 纯本地匹配(打磨 R20→R21:批量循环原先逐项
  // listDir → N 次同目录 IPC,现降为 1 次)。pick 还把已分配的候选名加进集合,
  // 防同一批次内两个同名项各自只看到磁盘旧态、都选到同一个 ` copy` 名 → 第二个
  // move 覆盖第一个(批量重名碰撞,潜在数据丢失)。候选序:basename /
  // `${stem} copy${ext}` / `${stem} copy 2${ext}` / ... 上限 100 次,兜底加时间戳。
  const makeUniqueDestPicker = useCallback(
    async (destDir: string): Promise<(name: string) => string> => {
      // perf:只用 e.name → withStats:false,main 不逐项 lstat(大目录粘贴/拖入时显著)。
      const r = await coApi.fs.listDir(destDir, { withStats: false });
      const existing = new Set<string>();
      if (r.ok) {
        for (const e of r.data) existing.add(e.name);
      }
      return makeNamePicker(destDir, existing);
    },
    [],
  );

  // 三个批量入口(onDropItems / root-drop / onPaste)共用的移动/复制流程:部分成功刷新、editor tab
  // 路径同步、剪贴板 prune、失败/异常反馈都在 transferEntriesInto 一处(见 batch-transfer.ts)。
  // logLabel / failedKey 只区分各入口的日志前缀与失败文案。
  const runBatchTransfer = useCallback(
    (
      kind: BatchTransferKind,
      srcs: readonly string[],
      destDir: string,
      logLabel: string,
      failedKey: 'errors.folder.move_failed' | 'errors.folder.paste_failed',
      opts?: { skipSameParent?: boolean },
    ): Promise<void> =>
      transferEntriesInto(
        kind,
        srcs,
        destDir,
        {
          fs: coApi.fs,
          makeUniqueDestPicker,
          refreshDir: refreshParent,
          onMoved: (src, dest) => useEditorStore.getState().renamePath(src, dest),
          // 移走的源旧路径已不存在 → 剪除剪贴板里引用它的 cut/copy 项。
          onSourcesGone: (movedSrcs) => useExplorerClipboardStore.getState().prune(movedSrcs),
          onItemFailed: (src, code, message) => {
            console.warn(`[explorer] ${logLabel} failed`, src, code, message);
            notify.error(t(failedKey, { src, message: localizeErrorByCode(code, message) }), {
              code,
              mirror: false,
            });
          },
          onException: (err) => {
            notifyThrownError(err);
          },
        },
        opts,
      ),
    [makeUniqueDestPicker, refreshParent],
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
          notifyFailure({ code, message });
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
                notifyFailure(r);
                return;
              }
              // 同步打开的 editor tab 路径(目录 rename 时其下所有 tab 也会前缀 rewrite)
              useEditorStore.getState().renamePath(oldPath, r.newPath);
              // 改名后旧路径已不存在 → 剪除剪贴板里引用旧路径的 cut/copy 项。
              useExplorerClipboardStore.getState().prune([oldPath]);
            } catch (err) {
              notifyThrownError(err);
            }
          })();
        },
        // 内部多选拖动 → 批量 fs.move,语义同 cut→paste(但不经剪贴板)
        onDropItems: (items, destDir) => {
          suppressNextDropScroll();
          // 拖到原父目录 → no-op(canDrop 已挡掉拖到自身,父同位置只跳)
          void runBatchTransfer(
            'move',
            selectDraggedItemPaths(items),
            destDir,
            'drop move',
            'errors.folder.move_failed',
            { skipSameParent: true },
          );
        },
        // 外部 OS 文件 drop 到具体 row → 走与容器 onDrop 同一套 performDrop
        onDropForeign: (dataTransfer, destDir) => {
          suppressNextDropScroll();
          void dropForeignFilesInto(dataTransfer.items, destDir, coApi.fs, refreshParent);
        },
        expandedItems: treeExpandedItems,
        setExpandedItems,
        scrollToItem,
      }),
    [
      treeExpandedItems,
      refreshParent,
      root,
      runBatchTransfer,
      setExpandedItems,
      scrollToItem,
      suppressNextDropScroll,
    ],
  );
  const tree = useTree<FileEntry>(config);
  treeRef.current = tree;

  const allItems = tree.getItems();
  // explorer.showHiddenFiles=false(默认)过滤 . 开头的 entries(.git / .env 等)
  const showHidden = useSettingValue<boolean>('explorer.showHiddenFiles', false);
  const items = useMemo(() => selectVisibleTreeItems(allItems, showHidden), [allItems, showHidden]);
  renderedItemsRef.current = items;

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
  // 用 treeExpandedItems(树实际展开集合)而非 store 派生的 expandedItems:「全部展开」批量期
  // store 批末才写,若 watcher 跟 store,批中新展开目录整批都没 watcher;Linux watcher 非递归,
  // listDir 之后、批末之前的变化永久漏掉。选派生而非批末补偿 invalidation:后者要对所有新目录
  // 再 listDir 一遍(IO 翻倍),且补偿前的窗口仍不可观察。批外两者同一引用,行为不变。
  const expandedPaths = useMemo(() => new Set(treeExpandedItems), [treeExpandedItems]);
  // perf(侧栏保活):ExplorerSidebar 关闭时文件树保持挂载但隐藏,watcher 仍在(树不陈旧)。隐藏期间
  // 用户看不见,dir-changed 不立即 invalidate→listDir,只记脏目录(未加载的目录照 refreshParent 规则
  // 直接忽略),再次显示时批量刷新。集合按路径去重,上限即已加载目录数。
  const visible = useContext(ExplorerVisibleContext);
  const dirtyWhileHiddenRef = useRef<Set<string>>(new Set());
  useFsWatcher(
    expandedPaths,
    (changedPath) => {
      if (!visible) {
        if (!isUnloadedNonRootDir(treeRef.current, changedPath)) {
          dirtyWhileHiddenRef.current.add(changedPath);
        }
        return;
      }
      refreshParent(changedPath);
    },
    root,
  );
  useEffect(() => {
    if (!visible) return;
    const dirty = dirtyWhileHiddenRef.current;
    if (dirty.size === 0) return;
    dirtyWhileHiddenRef.current = new Set();
    for (const p of dirty) refreshParent(p);
  }, [visible, refreshParent]);

  const scrollRef = useRef<HTMLDivElement>(null);
  // 侧栏保活:隐藏(display:none)期间滚动容器没有布局盒,浏览器可能把 scrollTop 归零;记下可见时
  // 最后的滚动位置,再次显示时(绘制前)恢复。
  const lastScrollTopRef = useRef(0);
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!visible || !el) return;
    if (el.scrollTop !== lastScrollTopRef.current) el.scrollTop = lastScrollTopRef.current;
  }, [visible]);
  const virtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => FILE_ROW_HEIGHT,
    overscan: 8,
  });
  virtualizerRef.current = virtualizer;

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
        const code = errorCodeOf(err);
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
        // 新建 terminal session,cwd 设到该目录;sessions_changed 推送后 DockReconciler 为它建
        // dockview terminal panel 并聚焦,让用户立即看到。
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
              notifyFailure(r, { mirror: false });
              return;
            }
            // 终端面板是 per-session id(terminal-<id>),只由 DockReconciler 建;此前调通用
            // openOrFocusPanel('terminal') 会 addPanel 出无 sessionId 的坏面板(随即自动关闭)。
            // 与 Cmd+T(createUserTerminal)相同,用 setPendingFocus 请求 Reconciler 聚焦新面板。
            if (r.data?.id) setPendingFocus(r.data.id);
          } catch (err) {
            notifyThrownError(err);
          }
        })();
      },
      onTrash: (paths: string[]) => {
        void (async () => {
          // 走规范的 mutate-actions.removeItems(遍历全部项、收集所有失败、刷新所有
          // 成功项父目录),而非内联首失早退 —— 旧实现一旦某项 trash 失败就 return,
          // 静默跳过其余选中项(多选删除时后续项既不删也不报错)。removeItems 是
          // 纯 fs+tree helper(已测,且本为唯一生产 trash 路径却从未被调用)。见第七 session
          // R6 完整性批判。editor tab 关闭与剪贴板 prune 只对 result.removed 做,在
          // trashItemsAndCleanup 一处完成(已测)。
          const result = await trashItemsAndCleanup(paths, mutateDeps, treeApi, {
            removePaths: (ps) => useEditorStore.getState().removePaths(ps),
            prune: (removed) => useExplorerClipboardStore.getState().prune(removed),
          });
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
        const { kind, paths } = useExplorerClipboardStore.getState();
        if (!kind || paths.length === 0) return;
        // cut = move(部分成功只从剪贴板剪走已移走的,未移项留供重试);copy 不动源。
        void runBatchTransfer(
          kind === 'cut' ? 'move' : 'copy',
          paths,
          destDir,
          `paste(${kind})`,
          'errors.folder.paste_failed',
        );
      },
    }),
    [mutateDeps, root, runBatchTransfer, theme, treeApi, tt],
  );

  const submitCreate = async (name: string) => {
    if (!creating) return;
    const { type, parentDir } = creating;
    setCreating(null);
    const action = type === 'dir' ? createNewDir : createNewFile;
    const r = await action(parentDir, name, mutateDeps, treeApi);
    if (!r.ok) notifyFailure(r);
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
      // 已经在 root 下的不动(VSCode 同款)。selectRootDropMoveablePaths 只用于「全在 root 下」早退;
      // 实际交给漏斗的是全部拖动路径 + skipSameParent —— 漏斗先剔后代再跳过同父项。若交预筛结果,
      // 多选 root 下的 A 与 A/B 时 A 被预先剔掉,只剩 A/B 被移到 root,层级被拆散。
      if (selectRootDropMoveablePaths(dnd.draggedItems, root).length === 0) return;
      await runBatchTransfer(
        'move',
        selectDraggedItemPaths(dnd.draggedItems),
        root,
        'root drop move',
        'errors.folder.move_failed',
        { skipSameParent: true },
      );
      return;
    }
    e.preventDefault();
    dragDepthRef.current = 0;
    setDragActive(false);
    const target = resolveDropTarget(hoverTarget, root);
    setHoverTarget(null);
    await dropForeignFilesInto(e.dataTransfer.items, target, coApi.fs, refreshParent);
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
          // 异步,大目录会触发大量 listDir;用户主动行为,不防抖。store 回写批末合并一次。
          expandAll(tree);
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
        <div
          ref={scrollRef}
          className="min-h-0 flex-1 overflow-auto bg-canvas"
          onScroll={(e) => {
            if (visible) lastScrollTopRef.current = e.currentTarget.scrollTop;
          }}
        >
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
                    {...readFileRowState(item, tree)}
                    start={vRow.start}
                    selectedPaths={selectedPaths}
                    rootPath={root}
                    contextActions={contextActions}
                    onHoverDropTarget={setHoverTarget}
                    isDropHover={dragActive && hoverTarget?.path === item.getId()}
                    onFileOpen={handleFileOpen}
                    onFileIntent={warmEditorEngineFor}
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
