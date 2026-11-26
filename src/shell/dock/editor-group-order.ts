// 编辑器组的空间顺序(对齐 VSCode GroupsOrder.GRID_APPEARANCE:网格从左到右、从上到下)—— dock 标题「编辑器 N」、
// ⌘1/⌘2/⌘3(focusEditorGroup)、重置布局的分栏顺序、读屏名称里的组号共用这一个来源。
// 组的增删 / 内容仍在 editor.store;store 的组顺序(创建 / 插入顺序)不随拖动改写,只用作 dock 里找不到位置时的兜底。
// BDD: src/__tests__/editor-groups/

import type { DockviewApi, IDockviewPanel } from 'dockview-react';
import { editorGroupIdsOf, useEditorStore } from '@/stores/editor.store';
import { isEditorGroupId } from '../../../electron/shared/editor-group-id';

type DockLike = Pick<DockviewApi, 'panels' | 'toJSON'>;

interface SerializedNode {
  readonly type: 'leaf' | 'branch';
  readonly data: unknown;
}

const isEditorGroupPanel = (p: IDockviewPanel): boolean => isEditorGroupId(p.api.id);

/**
 * 主窗(grid / floating)里编辑器组的空间顺序:网格树深度优先(横向分支从左到右、纵向分支从上到下,同 VSCode
 * gridview 的视图顺序);同一 dock 组里叠放的多个编辑器组按 tab 顺序;浮动组排在网格之后。popout 子窗里的组不计入
 *(⌘N 只在主窗分发,子窗各自编号)。用 dockview 序列化的网格树,不看 DOM 坐标。
 */
export function mainEditorGroupOrder(api: DockLike): string[] {
  const main = new Set<string>();
  for (const p of api.panels) if (isEditorGroupPanel(p) && p.api.location.type !== 'popout') main.add(p.api.id);
  if (main.size <= 1) return [...main];
  const out: string[] = [];
  const push = (ids: Iterable<unknown>) => {
    for (const id of ids) {
      if (typeof id === 'string' && main.has(id) && !out.includes(id)) out.push(id);
    }
  };
  const walk = (node: SerializedNode) => {
    if (node.type === 'leaf') push((node.data as { views?: string[] }).views ?? []);
    else for (const child of node.data as SerializedNode[]) walk(child);
  };
  try {
    const layout = api.toJSON();
    walk(layout.grid.root as SerializedNode);
    for (const f of layout.floatingGroups ?? []) push(f.data.views);
  } catch {
    // 序列化失败(瞬时状态):按下面的兜底顺序
  }
  // 兜底:网格里找不到位置的组按 store 组顺序,再按 dock 顺序
  push(editorGroupIdsOf(useEditorStore.getState()));
  push(main);
  return out;
}

export interface EditorGroupNumber {
  /** 在所在窗口里的位置(1 起)。 */
  readonly n: number;
  /** 所在窗口的编辑器组数。 */
  readonly of: number;
}

/**
 * 每个编辑器组在其窗口里的编号:主窗按 mainEditorGroupOrder;每个 popout 子窗(一个 dock 组)按其 tab 顺序各自从 1 起
 *(VSCode 辅助窗口同样各自编号)。
 */
export function editorGroupNumbers(api: DockLike): Map<string, EditorGroupNumber> {
  const windows: string[][] = [mainEditorGroupOrder(api)];
  const popouts = new Map<string, IDockviewPanel[]>();
  for (const p of api.panels) {
    if (!isEditorGroupPanel(p) || p.api.location.type !== 'popout') continue;
    const list = popouts.get(p.api.group.id) ?? [];
    list.push(p);
    popouts.set(p.api.group.id, list);
  }
  for (const list of popouts.values()) {
    const tabs = list[0]!.api.group.panels;
    windows.push(list.sort((a, b) => tabs.indexOf(a) - tabs.indexOf(b)).map((p) => p.api.id));
  }
  const out = new Map<string, EditorGroupNumber>();
  for (const ids of windows) ids.forEach((id, i) => out.set(id, { n: i + 1, of: ids.length }));
  return out;
}
