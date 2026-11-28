// 外部文件同步(useExternalFileSync)所需的 watcher,不绑在可见的文件树上。
//
// 参考 VSCode:文件监视由 FileService 统一 watch 工作区,与 Explorer 是否可见无关。此前同步完全复用
// Explorer 文件树(FolderTree → useFsWatcher)的 watcher:侧栏持久化为关闭时文件树从不挂载、不装
// watcher(ExplorerSidebar 刻意不做树 IO),侧栏隐藏期间切 root 也卸载文件树 → 整个会话打开的 tab 收不到
// 外部修改,保存时才报 EDITOR_DISK_CHANGED。
//
// 有打开的 tab 时持有 workspace root 的 watcher(只 watch,不 listDir,不破坏「侧栏关着不做树 IO」):
// - main 按 path 引用计数,与 Explorer 的 root watcher 共享同一个 fs.watch;同 tick 同路径广播合并,
//   不产生重复 dir-changed。
// - 复用 useFsWatcher 的安装 / 竞态 / watch-lost 退避重装;重装成功分发 watch-restored,由
//   useExternalFileSync 重读 root 子树内的 clean tab。
// - macOS / Windows 递归覆盖整个工作区;Linux 非递归,只覆盖 root 直接子项,深层目录仍依赖 Explorer
//   已展开目录的 watcher。不为每个 tab 父目录各装 watcher:macOS 上每个都是递归 FSEvents 流,且会挤占
//   main 的 64 个 watcher LRU 名额(驱逐 Explorer 的展开目录 watcher)。
//
// 与 useExternalFileSync 同由常驻 MainApp 承载(每窗口一次)。
//
// 工作区外的文件(及没打开文件夹时的任何文件)不在根 watcher 覆盖范围内 —— 对齐 VSCode editorService.handleVisibleEditorsChange:
// **可见**的(各编辑器组的活动 tab)工作区外文件单独 watch(main fs:watch-file 对其父目录装非递归 watcher,变化照常经
// fs:dir-changed 送达 useExternalFileSync),不再可见 / 关闭即释放。不可见期间的变化没有事件:再次可见时按 stat
// (mtime + size)与上次所见比对,变了就复查一次(经本地 watch-restored,与 watcher 恢复同一出口);窗口获焦时同样比对可见的
// 这类文件(VSCode TextFileEditorTracker 获焦时重载可见编辑器,「文件事件不总可靠」)。图片 tab 不经 fs:read-file 读取,
// main 不接受其 watch,只靠 stat 比对。BDD: src/__tests__/external-sync-outside-workspace/

import { useEffect, useMemo, useRef } from 'react';
import { coApi } from '@/lib/co-api';
import { emitWatchRestored } from '@/lib/fs-watch-restored';
import { isSameOrInsidePath } from '@/lib/path-cross';
import { useFsWatcher, type FsWatchApi } from '@/panels/Explorer/hooks/useFsWatcher';
import { editorGroupsOf, useEditorStore, type EditorTab } from '@/stores/editor.store';
import { useWorkspaceStore } from '@/stores/workspace.store';
import { isUntitledPath } from '../../../electron/shared/untitled';
import { ERROR_CODES } from '../../../electron/shared/error-codes';
import { isImagePreviewPath } from './editor-image';

const NO_WATCH: ReadonlySet<string> = new Set();
// 只要 watcher 本身:dir-changed 由 useExternalFileSync 订阅处理。
const noop = (): void => {};

export function useExternalSyncRootWatch(): void {
  const root = useWorkspaceStore((s) => s.root);
  const hasTabs = useEditorStore((s) => s.tabs.length > 0);
  const paths = useMemo(
    () => (root !== null && hasTabs ? new Set([root]) : NO_WATCH),
    [root, hasTabs],
  );
  useFsWatcher(paths, noop, root ?? undefined);
  useOutsideWorkspaceFileWatch(root);
}

// 路径里不会出现 NUL:选择器返回拼接串(值相等即不重渲染)。
const SEP = '\u0000';

