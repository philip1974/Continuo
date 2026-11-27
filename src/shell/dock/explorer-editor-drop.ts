// 从资源管理器树拖到编辑器组(对齐 VSCode editorDropTarget + ResourcesDropHandler;BDD: src/__tests__/explorer-drag-out/):
// - 拖到编辑器组(dock tab 栏、组内 tab 栏或内容区)→ dockview 的放置高亮;放下 → 在该组以常驻方式打开(VSCode pinned: true),
//   多选打开多个,第一个成为活动编辑器(VSCode openEditors:第一个激活,其余不激活),该组获焦;
// - 拖到内容区的左 / 右 / 上 / 下边缘 → 在那一侧拆出新编辑器组并在其中打开(VSCode 按落点拆分);
// - 文件夹不打开(VSCode 资源拖放数据里不含文件夹;它把单独拖入的文件夹当作工作区在新窗口打开,这里不做)。
// - 编辑器内容区不把路径插进文档(codemirror-media-drop / milkdown-media-drop 拦下文本插入);按住 ⇧ 放到文本上 = 插入
//   (VSCode editor.dropIntoEditor),这里不接收。
// 编辑器组自己的 tab 栏在 dock 面板内容里:dockview 会把它当内容区顶部边缘(拆分),而 VSCode 的 tab 栏是放进该组 ——
// tab 栏自己接收(useEditorTabBarDrop),经过它时不接受 dockview 的内容区高亮。
// 只接收树拖出的自定义 MIME(dockview 自己的 tab / 组拖动有面板数据,不走这里;从 Finder 拖来的文件见 os-file-drop)。
// dockview 的放置监听随组进 popout 子窗,不用另绑子窗文档。

import { useCallback, useState, type DragEvent as ReactDragEvent } from 'react';
import type { DockviewApi, DockviewGroupPanel, Position } from 'dockview-react';
import { isEditorGroupId } from '../../../electron/shared/editor-group-id';
import { readExplorerDragData, hasExplorerDrag } from '@/lib/explorer-drag';
import { useEditorStore } from '@/stores/editor.store';
import { openFileByPath } from '@/panels/Editor/editor-file-actions';
import { editorFileDeps } from '@/panels/Editor/editor-file-deps';
import { findEditorFileTabByPath } from '@/panels/Editor/editor-tab-lookup';
import { commandEditorGroupId, splitEditor, type SplitDirection } from '@/panels/Editor/editor-groups-actions';
import { getDockApi } from './dock-api-ref';
import { rightNeighborGroup } from './group-sizes';
import { activateDockPanel } from './wrap-panel-close';
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

/**
 * ⇧ 拖到可编辑的文本内容上(代码编辑器 / Markdown 源码 · 编辑视图):VSCode 按住 ⇧ 放下 = 插入到编辑器里(由编辑器自己处理,
 * 见 codemirror-media-drop / milkdown-media-drop),不打开、不拆分 —— dockview 不接收也不显示放置高亮。
 */
