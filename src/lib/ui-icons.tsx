// 多处共用的 16×16 stroke 图标(此前 ExplorerHeader / HeaderActions、KeybindingsTabContent /
// SettingItemRow 各自内联一份相同 path)及通用 chrome 图标(上 / 下一个、关闭);调用方仍在模块级预创建元素。

import type { ReactNode } from 'react';

interface IconProps {
  readonly size: number;
}

/** 逆时针箭头:恢复默认 / 重置。 */
export function ResetIcon({ size }: IconProps) {
  return (
    <svg
      viewBox="0 0 16 16"
      width={size}
      height={size}
      aria-hidden="true"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M3 8a5 5 0 0 1 8.5-3.5L13 6" />
      <path d="M13 3v3h-3" />
    </svg>
  );
}

/** 水平省略号 ⋯:更多操作菜单触发器。 */
export function MoreActionsIcon({ size }: IconProps) {
  return (
    <svg viewBox="0 0 16 16" width={size} height={size} aria-hidden="true">
      <circle cx="3.5" cy="8" r="1.1" fill="currentColor" />
      <circle cx="8" cy="8" r="1.1" fill="currentColor" />
      <circle cx="12.5" cy="8" r="1.1" fill="currentColor" />
    </svg>
  );
}

/** 共用的 16×16 stroke 外框(与 ResetIcon 同线宽 / 端点)。 */
function StrokeIcon({ size, children }: IconProps & { readonly children: ReactNode }) {
  return (
    <svg
      viewBox="0 0 16 16"
      width={size}
      height={size}
      aria-hidden="true"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {children}
    </svg>
  );
}

/** 向上箭头 ⌃:上一个(匹配)。 */
export function ChevronUpIcon({ size }: IconProps) {
  return (
    <StrokeIcon size={size}>
      <path d="M4 10l4-4 4 4" />
    </StrokeIcon>
  );
}

/** 向下箭头 ⌄:下一个(匹配)。 */
export function ChevronDownIcon({ size }: IconProps) {
  return (
    <StrokeIcon size={size}>
      <path d="M4 6l4 4 4-4" />
    </StrokeIcon>
  );
}

/** 叉号 ×:关闭。 */
export function CloseIcon({ size }: IconProps) {
  return (
    <StrokeIcon size={size}>
      <path d="M4.5 4.5l7 7M11.5 4.5l-7 7" />
    </StrokeIcon>
  );
}
