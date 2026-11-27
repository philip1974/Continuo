// 终端获焦时切换终端 / 窗格(VSCode workbench.action.terminal.focusNext / focusPrevious / focusNextPane / focusPreviousPane)。
// Continuo 的终端是 dock 面板(1 PTY = 1 面板):「终端」= 终端面板,「窗格」= 窗口里正显示终端的 dock 组(分屏)。
// - 下一个 / 上一个终端:触发窗口的全部终端面板,按 dock 组空间顺序(网格从左到右、从上到下,浮动组在后)+ 组内 tab 顺序轮转,
//   含同组被遮住的 tab(VSCode setActiveGroupToNext / Previous,首尾相接);
// - 下一个 / 上一个窗格:触发窗口里活动 tab 是终端的组之间按同一空间顺序移动(VSCode focusNextPane / focusPreviousPane,首尾相接)。
// 作用于触发它的窗口(getCommandDocument):popout 子窗只在本窗的终端间轮转。切换后焦点进入目标终端。
// BDD: src/__tests__/terminal-focus-cycle/

import type { DockviewApi, IDockviewPanel } from 'dockview-react';
import type { CommandSpec } from '@/plugins/registries/CommandRegistry';
import type { Platform } from '@/plugins/command-palette/format-hotkey';
import { TERMINAL_PANEL_TYPE } from '@/panels/Terminal/constants';
import { getDockApi } from './dock-api-ref';
import { activePanelInDocument, mostRecentPanelInDocument, popoutGroupOfDocument } from './group-mru';
import { getCommandDocument } from './popout-documents';
import { activateDockPanel } from './wrap-panel-close';
import { focusPanelContentWhenReady } from './panel-focus';

export const TERMINAL_FOCUS_NEXT_COMMAND_ID = 'workbench.action.terminal.focusNext';
export const TERMINAL_FOCUS_PREVIOUS_COMMAND_ID = 'workbench.action.terminal.focusPrevious';
export const TERMINAL_FOCUS_NEXT_PANE_COMMAND_ID = 'workbench.action.terminal.focusNextPane';
export const TERMINAL_FOCUS_PREVIOUS_PANE_COMMAND_ID = 'workbench.action.terminal.focusPreviousPane';

type Group = DockviewApi['groups'][number];

interface SerializedNode {
  readonly type: 'leaf' | 'branch';
  readonly data: unknown;
}

const isTerminalPanel = (panel: IDockviewPanel): boolean => panel.view?.contentComponent === TERMINAL_PANEL_TYPE;

/**
 * doc 所在窗口的 dock 组,按空间顺序:主窗 = 网格树深度优先(同 editor-group-order)+ 浮动组;popout 子窗 = 它自己的组。
 * 网格里找不到位置的主窗组(序列化失败等瞬时状态)按 dockview 组顺序排在后面。
 */
function groupsInWindow(api: DockviewApi, doc: Document): Group[] {
  if (doc !== document) {
    const popout = popoutGroupOfDocument(api, doc);
    return popout ? [popout] : [];
  }
  const main = api.groups.filter((g) => g.api.location.type !== 'popout');
  const order: string[] = [];
  const walk = (node: SerializedNode): void => {
    if (node.type === 'leaf') order.push((node.data as { id: string }).id);
    else for (const child of node.data as SerializedNode[]) walk(child);
  };
  try {
    const layout = api.toJSON();
    walk(layout.grid.root as SerializedNode);
    for (const f of layout.floatingGroups ?? []) order.push(f.data.id);
  } catch {
    // 序列化失败:按 dockview 组顺序
  }
  const rank = (g: Group): number => {
    const i = order.indexOf(g.id);
    return i < 0 ? order.length : i;
  };
  return main.map((g, i) => ({ g, i })).sort((a, b) => rank(a.g) - rank(b.g) || a.i - b.i).map(({ g }) => g);
}

/** 起点:焦点所在的终端;否则该窗口的活动终端;再退到该窗口最近使用的终端。 */
function currentTerminal(api: DockviewApi, doc: Document, candidates: readonly IDockviewPanel[]): IDockviewPanel | undefined {
  const focused = candidates.find((p) => p.view.content.element.contains(doc.activeElement));
  if (focused) return focused;
  const active = activePanelInDocument(api, doc);
  if (active && isTerminalPanel(active)) return active;
  return mostRecentPanelInDocument(api, doc, isTerminalPanel);
}

/** 终端窗格:窗口里正显示终端的组(有最大化组时只有它可见)的活动终端。 */
function terminalPanes(api: DockviewApi, doc: Document): IDockviewPanel[] {
  const out: IDockviewPanel[] = [];
  for (const group of groupsInWindow(api, doc)) {
    if (api.hasMaximizedGroup() && doc === document && !group.api.isMaximized()) continue;
    const active = group.activePanel;
    if (active && isTerminalPanel(active)) out.push(active);
  }
  return out;
}