const FILE_WATCH_API: FsWatchApi = {
  watch: (p) => coApi.fs.watchFile(p),
  unwatch: (p) => coApi.fs.unwatchFile(p),
};

function isOutside(tab: EditorTab, root: string | null): boolean {
  if (isUntitledPath(tab.filePath)) return false;
  return root === null || !isSameOrInsidePath(root, tab.filePath);
}

/** 打开的工作区外文件 tab 的路径(拼接串)。 */
function outsideTabsKey(tabs: readonly EditorTab[], root: string | null): string {
  let out = '';
  for (const t of tabs) if (isOutside(t, root)) out += (out === '' ? '' : SEP) + t.filePath;
  return out;
}

/** 各编辑器组的活动 tab 中工作区外的文件路径(拼接串,去重)。 */
function visibleOutsideKey(
  s: Parameters<typeof editorGroupsOf>[0],
  root: string | null,
): string {
  const seen = new Set<string>();
  for (const g of editorGroupsOf(s)) {
    if (g.activeTabId === null) continue;
    const tab = s.tabs.find((t) => t.id === g.activeTabId);
    if (tab && isOutside(tab, root)) seen.add(tab.filePath);
  }
  return [...seen].join(SEP);
}

const splitKey = (key: string): Set<string> => new Set(key === '' ? [] : key.split(SEP));

/** stat 指纹:存在 → mtime:size;确认不存在 → 'missing';无法确定 → null(不比对)。 */
async function statSignature(path: string): Promise<string | null> {
  try {
    const r = await coApi.fs.stat(path);
    if (r.ok) return `${r.data.mtimeMs}:${r.data.size}`;
    return r.code === ERROR_CODES.FS_NOT_FOUND ? 'missing' : null;
  } catch {
    return null;
  }
}

function useOutsideWorkspaceFileWatch(root: string | null): void {
  const openKey = useEditorStore((s) => outsideTabsKey(s.tabs, root));
  const visibleKey = useEditorStore((s) => visibleOutsideKey(s, root));
  const visible = useMemo(() => splitKey(visibleKey), [visibleKey]);
  const watched = useMemo(() => new Set([...visible].filter((p) => !isImagePreviewPath(p))), [visible]);
  useFsWatcher(watched, noop, undefined, FILE_WATCH_API);

  // 每个打开的工作区外文件上次所见的 stat 指纹(打开时记基线;关闭即删)。
  const sigsRef = useRef(new Map<string, string>());
  const visibleRef = useRef(visible);
  visibleRef.current = visible;

  // 比对:与上次所见不同 → 复查该文件(干净 tab 重读、脏 tab 查存在性,见 useExternalFileSync reloadSubtree);无基线只记基线。
  const recheck = useRef((path: string): void => {
    void statSignature(path).then((sig) => {
      if (sig === null) return;
      const sigs = sigsRef.current;
      const prev = sigs.get(path);
      sigs.set(path, sig);
      if (prev !== undefined && prev !== sig) emitWatchRestored(path);
    });
  }).current;

  useEffect(() => {
    const open = splitKey(openKey);
    const sigs = sigsRef.current;
    for (const p of [...sigs.keys()]) if (!open.has(p)) sigs.delete(p);
    for (const p of open) {
      if (sigs.has(p)) continue;
      void statSignature(p).then((sig) => {
        if (sig !== null && !sigs.has(p)) sigs.set(p, sig);
      });
    }
  }, [openKey]);

  // 再次可见:不可见期间没有 watcher,比对一次。
  const prevVisibleRef = useRef<ReadonlySet<string>>(new Set());
  useEffect(() => {
    const prev = prevVisibleRef.current;
    prevVisibleRef.current = visible;
    for (const p of visible) if (!prev.has(p) && sigsRef.current.has(p)) recheck(p);
  }, [visible, recheck]);

  useEffect(() => {
    const onFocus = (): void => {
      for (const p of visibleRef.current) recheck(p);
    };
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [recheck]);
}
