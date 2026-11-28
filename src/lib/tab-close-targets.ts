// tab 右键菜单「关闭」类动作的目标集合(VSCode 编辑器标签右键:关闭 / 关闭其他 / 关闭右侧 / 关闭已保存 / 全部关闭)。
// 编辑器文件 tab 与 dock 面板 tab 共用。BDD: src/__tests__/tab-context-menu/

export type TabCloseKind = 'close' | 'others' | 'right' | 'saved' | 'all';

export interface TabCloseItem {
  readonly id: string;
  /** 未保存修改;只影响「关闭已保存」。 */
  readonly dirty?: boolean;
  /**
   * 固定(pin)的编辑器 tab:「关闭其他 / 关闭右侧 / 关闭已保存 / 全部关闭」跳过它,只有「关闭」关它(VSCode 这些命令都 excludeSticky)。
   * BDD: src/__tests__/editor-tab-management/
   */
  readonly sticky?: boolean;
}

/** 按 tab 顺序返回要关闭的 id;目标不在列表里 → 空(tab 已被别处关掉)。 */
export function tabCloseTargets(tabs: readonly TabCloseItem[], targetId: string, kind: TabCloseKind): string[] {
  const index = tabs.findIndex((tab) => tab.id === targetId);
  if (index < 0) return [];
  if (kind === 'close') return [targetId];
  const unpinned = (list: readonly TabCloseItem[]) => list.filter((tab) => tab.sticky !== true);
  switch (kind) {
    case 'others':
      return unpinned(tabs.filter((tab) => tab.id !== targetId)).map((tab) => tab.id);
    case 'right':
      return unpinned(tabs.slice(index + 1)).map((tab) => tab.id);
    case 'saved':
      return unpinned(tabs.filter((tab) => tab.dirty !== true)).map((tab) => tab.id);
    case 'all':
      return unpinned(tabs).map((tab) => tab.id);
  }
}
