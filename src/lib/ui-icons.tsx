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

/** 方块:停止 / 取消进行中的操作(搜索视图「取消搜索」)。 */
export function StopIcon({ size }: IconProps) {
  return (
    <StrokeIcon size={size}>
      <rect x="4.5" y="4.5" width="7" height="7" rx="1" />
    </StrokeIcon>
  );
}

/** 漏斗:排除设置与忽略文件(搜索视图排除框旁的开关)。 */
export function ExcludeIcon({ size }: IconProps) {
  return (
    <StrokeIcon size={size}>
      <path d="M2.5 3.5h11l-4.3 5.2v3.8l-2.4 1V8.7z" />
    </StrokeIcon>
  );
}

/**
 * 严重级别图标(VSCode 通知 / 问题的 codicon error / warning / info,success 用 pass 的圆圈对勾):靠形状区分等级,不只靠颜色
 *(色觉差异 / 强制颜色下仍可辨,WCAG 1.4.1)。描边 currentColor,颜色由调用方给。
 */
export type SeverityLevel = 'error' | 'warning' | 'info' | 'success';

const DOT = { fill: 'currentColor', stroke: 'none' } as const;

export function SeverityIcon({ level, size }: IconProps & { readonly level: SeverityLevel }) {
  switch (level) {
    case 'error':
      return (
        <StrokeIcon size={size}>
          <circle cx="8" cy="8" r="6" />
          <path d="M5.9 5.9l4.2 4.2M10.1 5.9l-4.2 4.2" />
        </StrokeIcon>
      );
    case 'warning':
      return (
        <StrokeIcon size={size}>
          <path d="M8 2.2l6.1 11H1.9z" />
          <path d="M8 6.4v3.3" />
          <circle cx="8" cy="11.6" r="0.8" {...DOT} />
        </StrokeIcon>
      );
    case 'info':
      return (
        <StrokeIcon size={size}>
          <circle cx="8" cy="8" r="6" />
          <path d="M8 7.4v3.8" />
          <circle cx="8" cy="5.2" r="0.8" {...DOT} />
        </StrokeIcon>
      );
    case 'success':
      return (
        <StrokeIcon size={size}>
          <circle cx="8" cy="8" r="6" />
          <path d="M5.4 8.2l1.8 1.8 3.5-3.7" />
        </StrokeIcon>
      );
  }
}
