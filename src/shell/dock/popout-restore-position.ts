// popout 子窗位置重启不漂移。dockview 6 序列化 popout 用 PopoutWindow.dimensions() —— 屏幕绝对坐标(screenX / screenY);
// 但 fromJSON 恢复走 addPopoutGroup,把 position 当成相对主窗视口再加一次主窗原点(`window.screenX + box.left`)→ 每次
// 重启子窗往右下漂主窗原点的距离。fromJSON 前减去主窗原点,dockview 加回后即为保存时的屏幕坐标。
// BDD: src/__tests__/window-state-restore/popout-restore-position.spec.ts

interface PopoutPosition {
  left: number;
  top: number;
}

function isPosition(v: unknown): v is PopoutPosition {
  return (
    typeof v === 'object' &&
    v !== null &&
    typeof (v as PopoutPosition).left === 'number' &&
    typeof (v as PopoutPosition).top === 'number'
  );
}

/** 返回 popout 位置换算成相对 (originX, originY) 的布局副本;没有可换算的 popout 时原样返回。 */
export function popoutPositionsRelativeToWindow<T>(layout: T, originX: number, originY: number): T {
  const groups = (layout as { popoutGroups?: unknown }).popoutGroups;
  if (!Array.isArray(groups) || groups.length === 0) return layout;
  const next = groups.map((g: unknown) => {
    const position = (g as { position?: unknown } | null)?.position;
    if (!isPosition(position)) return g;
    return {
      ...(g as object),
      position: { ...position, left: position.left - originX, top: position.top - originY },
    };
  });
  return { ...layout, popoutGroups: next };
}
