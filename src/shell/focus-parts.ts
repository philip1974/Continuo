// F6 / ⇧F6 在工作台区域间移动焦点(VSCode workbench.action.focusNextPart / focusPreviousPart):终端 / 代码编辑器
// 吃掉 Tab 时,键盘用户靠它离开当前区域。顺序同 VSCode(编辑器 → … → 状态栏 → … → 侧栏 → 编辑器)取 Continuo 有的
// 三个区域:活动 dock 组 → 状态栏 → 侧栏。区域由 data-workbench-part 标记;不可聚焦 / 隐藏的区域跳过;焦点不在任何
// 区域时先到活动 dock 组(VSCode 同)。只作用于主窗(popout 子窗不分发本命令);活动面板在子窗时 dock 区域取主窗最近
// 使用的组;主窗没有面板(全关光 / 全弹出)时落到主窗空态。
// BDD: src/__tests__/keyboard-focus-parity/

import { getDockApi } from '@/shell/dock/dock-api-ref';
import { focusPanelContent } from '@/shell/dock/panel-focus';
import { mostRecentMainWindowPanel } from '@/shell/dock/group-mru';
import { activateDockPanel } from '@/shell/dock/wrap-panel-close';
import type { CommandSpec } from '@/plugins/registries/CommandRegistry';

export const FOCUS_NEXT_PART_COMMAND = { id: 'workbench.action.focusNextPart', hotkey: 'f6' } as const;
export const FOCUS_PREVIOUS_PART_COMMAND = { id: 'workbench.action.focusPreviousPart', hotkey: 'shift+f6' } as const;

/** 区域标记属性(DockShell 根 / 状态栏 footer / Explorer 侧栏 aside)。 */
export const WORKBENCH_PART_ATTR = 'data-workbench-part';
const PARTS = ['dock', 'statusbar', 'sidebar'] as const;
type Part = (typeof PARTS)[number];

const TABBABLE =
  'button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

function partElement(doc: Document, part: Part): HTMLElement | null {
  const el = doc.querySelector<HTMLElement>(`[${WORKBENCH_PART_ATTR}="${part}"]`);
  return el && !el.closest('[hidden]') ? el : null;
}

/** 把焦点交给该区域;成功(焦点确实进了区域)返回 true。 */
function focusPart(doc: Document, part: Part): boolean {
  const root = partElement(doc, part);
  if (!root) return false;
  if (part === 'dock') {
    const api = getDockApi();
    let panel = api?.activePanel;
    // 活动面板在 popout 子窗:主窗 F6 只在主窗自己的区域循环(VSCode 同)→ 改用主窗最近使用的组的活动面板,先激活再聚焦。
    if (api && panel?.api.location.type === 'popout') {
      panel = mostRecentMainWindowPanel(api);
      if (panel) activateDockPanel(panel);
    }
    // 主窗没有可聚焦的面板(全关光 / 全弹出到子窗)→ 聚焦主窗空态(VSCode:F6 落到空编辑器组)。
    if (panel) focusPanelContent(panel.api);
    else root.querySelector<HTMLElement>('[data-dock-empty]')?.focus();
  } else {
    // 侧栏:Explorer 树的当前项(roving tabindex=0),树未渲染 / 无当前项时退到第一个控件。
    const target =
      (part === 'sidebar' ? root.querySelector<HTMLElement>('[role="treeitem"][tabindex="0"]') : null) ??
      root.querySelector<HTMLElement>(TABBABLE);
    target?.focus();
  }
  return root.contains(doc.activeElement);
}

/** 把焦点交给某个区域(同 F6 的落点规则);「显示资源管理器」命令在无工作区时用它聚焦侧栏。 */
export function focusWorkbenchPart(part: Part, doc: Document = document): boolean {
  return focusPart(doc, part);
}

/** 焦点移到下一个(1)/ 上一个(-1)区域。 */
export function focusAdjacentPart(delta: 1 | -1, doc: Document = document): void {
  const current = doc.activeElement?.closest(`[${WORKBENCH_PART_ATTR}]`)?.getAttribute(WORKBENCH_PART_ATTR);
  const index = PARTS.indexOf(current as Part);
  // 不在任何区域:从 dock 开始试(两个方向都先到 dock)
  const start = index < 0 ? 0 : index + delta;
  for (let i = 0; i < PARTS.length; i += 1) {
    const part = PARTS[(((start + delta * i) % PARTS.length) + PARTS.length) % PARTS.length]!;
    if (part === current) return;
    if (focusPart(doc, part)) return;
  }
}

/** 命令 spec(WindowPlugin 注册)。 */
export function focusPartCommandSpecs(): CommandSpec[] {
  return [
    {
      ...FOCUS_NEXT_PART_COMMAND,
      title: 'Focus Next Part',
      titleKey: 'commands.view.focus_next_part.title',
      category: 'View',
      categoryKey: 'commands.view.category',
      fn: () => focusAdjacentPart(1),
    },
    {
      ...FOCUS_PREVIOUS_PART_COMMAND,
      title: 'Focus Previous Part',
      titleKey: 'commands.view.focus_previous_part.title',
      category: 'View',
      categoryKey: 'commands.view.category',
      fn: () => focusAdjacentPart(-1),
    },
  ];
}