/** 激活并聚焦目标终端(目标在最大化组之外时 dockview 激活它即退出最大化)。 */
function focusTerminal(panel: IDockviewPanel): void {
  activateDockPanel(panel);
  focusPanelContentWhenReady(panel, () => panel.api.isActive);
}

/** 在 list 里从起点移动 delta(首尾相接);不足两项 → 不动。 */
function step(api: DockviewApi, doc: Document, list: readonly IDockviewPanel[], delta: 1 | -1): void {
  if (list.length < 2) return;
  const from = currentTerminal(api, doc, list);
  let index = from ? list.indexOf(from) : -1;
  // 起点不在列表里(窗格:起点终端被同组别的 tab 遮住)→ 从它所在组的窗格算;都没有 → 从头 / 尾
  if (index < 0 && from) index = list.findIndex((p) => p.group === from.group);
  const next = index < 0 ? (delta > 0 ? 0 : list.length - 1) : (index + delta + list.length) % list.length;
  focusTerminal(list[next]!);
}

/** 下一个 / 上一个终端:触发窗口的全部终端面板(空间顺序 + 组内 tab 顺序)。 */
export function focusAdjacentTerminal(delta: 1 | -1): void {
  const api = getDockApi();
  if (!api) return;
  const doc = getCommandDocument();
  const list = groupsInWindow(api, doc).flatMap((g) => g.panels.filter(isTerminalPanel));
  step(api, doc, list, delta);
}

/** 下一个 / 上一个窗格:触发窗口里正显示终端的组之间。 */
export function focusAdjacentTerminalPane(delta: 1 | -1): void {
  const api = getDockApi();
  if (!api) return;
  const doc = getCommandDocument();
  step(api, doc, terminalPanes(api, doc), delta);
}

/**
 * doc 所在窗口是否有不止一个终端窗格(VSCode terminalSplitActive):窗格键只在此时让出,没有分屏时照常进 shell。
 */
export function hasTerminalSplit(doc: Document): boolean {
  const api = getDockApi();
  return api !== null && terminalPanes(api, doc).length > 1;
}

/**
 * 四条命令的 spec(TerminalPlugin 按 detectPlatform 注册)。默认键同 VSCode:
 * - 下一个 / 上一个终端:mac ⇧⌘] / ⇧⌘[,其它 Ctrl+PageDown / Ctrl+PageUp;
 * - 下一个 / 上一个窗格:mac ⌥⌘→ / ⌥⌘←(附加 ⌥⌘↓ / ⌥⌘↑),其它 Alt+→ / Alt+←(附加 Alt+↓ / Alt+↑)。
 * when: terminalFocus —— 同键的下一个 / 上一个编辑器在终端外照常生效。
 */
export function terminalFocusCycleCommandSpecs(platform: Platform): CommandSpec[] {
  const mac = platform === 'mac';
  const common = { category: 'Terminal', categoryKey: 'commands.terminal.category', when: 'terminalFocus' } as const;
  return [
    {
      ...common,
      id: TERMINAL_FOCUS_NEXT_COMMAND_ID,
      title: 'Focus Next Terminal',
      titleKey: 'commands.terminal.focus_next.title',
      hotkey: mac ? 'mod+shift+]' : 'ctrl+pagedown',
      fn: () => focusAdjacentTerminal(1),
    },
    {
      ...common,
      id: TERMINAL_FOCUS_PREVIOUS_COMMAND_ID,
      title: 'Focus Previous Terminal',
      titleKey: 'commands.terminal.focus_previous.title',
      hotkey: mac ? 'mod+shift+[' : 'ctrl+pageup',
      fn: () => focusAdjacentTerminal(-1),
    },
    {
      ...common,
      id: TERMINAL_FOCUS_NEXT_PANE_COMMAND_ID,
      title: 'Focus Next Terminal Pane',
      titleKey: 'commands.terminal.focus_next_pane.title',
      hotkey: mac ? 'mod+alt+right' : 'alt+right',
      secondaryHotkeys: [mac ? 'mod+alt+down' : 'alt+down'],
      fn: () => focusAdjacentTerminalPane(1),
    },
    {
      ...common,
      id: TERMINAL_FOCUS_PREVIOUS_PANE_COMMAND_ID,
      title: 'Focus Previous Terminal Pane',
      titleKey: 'commands.terminal.focus_previous_pane.title',
      hotkey: mac ? 'mod+alt+left' : 'alt+left',
      secondaryHotkeys: [mac ? 'mod+alt+up' : 'alt+up'],
      fn: () => focusAdjacentTerminalPane(-1),
    },
  ];
}
