import { useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { hasFiles } from '@/lib/window-drop'; // 边界(E225):共享早停 hasFiles
import { basenamePreserveTrailing, dirname, renameTarget } from './path-utils';
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
import { Button } from '@/design';
import { ContextMenu, type ContextMenuActions } from './ContextMenu';
import { CreateInput } from './CreateInput';
import { DropOverlay } from './DropOverlay';
import { ExplorerHeader } from './ExplorerHeader';
import {
  buildTreeChildrenWithData,
  createTreeConfig,
  filterHiddenEntries,
  isHiddenWithinRoot,
  sameTreeChildren,
} from './tree-config';
import {
  focusAndSelect,
  handleTreeKeyDown,
  neighborAfterRemoval,
  selectOnly,
  type TypeAheadState,
} from './tree-keyboard';
import { detectPlatform } from '@/plugins/command-palette/format-hotkey';
import { FILE_ROW_HEIGHT, FileRow, readFileRowState } from './FileRow';
import {
  DIR_LOAD_ERROR_ROW_HEIGHT,
  DirLoadErrorRow,
  insertDirLoadErrorRows,
  isDirLoadErrorRow,
  type DirLoadFailure,
  type TreeRow,
} from './DirLoadErrorRow';
import { createNewDir, createNewFile, renameItem, trashItemsAndCleanup } from './mutate-actions';
import { cleanupAfterPathMoved, cleanupAfterPathsRemoved } from './path-gone-cleanup';
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
import { focusActiveEditor } from '@/panels/Editor/editor-focus-registry';
import { forgetInExpanded, renameInExpanded, useExplorerStore } from '@/stores/explorer.store';
import { coApi } from '@/lib/co-api';
import { notify } from '@/notifications/notify';
import { copyToClipboardOrNotify } from './copy-to-clipboard';
import { revealPathOrNotify } from './reveal-or-notify';
import { useSettingValue } from '@/plugins/settings/values-store';
import {
  EXPLORER_CONFIRM_DELETE,
  EXPLORER_INDENT_SIZE,
  EXPLORER_SHOW_HIDDEN_FILES,
} from '@/plugins/settings/core-setting-specs';
import { ConfirmDialog } from '@/lib/ConfirmDialog';
import { coApp } from '@/plugins/co-app';
import { useRegistry } from '@/plugins/registries/useRegistry';
import { useExplorerClipboardStore } from './clipboard-store';
import { t, useT } from '@/i18n';
import { localizeErrorByCode } from '@/lib/localize-error';
import { createUserTerminal } from '@/shell/dock/create-user-terminal';
import { notifyFailure, notifyThrownError } from '@/notifications/notify-thrown-error';
import { lowerIfNeeded } from '../../../electron/shared/lower-if-needed';
import { ERROR_CODES } from '@shared/error-codes';
import { openFileOrNotify } from '@/notifications/notify-open-failed';

interface CreatingState {
  type: 'file' | 'dir';
  parentDir: string;
  /** 上次提交失败的原因(已本地化);输入框保留,显示在其下方。 */
  error?: string;
}

/** 新建成功后待在树里定位的新项(等父目录刷新 / 展开后出现在渲染列表里)。 */
interface PendingReveal {
  path: string;
  /** 文件夹:DOM 焦点移到新行;文件:只改树的焦点 / 选中并滚动,不抢刚打开的编辑器的焦点。 */
  focusRow: boolean;
}

// 根目录读取状态:加载中 / 已读到 / 读取失败(原因)。
const ROOT_LOADING = 'loading';
const ROOT_LOADED = 'loaded';
type RootLoadState = typeof ROOT_LOADING | typeof ROOT_LOADED | DirLoadFailure;

/** 待确认的删除(VSCode explorer.confirmDelete)。afterConfirm:确认后、实际删除前调用(键盘删除移焦点)。 */
interface TrashConfirmState {
  paths: string[];
  afterConfirm?: () => void;
}

// 删除确认框最多列出的名字数(VSCode 同为 10,其余以「另有 N 项」概括)。
const TRASH_CONFIRM_MAX_NAMES = 10;

// 新项若始终不出现(如新建的是隐藏文件且未显示隐藏文件),到期放弃定位。
const PENDING_REVEAL_TTL_MS = 3000;

const EMPTY_SELECTED_PATHS: ReadonlySet<string> = new Set();
const EMPTY_EXPANDED_ITEMS: readonly string[] = [];
const EMPTY_PATH_LIST: string[] = [];
const EMPTY_DIR_ERRORS: ReadonlyMap<string, DirLoadFailure> = new Map();

/** 子目录读取结果写回失败表(成功删除、失败记录);无变化返回原表。 */
function updateDirErrors(
  prev: ReadonlyMap<string, DirLoadFailure>,
  dir: string,
  failure: DirLoadFailure | null,
): ReadonlyMap<string, DirLoadFailure> {
  if (failure === null) {
    if (!prev.has(dir)) return prev;
    const next = new Map(prev);
    next.delete(dir);
    return next;
  }
  const old = prev.get(dir);
  if (old !== undefined && old.code === failure.code && old.message === failure.message) return prev;
  return new Map(prev).set(dir, failure);
}

/** 树行(含子目录读取失败的内联错误行)里某项的下标;找不到 -1。 */
function rowIndexOf(rows: readonly TreeRow[], id: string): number {
  return rows.findIndex((r) => !isDirLoadErrorRow(r) && r.getId() === id);
}

// 跨平台(复查 P2):复用单一来源 path-cross.isSameOrInsidePath —— 此前手写
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
  // 虚拟列表的实际行(renderedItems 之外插入了子目录读取失败的错误行):滚动下标按它算。
  const treeRowsRef = useRef<readonly TreeRow[]>([]);
  // 拖放结束不滚:headless-tree 行 onDrop 在 config.onDrop / onDropForeignDragObject 之后
  // draggedItems[0].setFocused() + updateDomFocus(),后者在 setTimeout 里调 scrollToItem(无焦点回退首项)
  // → 长列表拖到下方目录 / 从 Finder 拖入后列表跳回源行或首项。drop 回调里置一次性标志,scrollToItem
  // 读到即清除并跳过。库未调用(如容器级 root drop 不 updateDomFocus)时标志不能残留到下次键盘导航:
  // 嵌套两层 setTimeout 清除 —— 外层排在库 updateDomFocus 的 setTimeout(drop 回调之后的微任务里才排)
  // 之前,内层排在其后,故库那一次总能读到标志,之后必定清掉。
  // 只跳过滚动还不够:updateDomFocus 在 scrollToItem 后轮询 500ms 等焦点项挂载,取不到就把焦点重置到首项
  // (内部移动的焦点项是源行,长列表里常已滚出窗口)→ 下次方向键从首项出发,列表跳回顶部。故在外层
  // setTimeout(先于库 updateDomFocus 的定时器;库在 drop 回调之后才同步 setFocused 源行,这里晚于它)
  // 把焦点改到实际松手的那一行:它此刻必在虚拟窗口内,轮询立即取到元素,列表不动。松手行由容器
  // handleDropCapture 记录(库清 dnd 状态后再调 onDrop,回调参数里的 target 可能是窗口外的父目录 / 不渲染的 root)。
  const suppressDropScrollRef = useRef(false);
  const dropRowIdRef = useRef<string | null>(null);
  const suppressNextDropScroll = useCallback(() => {
    suppressDropScrollRef.current = true;
    setTimeout(() => {
      const rowId = dropRowIdRef.current;
      dropRowIdRef.current = null;
      if (rowId !== null) treeRef.current?.getItemInstance(rowId)?.setFocused();
      setTimeout(() => (suppressDropScrollRef.current = false));
    });
  }, []);
  const scrollToItem = useCallback((item: ItemInstance<FileEntry>) => {
    if (suppressDropScrollRef.current) {
      suppressDropScrollRef.current = false;
      return;
    }
    const index = rowIndexOf(treeRowsRef.current, item.getId());
    if (index >= 0) virtualizerRef.current?.scrollToIndex(index, { align: 'auto' });
  }, []);
  const [creating, setCreating] = useState<CreatingState | null>(null);
  // explorer.showHiddenFiles=false(默认)不显示 . 开头的项(.git / .env 等)。在 loader 层过滤(见 tree-config
  // showHidden):库的键盘导航 / 全选 / 范围选都基于 tree.getItems(),须与渲染一致。loader 与刷新经 ref 读最新值。
  const showHidden = useSettingValue(EXPLORER_SHOW_HIDDEN_FILES.id, EXPLORER_SHOW_HIDDEN_FILES.default);
  const showHiddenRef = useRef(showHidden);
  showHiddenRef.current = showHidden;
  const confirmDelete = useSettingValue(EXPLORER_CONFIRM_DELETE.id, EXPLORER_CONFIRM_DELETE.default);
  const confirmDeleteRef = useRef(confirmDelete);
  confirmDeleteRef.current = confirmDelete;
  const [trashConfirm, setTrashConfirm] = useState<TrashConfirmState | null>(null);
  // 根目录「重试」后焦点去向(重试按钮随加载态卸载,不处理焦点会掉到 body):成功 → 树;成功但为空 → 空态提示;
  // 仍失败 → 新的重试按钮。
  const retryFocusPendingRef = useRef(false);
  const loadFailedRef = useRef<HTMLDivElement>(null);
  const emptyStateRef = useRef<HTMLDivElement>(null);
  // 子目录读取失败(VSCode:展开失败的目录下显示错误行):目录 → 原因;读到即删除。
  const [dirErrors, setDirErrors] = useState<ReadonlyMap<string, DirLoadFailure>>(EMPTY_DIR_ERRORS);
  const [pendingReveal, setPendingReveal] = useState<PendingReveal | null>(null);
  // 根目录读取状态(loader 经 onChildrenLoad 回报):列表为空时据此区分加载中 / 读取失败 / 空文件夹。
  const [rootLoad, setRootLoad] = useState<RootLoadState>(ROOT_LOADING);
  // dnd 状态:hoverTarget 由 FileRow onDragEnter 回报;dragDepth 用计数器
  // 防止 child enter/leave 误清(每次 enter +1,leave -1,归零才真离开)
  const [hoverTarget, setHoverTarget] = useState<DropTargetEntry | null>(null);
  // perf:FileRow 每个 dragenter(含行内子元素冒泡上来的)都回报一个新对象;同 path + isDirectory 时
  // 保留旧引用 → React 跳过重渲,拖过一行不再反复整树重渲。
  const reportHoverTarget = useCallback((target: DropTargetEntry | null) => {
    setHoverTarget((prev) =>
      prev !== null && prev.path === target?.path && prev.isDirectory === target.isDirectory
        ? prev
        : target,
    );
  }, []);
  const dragDepthRef = useRef(0);
  // OS 文件 drop 的落点目录:handleDropCapture 复位 hoverTarget 前算好,冒泡阶段 handleDrop 读后清空
  const foreignDropTargetRef = useRef<string | null>(null);
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
  // pathOps:批量期间发生的改名 / 删除对展开集合的改写,批末写回前重放(见 onPathMoved)。
  const expandBatchRef = useRef<{
    depth: number;
    latest: string[] | null;
    pathOps: ((paths: string[]) => string[] | null)[];
  }>({
    depth: 0,
    latest: null,
    pathOps: [],
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
        let latest = batch.latest;
        const ops = batch.pathOps;
        batch.latest = null;
        batch.pathOps = [];
        if (latest) {
          for (const op of ops) latest = op(latest) ?? latest;
          writeInRootExpanded(latest);
        }
      });
    },
    [writeInRootExpanded],
  );
  // 批量期 render 用库内部同一引用(ref 读取:库每步 rebuildTree 都会触发重渲),批外用 store 派生值。
  const treeExpandedItems = expandBatchRef.current.latest ?? expandedItems;
  // 路径移走 / 删除后的清理:除 store 外,「全部展开」批量期的改写还须在批末写回前重放 —— 批末整体写回会覆盖
  // store 里刚改好的展开集合;且库内部另持一份展开状态、每步整份回传(还可能继续展开旧子树的后代),只改一次
  // latest 会被下一步覆盖。故记下改写,写回前按序重放(同时就地改 latest,渲染期即生效)。
  const applyBatchPathOp = useCallback((op: (paths: string[]) => string[] | null) => {
    const batch = expandBatchRef.current;
    if (batch.depth === 0) return;
    batch.pathOps.push(op);
    if (batch.latest) batch.latest = op(batch.latest) ?? batch.latest;
  }, []);
  const onPathMoved = useCallback(
    (oldPath: string, newPath: string) => {
      cleanupAfterPathMoved(oldPath, newPath);
      applyBatchPathOp((paths) => renameInExpanded(paths, oldPath, newPath));
    },
    [applyBatchPathOp],
  );
  const onPathsRemoved = useCallback(
    (paths: string[]) => {
      cleanupAfterPathsRemoved(paths);
      applyBatchPathOp((expanded) => forgetInExpanded(expanded, paths));
    },
    [applyBatchPathOp],
  );

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
      // 不经 loader 的刷新路径:目录读到了 → 清掉失败态(失败则下方 invalidate 经 loader 回报)
      if (entries !== null) {
        if (parentPath === root) setRootLoad(ROOT_LOADED);
        else setDirErrors((prev) => updateDirErrors(prev, parentPath, null));
      }
      if (entries !== null) entries = filterHiddenEntries(entries, showHiddenRef.current);
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
  }, [root]);

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

  // 三个批量入口(onDropItems / root-drop / onPaste)共用的移动/复制流程:部分成功刷新、「路径已移走」
  // 清理(cleanupAfterPathMoved)、失败/异常反馈都在 transferEntriesInto 一处(见 batch-transfer.ts)。
  // logLabel / failedKey 只区分各入口的日志前缀与失败文案。
  const runBatchTransfer = useCallback(
    (
      kind: BatchTransferKind,
      srcs: readonly string[],
      destDir: string,
      logLabel: string,
      failedKey: 'errors.folder.move_failed' | 'errors.folder.paste_failed',
    ): Promise<void> =>
      transferEntriesInto(
        kind,
        srcs,
        destDir,
        {
          fs: coApi.fs,
          makeUniqueDestPicker,
          refreshDir: refreshParent,
          onMoved: onPathMoved,
          root,
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
      ),
    [makeUniqueDestPicker, onPathMoved, refreshParent, root],
  );

  // 树里读取失败的反馈限流(3s,对齐 A144):展开深树可能连续多次 listDir 失败,无差别弹会刷屏。
  const takeIpcWarnSlot = useCallback((): boolean => {
    const now = Date.now();
    if (now - lastIpcWarnAtRef.current < 3000) return false;
    lastIpcWarnAtRef.current = now;
    return true;
  }, []);
  // 目录此刻是否展开(loader 回报时 React 可能尚未重渲:读 store 与「全部展开」批量期的最新集合,不读 tree state)。
  const isExpandedNow = useCallback((dir: string): boolean => {
    const latest = expandBatchRef.current.latest;
    if (latest !== null && latest.includes(dir)) return true;
    return useExplorerStore.getState().expandedPaths.has(dir);
  }, []);

  const config = useMemo(
    () =>
      createTreeConfig({
        root,
        fs: coApi.fs,
        // a11y(A148):listDir 失败 → console.warn(诊断)+ 限流 notify.error(用户/AT 可感知)。
        // 列子项失败由 onChildrenLoad 反馈(内联错误行 / 带目录名的 toast),这里只处理其余(getItem 兜底)。
        onIpcWarn: (message: string, code: string, childrenOf?: string) => {
          console.warn('[explorer-tree]', message, code);
          if (childrenOf !== undefined) return;
          if (!takeIpcWarnSlot()) return;
          notifyFailure({ code, message });
        },
        // 根目录失败 → 内联提示 + 重试;子目录失败 → 记入失败表,展开着的目录下显示内联错误行 + 重试(VSCode 同款)。
        // 已折叠目录的后台刷新失败看不到错误行 → 限流 toast:按错误码本地化 + 目录名(不显示原始诊断串)。
        onChildrenLoad: (itemId, failure) => {
          if (itemId === root) {
            setRootLoad(failure ?? ROOT_LOADED);
            return;
          }
          setDirErrors((prev) => updateDirErrors(prev, itemId, failure));
          if (failure === null || isExpandedNow(itemId) || !takeIpcWarnSlot()) return;
          notify.error(
            t('panels.explorer.load_failed_named', {
              name: basenamePreserveTrailing(itemId),
              message: localizeErrorByCode(failure.code, failure.message),
            }),
            { code: failure.code, mirror: false },
          );
        },
        onRename: (item: ItemInstance<FileEntry>, newName: string) => {
          // headless-tree onRename 是 sync 签名,我们 fire-and-forget 走 mutate-actions
          const oldPath = item.getId();
          // 未改名 / 空值 → 不发 IPC(见 renameTarget);与新建同一规范化(去首尾空白)。
          const target = renameTarget(oldPath, newName);
          if (target === null) return;
          void (async () => {
            // a11y(A133,A50 同族):renameItem 已把 IPC reject 归为 ok:false;try/catch 兜的是其后的 editor /
            // 剪贴板同步抛错 —— fire-and-forget 下不兜即 unhandled rejection、用户无反馈。
            try {
              const r = await renameItem(
                oldPath,
                target,
                { fs: coApi.fs },
                { invalidateChildrenIds: refreshParent },
              );
              if (!r.ok) {
                // 目标名已存在:提示带上这个名字(VSCode 同款),通用的「已存在」看不出是哪个名字冲突。
                if (r.code === ERROR_CODES.FS_EEXIST) {
                  notify.error(t('panels.explorer.rename_exists', { name: target }), { code: r.code });
                } else notifyFailure(r);
                return;
              }
              // editor tab / 展开集合前缀改写 + 剪贴板剪除旧路径(目录 rename 时其下全部路径同步)
              onPathMoved(oldPath, r.newPath);
            } catch (err) {
              notifyThrownError(err);
            }
          })();
        },
        // 内部多选拖动 → 批量 fs.move,语义同 cut→paste(但不经剪贴板)
        onDropItems: (items, destDir) => {
          suppressNextDropScroll();
          // 拖到原父目录 → no-op(canDrop 已挡掉拖到自身;同父跳过在 transferEntriesInto 内)
          void runBatchTransfer(
            'move',
            selectDraggedItemPaths(items),
            destDir,
            'drop move',
            'errors.folder.move_failed',
          );
        },
        // 外部 OS 文件 drop 到具体 row → 走与容器 onDrop 同一套 performDrop
        onDropForeign: (dataTransfer, destDir) => {
          suppressNextDropScroll();
          void dropForeignFilesInto(dataTransfer.items, destDir, coApi.fs, refreshParent);
        },
        showHidden: () => showHiddenRef.current,
        expandedItems: treeExpandedItems,
        setExpandedItems,
        scrollToItem,
      }),
    [
      isExpandedNow,
      takeIpcWarnSlot,
      treeExpandedItems,
      onPathMoved,
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
  // loader 已按 showHidden 过滤;切换为隐藏后、已加载目录刷新完成前缓存里仍有隐藏项,渲染这里再滤一次。
  const items = useMemo(() => selectVisibleTreeItems(allItems, showHidden), [allItems, showHidden]);
  renderedItemsRef.current = items;
  const rows = useMemo(() => insertDirLoadErrorRows(items, dirErrors), [items, dirErrors]);
  treeRowsRef.current = rows;

  // 多选集合数据源 = headless-tree selectionFeature 真实状态。
  // 数组引用变 → Set 重建;Click/Cmd-Click/Shift-Click 由 selectionFeature 内部
  // 维护,任何变化都会引起组件重渲,Set 自动跟新。
  const selectedItemsArr = tree.getState().selectedItems;
  const selectedPaths = useMemo<ReadonlySet<string>>(
    () => buildSelectedPathSet(selectedItemsArr),
    [selectedItemsArr],
  );
  // 行只在打开右键菜单时读取选中(见 FileRow.getSelectedPaths):稳定引用,选中变化不击穿行 memo。
  const selectedPathsRef = useRef(selectedPaths);
  selectedPathsRef.current = selectedPaths;
  const getSelectedPaths = useCallback(() => selectedPathsRef.current, []);

  // 插件装饰器 registry 一次订阅(打磨 R7):下传给每个 FileRow,避免虚拟列表
  // N 行各自 useRegistry(N 份订阅 + 插件启停时每行各取一次快照)。
  const decorators = useRegistry(coApp.explorerDecorators);
  // 插件右键菜单项 registry 一次订阅(打磨 R10):下传给根 ContextMenu 与每个
  // FileRow 的 ContextMenu,避免 N+1 份同质订阅。可见性仍由各菜单按上下文计算。
  const pluginMenuItems = useRegistry(coApp.explorerContextMenu);
  // explorer.indentSize 对整棵树一致,一次订阅后下传(打磨 R14),避免每个可见
  // FileRow 各订阅一份同值 setting。
  const indent = useSettingValue(EXPLORER_INDENT_SIZE.id, EXPLORER_INDENT_SIZE.default);

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

  // 切换「显示隐藏文件」→ 刷新全部已加载目录(loader 缓存是按旧设置过滤的)。首次挂载不刷。
  // 关掉时还要把隐藏项(及隐藏目录下的项)移出选中集合:否则多选里看不见的项仍会被删除 / 剪切 / 复制 / 拖动。
  const lastShowHiddenRef = useRef(showHidden);
  useEffect(() => {
    if (lastShowHiddenRef.current === showHidden) return;
    lastShowHiddenRef.current = showHidden;
    const t = treeRef.current;
    if (t === null) return;
    if (!showHidden) {
      const selected = t.getState().selectedItems ?? EMPTY_PATH_LIST;
      const kept = selected.filter((id) => !isHiddenWithinRoot(root, id));
      if (kept.length !== selected.length) t.setSelectedItems(kept);
    }
    const loaded = t.getDataRef<AsyncDataLoaderDataRef>().current.childrenIds ?? {};
    for (const dir of Object.keys(loaded)) refreshParent(dir);
  }, [showHidden, refreshParent, root]);

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
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: (i) => (isDirLoadErrorRow(rows[i]) ? DIR_LOAD_ERROR_ROW_HEIGHT : FILE_ROW_HEIGHT),
    overscan: 8,
  });
  virtualizerRef.current = virtualizer;

  // 新建成功后,新项一出现在渲染列表里就把树焦点 / 选中移过去(见 submitCreate)。
  useEffect(() => {
    if (pendingReveal === null) return;
    const index = rowIndexOf(rows, pendingReveal.path);
    if (index < 0) return;
    const item = rows[index] as ItemInstance<FileEntry>;
    setPendingReveal(null);
    if (pendingReveal.focusRow) {
      focusAndSelect(tree, item);
    } else {
      item.setFocused();
      selectOnly(tree, item.getId());
      virtualizer.scrollToIndex(index, { align: 'auto' });
    }
  }, [rows, pendingReveal, tree, virtualizer]);
  useEffect(() => {
    if (pendingReveal === null) return;
    const timer = setTimeout(() => setPendingReveal(null), PENDING_REVEAL_TTL_MS);
    return () => clearTimeout(timer);
  }, [pendingReveal]);

  const treeApi = useMemo(() => ({ invalidateChildrenIds: refreshParent }), [refreshParent]);
  const mutateDeps = useMemo(() => ({ fs: coApi.fs }), []);

  // Explorer ↔ Editor 联动(Step E5):单击文件 → openFileByPath
  const { openFileByPath } = useEditorFile();
  const handleFileOpen = useCallback(
    (path: string): Promise<boolean> =>
      // 点击文件是 Explorer 的主操作:ok:false 与 reject 都必须给反馈(P1-AX / A141),由 openFileOrNotify 统一。
      openFileOrNotify(() => openFileByPath(path), basenamePreserveTrailing(path), 'explorer'),
    [openFileByPath],
  );

  const hasClipboard = useExplorerClipboardStore((s) => s.kind !== null && s.paths.length > 0);
  // 键盘操作(Enter / Delete / 剪切复制粘贴 / 键入跳转 / 选中跟随焦点),见 tree-keyboard.ts
  const platform = useMemo(() => detectPlatform(), []);
  const typeAheadRef = useRef<TypeAheadState>({ query: '', at: 0 });

  // 实际移到废纸篓(键盘 / 右键共用;确认在 onTrash 里)。
  const runTrash = useCallback(
    (paths: string[]) => {
      void (async () => {
        // 走规范的 mutate-actions.removeItems(遍历全部项、收集所有失败、刷新所有
        // 成功项父目录),而非内联首失早退 —— 旧实现一旦某项 trash 失败就 return,
        // 静默跳过其余选中项(多选删除时后续项既不删也不报错)。removeItems 是
        // 纯 fs+tree helper(已测,且本为唯一生产 trash 路径却从未被调用)。见第七 session
        // R6 完整性批判。「路径已删除」清理(editor tab / 展开集合 / 剪贴板)只对 result.removed 做,在
        // trashItemsAndCleanup 一处完成(已测)。
        const result = await trashItemsAndCleanup(paths, mutateDeps, treeApi, onPathsRemoved);
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
    [mutateDeps, onPathsRemoved, treeApi],
  );

  // 删除后焦点落点:树焦点项(右键时已移到该行)的相邻项。DOM 焦点随之移过去(右键菜单跳过了 Radix 的焦点还原)。
  const focusNeighborOf = useCallback((paths: readonly string[]) => {
    const t = treeRef.current;
    if (t === null) return;
    const rendered = renderedItemsRef.current;
    const focusedId = t.getState().focusedItem;
    const index = rendered.findIndex((it) => it.getId() === focusedId);
    const next = neighborAfterRemoval(rendered, index, paths);
    if (next) focusAndSelect(t, next);
  }, []);

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
        // 与 Cmd+T / header 新建同一条创建流程(createUserTerminal,含按主题设 COLORFGBG):cwd 设到该目录,
        // 归属当前 workspace(虽然 cwd 是子目录),便于跨 workspace 切换时该 terminal 跟随显示/隐藏。
        void createUserTerminal({ cwd: dir });
      },
      onTrash: (paths: string[], afterConfirm?: () => void) => {
        if (paths.length === 0) return;
        // 右键菜单删除(无 afterConfirm)同键盘:确认后焦点与选中移到相邻项(VSCode:下一项,没有则上一项)。
        const moveFocus = afterConfirm ?? (() => focusNeighborOf(paths));
        if (confirmDeleteRef.current) {
          setTrashConfirm({ paths, afterConfirm: moveFocus });
          return;
        }
        moveFocus();
        runTrash(paths);
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
        // 粘贴回原目录 / 粘贴进自身或子目录的处理在 transferEntriesInto 内(与拖动同一判定)。
        void runBatchTransfer(
          kind === 'cut' ? 'move' : 'copy',
          paths,
          destDir,
          `paste(${kind})`,
          'errors.folder.paste_failed',
        );
      },
    }),
    [focusNeighborOf, root, runBatchTransfer, runTrash, tt],
  );

  // 新建(VSCode 同款):成功 → 关输入框、展开父目录、新项选中并获得树焦点,文件随即在编辑器打开;
  // 失败(含同名冲突)→ 输入框与已输入的名字保留,下方内联显示本地化原因,可改名重试或 Esc 放弃。
  const submitCreate = async (name: string): Promise<boolean> => {
    if (!creating) return true;
    const { type, parentDir } = creating;
    const action = type === 'dir' ? createNewDir : createNewFile;
    const r = await action(parentDir, name, mutateDeps, treeApi);
    if (!r.ok) {
      const error = localizeErrorByCode(r.code, r.message);
      // 只回写仍是这次新建的输入框(等待期间已 Esc / 换了新建目标则不动)
      setCreating((c) =>
        c !== null && c.type === type && c.parentDir === parentDir ? { ...c, error } : c,
      );
      return false;
    }
    setCreating(null);
    if (parentDir !== root) {
      const parent = treeRef.current?.getItemInstance(parentDir);
      if (parent && !parent.isExpanded()) parent.expand();
    }
    setPendingReveal({ path: r.newPath, focusRow: type === 'dir' });
    // 新建文件打开后焦点进编辑器,可接着输入(VSCode 同款;单击打开已有文件仍留在树里)
    if (type === 'file') {
      void handleFileOpen(r.newPath).then((ok) => {
        if (ok) focusActiveEditor();
      });
    }
    return true;
  };

  // 子目录错误行「重试」:焦点先回到该目录行(错误行随后卸载,不掉到 body),再重新读取。
  const retryDirLoad = useCallback(
    (dir: string) => {
      const item = tree.getItemInstance(dir);
      item.setFocused();
      tree.updateDomFocus();
      void item.invalidateChildrenIds();
    },
    [tree],
  );

  // Header「刷新」与根目录读取失败时的「重试」共用。
  const refreshAll = () => {
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
  };

  // 列表为空时区分三态(VSCode 同款):读取失败(原因 + 重试)/ 加载中 / 空文件夹。读取失败时 loader 也缓存 [],
  // 靠 rootLoad 区分。
  const renderEmptyState = () => {
    if (typeof rootLoad === 'object') {
      return (
        <div ref={loadFailedRef} className="flex flex-col items-start gap-2 p-4 text-xs">
          <div role="alert" className="break-words text-error">
            {tt('panels.explorer.load_failed', {
              message: localizeErrorByCode(rootLoad.code, rootLoad.message),
            })}
          </div>
          <Button
            variant="outlined"
            size="sm"
            onClick={() => {
              retryFocusPendingRef.current = true;
              setRootLoad(ROOT_LOADING);
              refreshAll();
            }}
          >
            {tt('panels.explorer.retry')}
          </Button>
        </div>
      );
    }
    return (
      // tabIndex=-1:「重试」成功但根目录为空时焦点落在这里(重试按钮已卸载,不掉到 body)
      <div ref={emptyStateRef} tabIndex={-1} className="p-4 text-xs text-fg-dim outline-none" role="status">
        {rootLoad === ROOT_LOADING ? tt('common.loading') : tt('panels.explorer.empty_folder')}
      </div>
    );
  };

  // 「重试」有结果后放焦点:成功且有项 → 树的焦点行;成功但为空 → 空态提示;仍失败 → 新的重试按钮
  // (VSCode 列表重载后焦点回列表)。标记在每种结果下都清掉 —— 残留的标记会在之后根目录出现文件时
  // 把用户在编辑器 / 终端的焦点拉回树。「为空」须等根目录子项真正写入缓存(rootLoad 可能先于树重建到达)。
  useEffect(() => {
    if (!retryFocusPendingRef.current || rootLoad === ROOT_LOADING) return;
    if (typeof rootLoad === 'object') {
      retryFocusPendingRef.current = false;
      loadFailedRef.current?.querySelector('button')?.focus();
    } else if (items.length > 0) {
      retryFocusPendingRef.current = false;
      tree.updateDomFocus();
    } else if (tree.getDataRef<AsyncDataLoaderDataRef>().current.childrenIds?.[root] !== undefined) {
      retryFocusPendingRef.current = false;
      emptyStateRef.current?.focus();
    }
  }, [rootLoad, items, root, tree]);

  // 删除确认框文案(VSCode explorer.confirmDelete):单项按文件 / 文件夹区分,多项列出名字(最多 10 个)。
  const renderTrashConfirm = () => {
    const paths = trashConfirm?.paths ?? EMPTY_PATH_LIST;
    let title = '';
    let names: string[] = EMPTY_PATH_LIST;
    if (paths.length === 1) {
      const p = paths[0]!;
      const data = tree.getDataRef<AsyncDataLoaderDataRef<FileEntry>>().current.itemData?.[p];
      title = tt(
        data?.isDirectory ? 'panels.explorer.trash_confirm.folder' : 'panels.explorer.trash_confirm.file',
        { name: basenamePreserveTrailing(p) },
      );
    } else if (paths.length > 1) {
      title = tt('panels.explorer.trash_confirm.multiple', { count: paths.length });
      names = paths.slice(0, TRASH_CONFIRM_MAX_NAMES).map(basenamePreserveTrailing);
    }
    const more = paths.length > 1 ? paths.length - names.length : 0;
    return (
      <ConfirmDialog
        open={trashConfirm !== null}
        title={title}
        description={
          <>
            {names.length > 0 && (
              <ul className="mb-2 list-none">
                {names.map((n, i) => (
                  <li key={i} className="truncate text-fg">
                    {n}
                  </li>
                ))}
                {more > 0 && (
                  <li>{tt('panels.explorer.trash_confirm.more', { count: more })}</li>
                )}
              </ul>
            )}
            <p>{tt('panels.explorer.trash_confirm.detail')}</p>
          </>
        }
        confirmLabel={tt('panels.explorer.ctx.trash')}
        destructive
        // 焦点显式还给树(不依赖 Modal 记录的 prevFocus:右键打开时那是已卸载的菜单项 → body)。
        // updateDomFocus 在 setTimeout 里聚焦,晚于 Modal 卸载时的焦点还原。
        onCancel={() => {
          setTrashConfirm(null);
          tree.updateDomFocus();
        }}
        onConfirm={() => {
          const pending = trashConfirm;
          setTrashConfirm(null);
          if (pending === null) return;
          pending.afterConfirm?.();
          runTrash(pending.paths);
        }}
      />
    );
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
  // OS 文件 drop 一律在捕获阶段复位拖拽态:落在具体行上时 headless-tree 行 onDrop 先 stopPropagation,
  // 下面冒泡阶段的 handleDrop 收不到;浏览器 drop 后也不再派发 dragleave → 不在此复位则 DropOverlay
  // 残留、dragDepth 不归零(下次拖离不消失)。
  // 落点必须在复位前算好存 ref:React 19 根容器的捕获 / 冒泡是两个原生监听,drop 为离散事件,这里的
  // setState 在 microtask 中 flush,真实浏览器在两个监听回调之间做 microtask checkpoint → 冒泡阶段
  // handleDrop 已是复位后的重渲闭包(hoverTarget === null),再从闭包解析会退化成 root。
  // 记录松手所在的已渲染行(供 suppressNextDropScroll 把焦点放回该行);不在行上则 null。
  // 用 contains 而非 instanceof:dockview 弹出窗口里的节点属另一 realm。
  const findRenderedRowId = (node: EventTarget | null): string | null => {
    if (!node) return null;
    for (const v of virtualizer.getVirtualItems()) {
      const it = rows[v.index];
      if (it === undefined || isDirLoadErrorRow(it)) continue;
      if (it.getElement()?.contains(node as Node)) return it.getId();
    }
    return null;
  };
  const handleDropCapture = (e: React.DragEvent) => {
    dropRowIdRef.current = findRenderedRowId(e.target);
    if (!hasFiles(e.dataTransfer)) return;
    foreignDropTargetRef.current = resolveDropTarget(hoverTarget, root);
    dragDepthRef.current = 0;
    setDragActive(false);
    setHoverTarget(null);
  };
  const handleDrop = async (e: React.DragEvent) => {
    // OS 文件 drop 落在 Explorer 内(空白处 / [role=tree] 容器)即由本面板消费:stopPropagation,别再冒泡到
    // App 的 window 级 drop 监听 —— 否则拖文件夹进文件树空白处,刚复制进 root,窗口 workspace 又被切到源文件夹。
    // 行级 drop 已由 headless-tree stopPropagation。不能改由 App 监听判 defaultPrevented:dockview 根
    // Droptarget 的 drop 无条件 preventDefault,那样会打断「拖文件夹到 dock 区域打开为 workspace」。
    if (hasFiles(e.dataTransfer)) e.stopPropagation();
    // headless-tree 容器 [role=tree] 的 onDrop 已处理(落点 root)时只 preventDefault 不 stopPropagation:
    // 再处理一次 = 同一批文件写两次 / 重复 move。行级 drop 已 stopPropagation,空白处无人 preventDefault。
    if (e.defaultPrevented) return;
    // 内部 drag drop 到空白(root level)— headless-tree row onDrop 接不到 root row
    if (!hasFiles(e.dataTransfer)) {
      const dnd = tree.getState().dnd;
      if (!dnd?.draggedItems || dnd.draggedItems.length === 0) return;
      e.preventDefault();
      // 已经在 root 下的不动(VSCode 同款)。selectRootDropMoveablePaths 只用于「全在 root 下」早退;
      // 实际交给漏斗的是全部拖动路径 —— 漏斗先剔后代再跳过同父项。若交预筛结果,
      // 多选 root 下的 A 与 A/B 时 A 被预先剔掉,只剩 A/B 被移到 root,层级被拆散。
      if (selectRootDropMoveablePaths(dnd.draggedItems, root).length === 0) return;
      await runBatchTransfer(
        'move',
        selectDraggedItemPaths(dnd.draggedItems),
        root,
        'root drop move',
        'errors.folder.move_failed',
      );
      return;
    }
    e.preventDefault();
    // 拖拽态已在 handleDropCapture 复位;落点取其复位前存下的值(读后清空)
    const target = foreignDropTargetRef.current ?? resolveDropTarget(hoverTarget, root);
    foreignDropTargetRef.current = null;
    await dropForeignFilesInto(e.dataTransfer.items, target, coApi.fs, refreshParent);
  };

  return (
    <div
      className="relative flex h-full w-full flex-col"
      onDragEnter={handleDragEnter}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDropCapture={handleDropCapture}
      onDrop={handleDrop}
    >
      <ExplorerHeader
        root={root}
        onExpandAll={() => {
          // 异步,大目录会触发大量 listDir;用户主动行为,不防抖。store 回写批末合并一次。
          expandAll(tree);
        }}
        onCollapseAll={() => tree.collapseAll()}
        onRefresh={refreshAll}
        onNewFile={() => setCreating({ type: 'file', parentDir: root })}
        onNewDir={() => setCreating({ type: 'dir', parentDir: root })}
      />
      {dragActive && <DropOverlay targetDir={dropTargetDir} />}
      {creating && (
        <CreateInput
          type={creating.type}
          parentDir={creating.parentDir}
          rootPath={root}
          onSubmit={submitCreate}
          onCancel={() => setCreating(null)}
          error={creating.error}
          onEdit={() => setCreating((c) => (c?.error ? { ...c, error: undefined } : c))}
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
            renderEmptyState()
          ) : (
            <div
              // a11y(A25):headless-tree role="tree" 默认 aria-label="" → 屏幕阅读器进主文件树
              // 只感知无名 tree。传本地化 treeLabel 给容器一个可访问名。
              {...tree.getContainerProps(tt('panels.explorer.tree_aria'))}
              onKeyDown={(e) => {
                handleTreeKeyDown(e.nativeEvent, {
                  tree,
                  items,
                  actions: contextActions,
                  openFile: (path) => void handleFileOpen(path),
                  rootPath: root,
                  platform,
                  typeAhead: typeAheadRef.current,
                });
              }}
              style={{
                height: virtualizer.getTotalSize(),
                width: '100%',
                position: 'relative',
              }}
            >
              {virtualizer.getVirtualItems().map((vRow) => {
                const item = rows[vRow.index];
                if (!item) return null;
                if (isDirLoadErrorRow(item)) {
                  return (
                    <DirLoadErrorRow
                      key={`error:${item.dir}`}
                      row={item}
                      start={vRow.start}
                      indent={indent}
                      onRetry={retryDirLoad}
                    />
                  );
                }
                return (
                  <FileRow
                    key={item.getId()}
                    item={item}
                    {...readFileRowState(item, tree)}
                    start={vRow.start}
                    getSelectedPaths={getSelectedPaths}
                    rootPath={root}
                    contextActions={contextActions}
                    onHoverDropTarget={reportHoverTarget}
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
      {renderTrashConfirm()}
    </div>
  );
}
