import type { KeyboardEvent } from 'react';
import { indexOfElement, nextRovingIndex, type RovingMove } from './roving-index';

/**
 * a11y(A23/A28):WAI-ARIA tablist 键盘导航(手动激活)—— 共享单一来源。
 *
 * 挂到 role="tablist" 容器的 onKeyDown:方向键在未禁用(`disabled` / `aria-disabled`)的 `[role="tab"]` 之间移动
 * 焦点(左右/上下都支持,兼容横向 TabNav 与纵向 Tabs;左右循环,Home/End 跳首尾)。配合各
 * tab button 的 roving tabindex(active=0、其余 -1)使键盘用户一次 Tab 进/出整个 tablist。
 * 手动激活语义:方向键只移焦,Enter/Space 由各 tab 自己触发选择。
 */
export function handleTablistArrowKeys(e: KeyboardEvent<HTMLElement>): void {
  const { key } = e;
  if (
    key !== 'ArrowRight' &&
    key !== 'ArrowDown' &&
    key !== 'ArrowLeft' &&
    key !== 'ArrowUp' &&
    key !== 'Home' &&
    key !== 'End'
  )
    return;
  const tabs = e.currentTarget.querySelectorAll<HTMLElement>(
    '[role="tab"]:not([disabled]):not([aria-disabled="true"])',
  );
  if (tabs.length === 0) return;
  // tablist 所在文档的焦点:面板弹出到 dockview popout 子窗时(React 经 portal 渲染,全局 document 是主窗)读全局
  // document.activeElement 恒不在列表里 → → 总到首项、← 总到末项。
  const idx = indexOfElement(tabs, e.currentTarget.ownerDocument.activeElement);
  const move: RovingMove =
    key === 'Home'
      ? 'first'
      : key === 'End'
        ? 'last'
        : key === 'ArrowRight' || key === 'ArrowDown'
          ? 'next'
          : 'prev'; // ArrowLeft / ArrowUp
  e.preventDefault();
  tabs[nextRovingIndex(move, idx, tabs.length)]?.focus();
}

