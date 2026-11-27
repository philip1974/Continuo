// 侧栏型面板(VSCode 侧栏视图;目前只有搜索):新建时放在主窗 dock 网格最左侧的独立组(全高,相当于 VSCode 侧栏位置),
// 已存在只聚焦不挪动(用户拖到别处后随 dock 布局持久化)。只含侧栏面板的组不接收从主窗入口新建的其它面板(VSCode:编辑器 /
// 面板区的视图不进侧栏),见 group-mru mainWindowAddPosition。BDD: src/__tests__/workspace-search/(1a)
// 叶子模块:group-mru / dock-api-ref / layout.default 都引用它,不反向依赖它们。

import type { IDockviewGroupPanel } from 'dockview-react';
import { SIDEBAR_DEFAULT_WIDTH } from '@/stores/layout-ui.store';

/** 搜索面板 id(= 面板类型,单例)。 */
export const SEARCH_PANEL_ID = 'search';

const SIDE_PANEL_IDS: ReadonlySet<string> = new Set([SEARCH_PANEL_ID]);

export const isSidePanelId = (id: string): boolean => SIDE_PANEL_IDS.has(id);

/** 新建侧栏面板的落点:主窗网格最左侧(dockview 绝对位置,orthogonalize 后插在根的首位)。 */
export const SIDE_PANEL_POSITION = { direction: 'left' } as const;

/** 新建侧栏面板的初始宽:同资源管理器侧栏默认宽。 */
export const SIDE_PANEL_INITIAL_WIDTH = SIDEBAR_DEFAULT_WIDTH;

/** 组里只有侧栏面板(空组不算)。 */
export function isSidePanelGroup(group: Pick<IDockviewGroupPanel, 'panels'>): boolean {
  return group.panels.length > 0 && group.panels.every((panel) => isSidePanelId(panel.id));
}
