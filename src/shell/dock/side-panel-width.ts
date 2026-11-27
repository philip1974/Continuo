// 侧栏型面板组(只含搜索,见 side-panel)保持自身宽度(VSCode:侧栏 LayoutPriority.Low —— 窗口缩放、编辑区增删组时侧栏宽不变,
// 窗口变窄时编辑区先缩到 220,之后侧栏才缩,最窄 170)。dockview 6 的网格按比例布局(proportionalLayout,无每视图的
// LayoutPriority / 不按比例的开关),在它旁边新建组会把它劈成一半、窗口缩放时随之按比例缩放。这里在布局变化后校正:
//  - 记下:容器宽与组集合都没变的布局变化(用户拖分隔条、双击等分、新建时设的初始宽)后侧栏组的宽
//  - 恢复:容器宽变了(窗口缩放、资源管理器侧栏开关)或组增删(在它右侧新建组)后,宽 = clamp(记下的宽, 170, 容器宽 − 220)
//  - 只管主窗网格里全高的侧栏组(侧栏位置);独占整行(主窗只剩它)、隐藏(其它组最大化)时不记也不恢复
//  - 侧栏组最小宽 170(组约束;不再是侧栏组时恢复 dockview 默认)
// BDD: src/__tests__/workspace-search/(1a)

import type { DockviewApi, IDockviewGroupPanel } from 'dockview-react';
import { isSidePanelGroup } from './side-panel';

/** 侧栏组最小宽(VSCode 侧栏 minimumWidth 170)。 */
export const SIDE_PANEL_MIN_WIDTH = 170;
/** 窗口变窄时编辑区先缩到的宽(VSCode 编辑区 minimumWidth 220),之后侧栏才缩。 */
export const SIDE_PANEL_EDITOR_MIN_WIDTH = 220;
/** dockview 组的默认最小宽(MINIMUM_DOCKVIEW_GROUP_PANEL_WIDTH)。 */
const DOCKVIEW_GROUP_MIN_WIDTH = 100;

function isSideColumn(api: DockviewApi, group: IDockviewGroupPanel): boolean {
  return (
    group.api.location.type === 'grid' &&
    group.api.isVisible &&
    isSidePanelGroup(group) &&
    group.api.height >= api.height - 1 &&
    group.api.width < api.width - 1
  );
}

export function keepSidePanelWidth(api: DockviewApi): { dispose: () => void } {
  const pinned = new Map<string, number>();
  const constrained = new Set<string>();
  // 本模块设的宽:宽仍是它时的布局变化不当作用户改的宽记下(窗口窄时夹到的宽不覆盖原宽)
  const written = new Map<string, number>();
  const groupKey = (): string => api.groups.map((g) => g.id).join('\n');
  let lastWidth = api.width;
  let lastGroups = groupKey();
  let scheduled = false;
  let disposed = false;

  const check = (): void => {
    const width = api.width;
    const groups = groupKey();
    const resized = width !== lastWidth || groups !== lastGroups;
    lastWidth = width;
    lastGroups = groups;
    if (width <= 0) return;
    for (const id of constrained) {
      const group = api.getGroup(id);
      if (group && isSidePanelGroup(group)) continue;
      constrained.delete(id);
      pinned.delete(id);
      written.delete(id);
      group?.api.setConstraints({ minimumWidth: DOCKVIEW_GROUP_MIN_WIDTH });
    }
    for (const group of api.groups) {
      if (!isSidePanelGroup(group) || group.api.location.type !== 'grid') continue;
      if (!constrained.has(group.id)) {
        constrained.add(group.id);
        group.api.setConstraints({ minimumWidth: SIDE_PANEL_MIN_WIDTH });
      }
      if (!isSideColumn(api, group)) continue;
      const current = group.api.width;
      const kept = pinned.get(group.id);
      if (!resized || kept === undefined) {
        const mine = written.get(group.id);
        if (mine !== undefined && Math.abs(current - mine) < 1) continue;
        written.delete(group.id);
        pinned.set(group.id, current);
        continue;
      }
      const target = Math.max(SIDE_PANEL_MIN_WIDTH, Math.min(kept, width - SIDE_PANEL_EDITOR_MIN_WIDTH));
      written.set(group.id, target);
      if (Math.abs(current - target) < 1) continue;
      group.api.setSize({ width: target });
    }
    // 校正本身的布局变化不算新的容器宽 / 组集合
    lastWidth = api.width;
    lastGroups = groupKey();
  };

  // 布局变化(组增删、拖分隔条)经 onDidLayoutChange;容器缩放只改各组尺寸(dockview 不派发 onDidLayoutChange)→ 听各组的
  // onDidDimensionsChange。都等这一轮布局完成(微任务)后再看。
  const schedule = (): void => {
    if (scheduled || disposed) return;
    scheduled = true;
    queueMicrotask(() => {
      scheduled = false;
      if (!disposed) check();
    });
  };
  const perGroup = new Map<string, { dispose: () => void }>();
  const watch = (group: IDockviewGroupPanel): void => {
    if (!perGroup.has(group.id)) perGroup.set(group.id, group.api.onDidDimensionsChange(schedule));
  };
  api.groups.forEach(watch);
  const subs = [
    api.onDidLayoutChange(schedule),
    api.onDidAddGroup((group) => {
      watch(group);
      schedule();
    }),
    api.onDidRemoveGroup((group) => {
      perGroup.get(group.id)?.dispose();
      perGroup.delete(group.id);
      schedule();
    }),
  ];
  check();
  return {
    dispose: () => {
      disposed = true;
      subs.forEach((d) => d.dispose());
      perGroup.forEach((d) => d.dispose());
      perGroup.clear();
    },
  };
}
