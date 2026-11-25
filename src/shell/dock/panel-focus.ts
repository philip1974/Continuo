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
// 都没有(空编辑器组:关光 tab 后只剩 Welcome)→ 面板根本身(只经脚本聚焦的 tabIndex=-1 落点)。VSCode:F6 / 点 tab
// 落到空编辑器组,不跳过编辑区。
const ROOT_FALLBACK_SELECTOR = '[data-editor-panel-root], :scope > [tabindex="-1"]';

/**
 * 把焦点交给该面板内容:终端走注册的 focus 句柄(xterm 隐藏 textarea);其它面板在内容 DOM 里找可编辑元素 /
 * 首个可 Tab 控件,再退到面板根(tabIndex=-1)。都找不到时不动焦点。
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
  // 编辑器面板没有可编辑区(空编辑器组 / 无法编辑的文件视图)→ 落到面板根,不落到 Welcome 的「打开文件夹」等按钮
  // (VSCode:焦点进空编辑器组,水印入口不抢焦点,Tab 再进入)。
  const target =
    content.querySelector<HTMLElement>(EDITABLE_SELECTOR) ??
    content.querySelector<HTMLElement>('[data-editor-panel-root]') ??
    content.querySelector<HTMLElement>(TABBABLE_SELECTOR) ??
    content.querySelector<HTMLElement>(ROOT_FALLBACK_SELECTOR);
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
