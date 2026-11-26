// dock 面板「把 DOM 焦点交给面板内容」的唯一实现:点 tab、关掉整组后 MRU 回落(group-mru)、关掉同组里非最后一个
// 面板后新的活动面板(wrap-panel-close)共用。VSCode:点编辑器 tab / 关闭活动编辑器或编辑器组后,新的活动编辑器
// 获焦,可直接继续输入。BDD: src/__tests__/focus-after-close/
import type { DockviewApi, DockviewPanelApi, IDockviewPanel } from 'dockview-react';
import { focusWithinOrLost } from '@/design/focus-within-or-lost';
import { focusTerminalPanel } from '@/panels/Terminal/terminal-panel-handles';
import { CONTENT_FOCUS_TARGET_SELECTOR, focusContentTarget } from '@/lib/content-focus-target';

// 面板内容里优先接焦点的落点(CONTENT_FOCUS_TARGET_SELECTOR,与编辑器 tab 行共用),
// 没有则退到第一个可 Tab 到的控件(Editor 的 tab 行按钮在编辑区之前,故两轮查找)。
const TABBABLE_SELECTOR =
  'button:not([disabled]), a[href], select:not([disabled]), [tabindex]:not([tabindex="-1"])';
// 都没有(空编辑器组:关光 tab 后只剩 Welcome / 没有控件的面板如空输出面板)→ 面板根本身(只经脚本聚焦的
// tabIndex=-1 落点,`data-panel-focus-root` 标记)。VSCode:F6 / 点 tab 落到空编辑器组,不跳过编辑区。
const ROOT_FALLBACK_SELECTOR = '[data-editor-panel-root], [data-panel-focus-root], :scope > [tabindex="-1"]';

/**
 * 把焦点交给该面板内容:终端走注册的 focus 句柄(xterm 隐藏 textarea);其它面板在内容 DOM 里找可编辑元素 /
 * 首个可 Tab 控件,再退到面板根(tabIndex=-1)。都找不到时不动焦点。返回是否找到了落点。
 */
export function focusPanelContent(api: DockviewPanelApi): boolean {
  if (focusTerminalPanel(api.id)) return true;
  let content: HTMLElement | undefined;
  for (const panel of api.group.panels) {
    if (panel.id === api.id) {
      content = panel.view.content.element;
      break;
    }
  }
  if (!content) return false;
  // 编辑器面板没有可编辑区(空编辑器组 / 无法编辑的文件视图)→ 落到面板根,不落到 Welcome 的「打开文件夹」等按钮
  // (VSCode:焦点进空编辑器组,水印入口不抢焦点,Tab 再进入)。
  const target =
    content.querySelector<HTMLElement>(CONTENT_FOCUS_TARGET_SELECTOR) ??
    content.querySelector<HTMLElement>('[data-editor-panel-root]') ??
    content.querySelector<HTMLElement>(TABBABLE_SELECTOR) ??
    content.querySelector<HTMLElement>(ROOT_FALLBACK_SELECTOR);
  if (!target) return false;
  focusContentTarget(target);
  return true;
}

// 新建面板等内容挂载的上限:lazy chunk 加载 + React Suspense 揭示通常远小于此;超时即放弃,不在很久以后突然抢焦点。
const MOUNT_FOCUS_TIMEOUT_MS = 3000;

/**
 * 用户发起的打开 / 显示面板后把焦点交给面板内容(VSCode openView(id, focus=true))。微任务里先试一次(激活已有面板:
 * 内容已在);新建面板的内容由 React 稍后渲染进 dockview 内容元素(lazy 面板还要等 chunk 与 Suspense 揭示)→ 尚无落点时
 * 观察内容 DOM,出现落点再聚焦。焦点已在内容里(面板自己 autoFocus / requestFocus 到特定控件)→ 不再移动。
 * 放弃:stillWanted() 不再成立(用户激活了别的面板)、等待期间用户按下指针、超时。只给用户入口用 —— 后台 / agent
 * 建面板(DockReconciler、会话恢复)不经这里,不抢焦点。
 */
export function focusPanelContentWhenReady(panel: IDockviewPanel, stillWanted: () => boolean): void {
  // true = 结束(已聚焦 / 不再需要);false = 还没有落点,继续等。
  const attempt = (): boolean => {
    if (!stillWanted()) return true;
    const content = panel.view.content.element;
    if (content.contains(content.ownerDocument.activeElement)) return true;
    return focusPanelContent(panel.api);
  };
  queueMicrotask(() => {
    if (attempt()) return;
    const doc = panel.view.content.element.ownerDocument;
    const stop = (): void => {
      observer.disconnect();
      clearTimeout(timer);
      doc.removeEventListener('pointerdown', stop, true);
    };
    const observer = new MutationObserver(() => {
      if (attempt()) stop();
    });
    observer.observe(panel.view.content.element, { childList: true, subtree: true });
    const timer = setTimeout(stop, MOUNT_FOCUS_TIMEOUT_MS);
    doc.addEventListener('pointerdown', stop, true);
  });
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

/**
 * 拖放 dock tab 到别的组(分栏 / 叠放)/ 同组换位后,被拖的面板获焦(VSCode:拖放编辑器后它成为活动编辑器并获焦)。
 * dockview 移动后只激活不移 DOM 焦点:按下 tab 时焦点在 tab 上,tab 随移动被摘下 → 焦点落 body、键入丢失。
 * 落点在 onWillDrop(dockview 在同一次 drop 处理里随后同步移动面板并激活;移动的 onDidMovePanel 派发时拖放数据已随
 * 被摘下的 tab 清掉,分不出是不是拖放;重置布局等程序化移动由调用方负责焦点):微任务里等这次移动收尾,只在焦点已丢失时
 * 对活动面板 focusPanelContent(终端走其注册的 focus 句柄)。
 * BDD: src/__tests__/focus-after-close/dock-drop-focus.spec.ts
 */
export function trackDropFocus(api: DockviewApi): { dispose(): void } {
  return api.onWillDrop(() => {
    queueMicrotask(() => {
      const panel = api.activePanel;
      if (panel && focusWithinOrLost(panel.group.element.ownerDocument, null)) focusPanelContent(panel.api);
    });
  });
}
