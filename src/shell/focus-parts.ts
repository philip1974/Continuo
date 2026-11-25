// F6 / ⇧F6 在工作台区域间移动焦点(VSCode workbench.action.focusNextPart / focusPreviousPart):终端 / 代码编辑器
// 吃掉 Tab 时,键盘用户靠它离开当前区域。顺序同 VSCode(编辑器 → … → 状态栏 → … → 侧栏 → 编辑器)取 Continuo 有的
// 三个区域:活动 dock 组 → 状态栏 → 侧栏。区域由 data-workbench-part 标记;不可聚焦 / 隐藏的区域跳过;焦点不在任何
// 区域时先到活动 dock 组(VSCode 同)。只作用于主窗(popout 子窗不分发本命令)。
// BDD: src/__tests__/keyboard-focus-parity/

import { getDockApi } from '@/shell/dock/dock-api-ref';
import { focusPanelContent } from '@/shell/dock/panel-focus';
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
    const panel = getDockApi()?.activePanel;
    if (!panel) return false;
    focusPanelContent(panel.api);
  } else {
    // 侧栏:Explorer 树的当前项(roving tabindex=0),树未渲染 / 无当前项时退到第一个控件。
    const target =
      (part === 'sidebar' ? root.querySelector<HTMLElement>('[role="treeitem"][tabindex="0"]') : null) ??
      root.querySelector<HTMLElement>(TABBABLE);
    target?.focus();
  }
  return root.contains(doc.activeElement);
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