export function isShiftDropIntoText(event: Pick<DragEvent, 'target' | 'shiftKey'>): boolean {
  if (!event.shiftKey) return false;
  const target = event.target as { closest?: (selector: string) => unknown } | null;
  return typeof target?.closest === 'function' && target.closest('[contenteditable="true"]') !== null;
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

export interface OpenInGroupOptions {
  /** 以预览方式打开(缺省 false = 常驻)。 */
  readonly preview?: boolean;
  /**
   * 不动焦点、活动编辑器组不变(VSCode preserveFocus 打开到 SIDE_GROUP:该组不激活)。缺省 false:目标组成为活动组并获焦。
   */
  readonly preserveFocus?: boolean;
}

/**
 * 在编辑器组 groupId(给了 direction → 先在它那一侧拆出新组)依次打开 paths(缺省常驻);第一个打开成功的成为该组活动编辑器并获焦。
 * groupId 缺省 = 活动编辑器组(从 Finder 拖到编辑区以外,见 os-file-drop)。打不开的照常提示(与资源管理器单击打开同一套反馈)。
 * preserveFocus:打开后把活动编辑器组还给打开前的组,不聚焦编辑器。
 */
export async function openDroppedFiles(
  paths: readonly string[],
  groupId: string | undefined,
  direction?: SplitDirection,
  opts: OpenInGroupOptions = {},
): Promise<void> {
  const preview = opts.preview ?? false;
  const activeBefore = useEditorStore.getState().activeGroupId;
  let target = groupId;
  if (
    groupId !== undefined &&
    direction !== undefined &&
    splitEditor(direction, opts.preserveFocus === true ? { groupId, tabId: null, focus: false } : { groupId, tabId: null })
  ) {
    target = useEditorStore.getState().activeGroupId;
  }
  const inGroup = target === undefined ? {} : { groupId: target };
  let first: string | null = null;
  for (const path of paths) {
    const ok = await openFileOrNotify(
      () => openFileByPath(path, editorFileDeps, { preview, ...inGroup }),
      basenamePreserveTrailing(path),
      'editor-drop',
      (encoding) => openFileByPath(path, editorFileDeps, { preview, ...inGroup, encoding }),
    );
    if (ok && first === null) first = findEditorFileTabByPath(useEditorStore.getState().tabs, path)?.id ?? null;
  }
  if (first === null) return;
  const group = target ?? useEditorStore.getState().activeGroupId;
  useEditorStore.getState().switchTab(first, { groupId: group });
  if (opts.preserveFocus === true) {
    restoreActiveEditorGroup(activeBefore);
    return;
  }
  requestEditorFocus(first, group);
}

/** 活动编辑器组还给 groupId(store 与 dock 活动面板一起;不移动 DOM 焦点)。 */
function restoreActiveEditorGroup(groupId: string): void {
  const store = useEditorStore.getState();
  if (store.activeGroupId === groupId) return;
  const panel = getDockApi()?.getPanel(groupId);
  if (panel) activateDockPanel(panel);
  store.setActiveGroup(groupId);
}

/**
 * 资源管理器「在侧边打开」(VSCode explorer.openToSide / ⌥ 单击 → SIDE_GROUP):打开到源组(触发窗口的活动编辑器组)右侧紧挨着的
 * 编辑器组,右边没有编辑器组就向右拆分出新组。文件夹由调用方滤掉。
 * - 右键菜单 / ⌃Enter:常驻打开,侧边组成为活动组并获焦(多选时依次打开,第一个成为活动编辑器);
 * - ⌥ 单击:与单击一样以预览方式、焦点留在资源管理器,且活动组不变(VSCode 对 SIDE_GROUP + preserveFocus 不激活该组 ——
 *   反复 ⌥ 单击都落在同一个侧边组,不会每次再拆一个);⌥ 双击常驻并聚焦。
 * dock 未就绪 / 没有源组 → 按普通方式在活动组打开。BDD: src/__tests__/explorer-open-to-side/
 */
export async function openFilesToSide(paths: readonly string[], opts: OpenInGroupOptions = {}): Promise<void> {
  if (paths.length === 0) return;
  const side = sideTarget();
  await openDroppedFiles(paths, side?.groupId, side?.direction, opts);
}

/** 侧边组:源组右侧紧挨着的编辑器组;没有 → 在源组右侧拆分(direction)。dock 未就绪 / 没有源组 → undefined。 */
function sideTarget(): { readonly groupId: string; readonly direction?: 'right' } | undefined {
  const api = getDockApi();
  const source = commandEditorGroupId();
  const sourcePanel = source === undefined ? undefined : api?.getPanel(source);
  if (!api || source === undefined || !sourcePanel) return undefined;
  const side = editorGroupIdOfDockGroup(rightNeighborGroup(api, sourcePanel.group));
  return side !== undefined ? { groupId: side } : { groupId: source, direction: 'right' };
}

/**
 * 「在侧边打开」的目标编辑器组 id(Quick Open ⌘Enter / 搜索结果 ⌃Enter 等自行打开的入口;规则同 openFilesToSide):右边没有
 * 编辑器组就先向右拆出新组。调用方把它作为 OpenFileOptions.groupId 打开(该组随之成为活动组)。dock 未就绪 / 没有源组 →
 * undefined(按普通方式在活动组打开)。
 */
export function takeSideEditorGroup(): string | undefined {
  const side = sideTarget();
  if (side === undefined || side.direction === undefined) return side?.groupId;
  return splitEditor(side.direction, { groupId: side.groupId, tabId: null })
    ? useEditorStore.getState().activeGroupId
    : side.groupId;
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
      if (event.target === 'content' && isShiftDropIntoText(event.nativeEvent)) return; // ⇧ 放下插入,编辑器处理
      if (editorGroupIdOfDockGroup(event.group) === undefined) return;
      event.accept();
    }),
    api.onDidDrop((event) => {
      if (event.getData() !== undefined) return;
      if (isShiftDropIntoText(event.nativeEvent)) return;
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
