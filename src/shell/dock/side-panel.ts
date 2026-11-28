// 侧栏型面板(VSCode 侧栏视图:搜索、运行和调试):新建时放在主窗 dock 网格最左侧的独立组(全高,相当于 VSCode 侧栏位置),
// 已存在只聚焦不挪动(用户拖到别处后随 dock 布局持久化)。只含侧栏面板的组不接收从主窗入口新建的其它面板(VSCode:编辑器 /
// 面板区的视图不进侧栏),见 group-mru mainWindowAddPosition。BDD: src/__tests__/workspace-search/(1a)
// 叶子模块:group-mru / dock-api-ref / layout.default 都引用它,不反向依赖它们。

import type { IDockviewGroupPanel } from 'dockview-react';
import { SIDEBAR_DEFAULT_WIDTH } from '@/stores/layout-ui.store';

/** 搜索面板 id(= 面板类型,单例)。 */
export const SEARCH_PANEL_ID = 'search';

const SIDE_PANEL_IDS: ReadonlySet<string> = new Set([SEARCH_PANEL_ID]);

/** 调试面板类型(多实例:id 为 `debug-<n>`,见 dock-panel-actions nextPanelId)。 */
export const DEBUG_PANEL_TYPE = 'debug';
const DEBUG_PANEL_ID = /^debug(?:-\d+)?$/;

/**
 * 侧栏面板:搜索,及运行和调试(VSCode 调试视图在侧栏 —— 与编辑器分开放,点调用栈帧打开文件时不会把调试视图自己藏起来;
 * BDD: src/__tests__/debug-user-controls/)。
 */
export const isSidePanelId = (id: string): boolean => SIDE_PANEL_IDS.has(id) || DEBUG_PANEL_ID.test(id);

export const isSidePanelType = (type: string): boolean => type === SEARCH_PANEL_ID || type === DEBUG_PANEL_TYPE;

/** 新建侧栏面板的落点:主窗网格最左侧(dockview 绝对位置,orthogonalize 后插在根的首位)。 */
export const SIDE_PANEL_POSITION = { direction: 'left' } as const;

/** 新建侧栏面板的初始宽:同资源管理器侧栏默认宽。 */
export const SIDE_PANEL_INITIAL_WIDTH = SIDEBAR_DEFAULT_WIDTH;

/**
 * 新建侧栏面板的落点:已有只含侧栏面板的组(主窗网格里)→ 作为 tab 加进去(VSCode 侧栏一次显示一个视图),否则主窗网格最左侧。
 */
export function sidePanelAddPosition(api: {
  readonly groups: readonly IDockviewGroupPanel[];
}): { readonly referenceGroup: IDockviewGroupPanel; readonly direction: 'within' } | typeof SIDE_PANEL_POSITION {
  const group = api.groups.find((g) => g.api.location.type === 'grid' && isSidePanelGroup(g));
  return group ? { referenceGroup: group, direction: 'within' } : SIDE_PANEL_POSITION;
}

/** 组里只有侧栏面板(空组不算)。 */
export function isSidePanelGroup(group: Pick<IDockviewGroupPanel, 'panels'>): boolean {
  return group.panels.length > 0 && group.panels.every((panel) => isSidePanelId(panel.id));
}
