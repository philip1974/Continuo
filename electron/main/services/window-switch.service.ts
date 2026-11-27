// 切换窗口(VSCode workbench.action.switchWindow)的窗口列表:主窗口按创建顺序,每个主窗之后是它打开的 popout 子窗(VSCode
// nativeHostService.getWindows({ includeAuxiliaryWindows: true }),辅助窗口归到所属主窗之下)。正在关闭(已隐藏且未最小化)/ 已销毁 /
// 找不到所属主窗的窗口不列。BDD: src/__tests__/switch-window/

import type { WindowSwitchEntry } from '../../shared/window-channels';

/** 列表需要的 BrowserWindow 形状(便于测试)。 */
export interface SwitchWindowLike {
  readonly id: number;
  isDestroyed(): boolean;
  isVisible(): boolean;
  isMinimized(): boolean;
  getTitle(): string;
}

/**
 * ownerOf:窗口所属的主窗(主窗即自身;popout 子窗 → 打开它的主窗;找不到 → null),current:发起切换的窗口。
 */
export function listSwitchWindows<W extends SwitchWindowLike>(
  windows: readonly W[],
  ownerOf: (win: W) => W | null,
  current: W | null,
): WindowSwitchEntry[] {
  const usable = windows
    .filter((w) => !w.isDestroyed() && (w.isVisible() || w.isMinimized()))
    .sort((a, b) => a.id - b.id);
  const entry = (w: W, parentId: number | null): WindowSwitchEntry => ({
    id: w.id,
    title: w.getTitle(),
    parentId,
    current: w === current,
  });
  const out: WindowSwitchEntry[] = [];
  for (const main of usable) {
    if (ownerOf(main) !== main) continue;
    out.push(entry(main, null));
    for (const aux of usable) {
      if (aux !== main && ownerOf(aux) === main) out.push(entry(aux, main.id));
    }
  }
  return out;
}
