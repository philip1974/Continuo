// 从资源管理器树拖到编辑器组(对齐 VSCode editorDropTarget + ResourcesDropHandler;BDD: src/__tests__/explorer-drag-out/):
// - 拖到编辑器组(dock tab 栏、组内 tab 栏或内容区)→ dockview 的放置高亮;放下 → 在该组以常驻方式打开(VSCode pinned: true),
//   多选打开多个,第一个成为活动编辑器(VSCode openEditors:第一个激活,其余不激活),该组获焦;
// - 拖到内容区的左 / 右 / 上 / 下边缘 → 在那一侧拆出新编辑器组并在其中打开(VSCode 按落点拆分);
// - 文件夹不打开(VSCode 资源拖放数据里不含文件夹;它把单独拖入的文件夹当作工作区在新窗口打开,这里不做)。
// 编辑器组自己的 tab 栏在 dock 面板内容里:dockview 会把它当内容区顶部边缘(拆分),而 VSCode 的 tab 栏是放进该组 ——
// tab 栏自己接收(useEditorTabBarDrop),经过它时不接受 dockview 的内容区高亮。
// 只接收树拖出的自定义 MIME(dockview 自己的 tab / 组拖动有面板数据,不走这里;OS 文件拖放不变)。
// dockview 的放置监听随组进 popout 子窗,不用另绑子窗文档。

import { useCallback, useState, type DragEvent as ReactDragEvent } from 'react';
import type { DockviewApi, DockviewGroupPanel, Position } from 'dockview-react';
import { isEditorGroupId } from '../../../electron/shared/editor-group-id';
import { readExplorerDragData, hasExplorerDrag } from '@/lib/explorer-drag';
import { useEditorStore } from '@/stores/editor.store';
import { openFileByPath } from '@/panels/Editor/editor-file-actions';
import { editorFileDeps } from '@/panels/Editor/editor-file-deps';
import { findEditorFileTabByPath } from '@/panels/Editor/editor-tab-lookup';
import { splitEditor, type SplitDirection } from '@/panels/Editor/editor-groups-actions';
import { requestEditorFocus } from '@/panels/Editor/editor-focus-registry';
import { openFileOrNotify } from '@/notifications/notify-open-failed';
import { basenamePreserveTrailing } from '@/panels/Explorer/path-utils';

const EDITOR_PANEL_TYPE = 'editor';

/** 编辑器组 tab 栏根元素上的标记(useEditorTabBarDrop 的接收区)。 */
export const EDITOR_TAB_BAR_ATTR = 'data-editor-tab-bar';

/** 拖动事件落在编辑器组的 tab 栏里(按事件目标;popout 子窗的元素不是本窗口的 Element,不用 instanceof)。 */
export function isOverEditorTabBar(event: Pick<Event, 'target'>): boolean {
  const target = event.target as { closest?: (selector: string) => unknown } | null;
  return typeof target?.closest === 'function' && target.closest(`[${EDITOR_TAB_BAR_ATTR}]`) !== null;
}

/** dock 组当前显示的是编辑器组面板 → 该编辑器组 id;否则(终端、设置、插件面板,或没有组)undefined。 */
export function editorGroupIdOfDockGroup(group: Pick<DockviewGroupPanel, 'activePanel'> | undefined): string | undefined {
  const panel = group?.activePanel;
  if (!panel || !isEditorGroupId(panel.id) || panel.view?.contentComponent !== EDITOR_PANEL_TYPE) return undefined;
  return panel.id;
}

/** 落点 → 拆分方向(中央 / tab 栏 = 不拆分,放进该组)。 */
export function splitDirectionOfDrop(position: Position): SplitDirection | undefined {
  switch (position) {
    case 'left':
      return 'left';
    case 'right':
      return 'right';
    case 'top':
      return 'up';
    case 'bottom':
      return 'down';
    default:
      return undefined;
  }
}

/**
 * 在编辑器组 groupId(给了 direction → 先在它那一侧拆出新组)以常驻方式依次打开 paths;第一个打开成功的成为该组活动编辑器并获焦。
 * 打不开的照常提示(与资源管理器单击打开同一套反馈)。
 */
