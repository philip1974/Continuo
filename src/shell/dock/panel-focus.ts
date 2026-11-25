// dock 面板「把 DOM 焦点交给面板内容」的唯一实现:点 tab、关掉整组后 MRU 回落(group-mru)、关掉同组里非最后一个
// 面板后新的活动面板(wrap-panel-close)共用。VSCode:点编辑器 tab / 关闭活动编辑器或编辑器组后,新的活动编辑器
// 获焦,可直接继续输入。BDD: src/__tests__/focus-after-close/
import type { DockviewPanelApi, IDockviewPanel } from 'dockview-react';
import { focusTerminalPanel } from '@/panels/Terminal/terminal-panel-handles';

// 面板内容里优先接焦点的可编辑元素(CodeMirror / ProseMirror 的 contenteditable、输入框),
// 没有则退到第一个可 Tab 到的控件(Editor 的 tab 行按钮在编辑区之前,故两轮查找)。
const EDITABLE_SELECTOR =
  '[contenteditable="true"], textarea:not([disabled]), input:not([disabled]):not([type="hidden"])';
const TABBABLE_SELECTOR =
  'button:not([disabled]), a[href], select:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * 把焦点交给该面板内容:终端走注册的 focus 句柄(xterm 隐藏 textarea);其它面板在内容 DOM 里找可编辑元素 /
 * 首个可 Tab 控件。找不到时不动焦点。
 */
export function focusPanelContent(api: DockviewPanelApi): void {
  if (focusTerminalPanel(api.id)) return;
  let content: HTMLElement | undefined;
  for (const panel of api.group.panels) {
    if (panel.id === api.id) {
      content = panel.view.content.element;
      break;
    }
  }
  if (!content) return;
  const target =
    content.querySelector<HTMLElement>(EDITABLE_SELECTOR) ??
    content.querySelector<HTMLElement>(TABBABLE_SELECTOR);
  target?.focus();
}

/**
 * 激活由 dockview 收尾的场景(关组 / 关面板)下延到 microtask 再聚焦,且仅当 stillWanted() 仍成立:拖动组里最后一个
 * tab 时 dockview 照常派发移除事件、随后自己激活目标组,同步聚焦会把键盘焦点送进不相干的面板。
 */
export function focusDockPanelSoon(panel: IDockviewPanel, stillWanted: () => boolean): void {
  queueMicrotask(() => {
    if (stillWanted()) focusPanelContent(panel.api);
  });
}
