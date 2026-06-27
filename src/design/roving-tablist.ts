import type { KeyboardEvent } from 'react';

/**
 * a11y(A23/A28):WAI-ARIA tablist 键盘导航(手动激活)—— 共享单一来源。
 *
 * 挂到 role="tablist" 容器的 onKeyDown:方向键在 `[role="tab"]:not([disabled])` 之间移动
 * 焦点(左右/上下都支持,兼容横向 TabNav 与纵向 Tabs;左右循环,Home/End 跳首尾)。配合各
 * tab button 的 roving tabindex(active=0、其余 -1)使键盘用户一次 Tab 进/出整个 tablist。
 * 手动激活语义:方向键只移焦,Enter/Space 由原生 button 触发选择。
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
  const tabs = e.currentTarget.querySelectorAll<HTMLButtonElement>(
    '[role="tab"]:not([disabled])',
  );
  if (tabs.length === 0) return;
  const active = document.activeElement as HTMLElement | null;
  const idx = active ? indexOfTab(tabs, active) : -1;
  let next: number;
  if (key === 'Home') next = 0;
  else if (key === 'End') next = tabs.length - 1;
  else if (key === 'ArrowRight' || key === 'ArrowDown')
    next = idx < 0 ? 0 : (idx + 1) % tabs.length;
  else next = idx <= 0 ? tabs.length - 1 : idx - 1; // ArrowLeft / ArrowUp
  e.preventDefault();
  tabs[next]?.focus();
}

function indexOfTab(
  tabs: NodeListOf<HTMLButtonElement>,
  active: HTMLElement,
): number {
  for (let i = 0; i < tabs.length; i += 1) {
    if (tabs[i] === active) return i;
  }
  return -1;
}
