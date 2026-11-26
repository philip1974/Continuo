// 重启恢复后把键盘焦点交给主窗活动编辑器(VSCode:启动恢复后焦点在活动编辑器,可直接键入)。此前恢复活动 tab 但不聚焦,
// activeElement 一直是 body,按键无反应。
//
// 时机:启动恢复(explorer 段 + 编辑器 tab 读盘)结束后由 main-app 调用;dock 布局可能更晚恢复(排队到
// markDockLayoutRestored),编辑器内容懒加载可能更晚挂上(逐帧等,限时后退到面板默认落点 focusPanelContent)。
// 不抢:期间用户按过键 / 点过鼠标、焦点已不在 body、主窗正显示的活动面板不是编辑器(终端等)、该编辑器组没有活动 tab。
// 看主窗正显示的面板(mainWindowActivePanel)而非全局活动面板:恢复期间 dockview 挂上 popout 子窗时把子窗的组设为活动组,
// 此前因此放弃,主窗焦点留在 body。
// BDD: src/__tests__/window-state-restore/restore-focus.spec.tsx

import type { DockviewApi } from 'dockview-react';
import { getDockApi, runWhenDockLayoutReady } from './dock-api-ref';
import { focusPanelContent } from './panel-focus';
import { CONTENT_FOCUS_TARGET_SELECTOR, focusContentTarget } from '@/lib/content-focus-target';
import { groupActiveTabIdOf, useEditorStore } from '@/stores/editor.store';
import { mainWindowActivePanel } from './group-mru';
import { isEditorGroupId } from '../../../electron/shared/editor-group-id';

/** 等布局 / 编辑区挂上的上限。 */
export const RESTORE_FOCUS_TIMEOUT_MS = 3000;

export function focusActiveEditorAfterRestore(doc: Document = document): void {
  if (useEditorStore.getState().activeTabId === null) return;
  const deadline = Date.now() + RESTORE_FOCUS_TIMEOUT_MS;
  let stopped = false;
  const stop = (): void => {
    stopped = true;
    doc.removeEventListener('pointerdown', stop, true);
    doc.removeEventListener('keydown', stop, true);
  };
  doc.addEventListener('pointerdown', stop, true);
  doc.addEventListener('keydown', stop, true);
  const focusIdle = (): boolean => doc.activeElement === null || doc.activeElement === doc.body;

  const tryFocus = (api: DockviewApi): void => {
    if (stopped) return;
    const panel = mainWindowActivePanel(api);
    if (
      !focusIdle() ||
      panel === undefined ||
      !isEditorGroupId(panel.id) ||
      panel.api.location.type !== 'grid' ||
      groupActiveTabIdOf(useEditorStore.getState(), panel.id) === null
    ) {
      stop();
      return;
    }
    const target = panel.view.content.element.querySelector<HTMLElement>(CONTENT_FOCUS_TARGET_SELECTOR);
    if (target) {
      focusContentTarget(target); // 恢复的视口保持,不被拉回光标处(BDD: focus-keeps-scroll)
      stop();
    } else if (Date.now() >= deadline) {
      focusPanelContent(panel.api);
      stop();
    } else {
      requestAnimationFrame(() => tryFocus(api));
    }
  };

  // dock 尚未 onReady → 逐帧等到它出现(限时);出现后经 runWhenDockLayoutReady 等布局恢复(恢复前排队)。
  const waitForDock = (): void => {
    if (stopped) return;
    if (getDockApi()) runWhenDockLayoutReady(tryFocus);
    else if (Date.now() < deadline) requestAnimationFrame(waitForDock);
    else stop();
  };
  waitForDock();
}
