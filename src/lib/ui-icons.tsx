// 多处共用的 16×16 stroke 图标(此前 ExplorerHeader / HeaderActions、KeybindingsTabContent /
// SettingItemRow 各自内联一份相同 path)。只收「跨文件重复」的图标;调用方仍在模块级预创建元素。

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