export async function openDroppedFiles(
  paths: readonly string[],
  groupId: string,
  direction?: SplitDirection,
): Promise<void> {
  let target = groupId;
  if (direction !== undefined && splitEditor(direction, { groupId, tabId: null })) {
    target = useEditorStore.getState().activeGroupId;
  }
  let first: string | null = null;
  for (const path of paths) {
    const ok = await openFileOrNotify(
      () => openFileByPath(path, editorFileDeps, { preview: false, groupId: target }),
      basenamePreserveTrailing(path),
      'editor-drop',
      (encoding) => openFileByPath(path, editorFileDeps, { preview: false, groupId: target, encoding }),
    );
    if (ok && first === null) first = findEditorFileTabByPath(useEditorStore.getState().tabs, path)?.id ?? null;
  }
  if (first === null) return;
  useEditorStore.getState().switchTab(first, { groupId: target });
  requestEditorFocus(first, target);
}

export type OpenDroppedFiles = (paths: readonly string[], groupId: string, direction?: SplitDirection) => unknown;

export function trackExplorerEditorDrop(
  api: Pick<DockviewApi, 'onUnhandledDragOverEvent' | 'onDidDrop'>,
  open: OpenDroppedFiles = openDroppedFiles,
): { dispose: () => void } {
  const subs = [
    // 拖动经过:接受 → dockview 显示放置高亮(中央 = 放进该组,边缘 = 拆分)。整个 dock 外缘('edge',无组)不接收。
    api.onUnhandledDragOverEvent((event) => {
      if (event.target === 'edge' || event.getData() !== undefined) return;
      if (!hasExplorerDrag(event.nativeEvent.dataTransfer)) return;
      if (event.target === 'content' && isOverEditorTabBar(event.nativeEvent)) return; // tab 栏自己接收
      if (editorGroupIdOfDockGroup(event.group) === undefined) return;
      event.accept();
    }),
    api.onDidDrop((event) => {
      if (event.getData() !== undefined) return;
      const groupId = editorGroupIdOfDockGroup(event.group);
      if (groupId === undefined) return;
      const data = readExplorerDragData(event.nativeEvent.dataTransfer);
      if (!data) return;
      const files: string[] = [];
      for (const entry of data.entries) if (!entry.isDirectory) files.push(entry.path);
      if (files.length === 0) return;
      void open(files, groupId, splitDirectionOfDrop(event.position));
    }),
  ];
  return {
    dispose: () => {
      for (const sub of subs) sub.dispose();
    },
  };
}

/**
 * 编辑器组 tab 栏的放置区:树拖出的文件拖到 tab 栏 → 高亮整条 tab 栏,放下 → 在该组常驻打开(VSCode:拖到 tab 栏放进该组,不拆分)。
 * 返回 isOver(高亮)与要挂到 tab 栏根元素上的属性 / 事件。
 */
export function useEditorTabBarDrop(groupId: string): {
  readonly isOver: boolean;
  readonly props: {
    readonly [EDITOR_TAB_BAR_ATTR]: '';
    readonly onDragEnter: (e: ReactDragEvent<HTMLElement>) => void;
    readonly onDragOver: (e: ReactDragEvent<HTMLElement>) => void;
    readonly onDragLeave: (e: ReactDragEvent<HTMLElement>) => void;
    readonly onDrop: (e: ReactDragEvent<HTMLElement>) => void;
  };
} {
  const [isOver, setOver] = useState(false);
  const onDragOver = useCallback((e: ReactDragEvent<HTMLElement>) => {
    if (!hasExplorerDrag(e.dataTransfer)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    setOver(true);
  }, []);
  const onDragLeave = useCallback((e: ReactDragEvent<HTMLElement>) => {
    const next = e.relatedTarget as Node | null;
    if (next !== null && e.currentTarget.contains(next)) return;
    setOver(false);
  }, []);
  const onDrop = useCallback(
    (e: ReactDragEvent<HTMLElement>) => {
      if (!hasExplorerDrag(e.dataTransfer)) return;
      e.preventDefault();
      e.stopPropagation();
      setOver(false);
      const data = readExplorerDragData(e.dataTransfer);
      const files: string[] = [];
      for (const entry of data?.entries ?? []) if (!entry.isDirectory) files.push(entry.path);
      if (files.length > 0) void openDroppedFiles(files, groupId);
    },
    [groupId],
  );
  return {
    isOver,
    props: { [EDITOR_TAB_BAR_ATTR]: '', onDragEnter: onDragOver, onDragOver, onDragLeave, onDrop },
  };
}
