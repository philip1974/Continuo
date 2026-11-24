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

import { useMemo } from 'react';
import { useFsWatcher } from '@/panels/Explorer/hooks/useFsWatcher';
import { useEditorStore } from '@/stores/editor.store';
import { useWorkspaceStore } from '@/stores/workspace.store';

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
}
