// 动画 token 集中地。doc 03 是唯一真相源,变更需对应改 BDD spec。

export const tabIndicatorLayoutId = (groupId: string) => `tab-indicator-${groupId}`;
export const panelTitleLayoutId = (panelId: string) => `panel-title-${panelId}`;

// PanelMount 进场配置:220ms + 自定 ease(VSCode/macOS 果冻 ease)。
export const PANEL_MOUNT_TRANSITION = {
  duration: 0.22,
  ease: [0.32, 0.72, 0, 1] as [number, number, number, number],
};
export const PANEL_MOUNT_INITIAL = { opacity: 0, y: 8, scale: 0.98 };
export const PANEL_MOUNT_ANIMATE = { opacity: 1, y: 0, scale: 1 };

// SharedTab indicator spring(高频小元素,弹一下更灵敏)。
export const TAB_INDICATOR_SPRING = {
  type: 'spring' as const,
  stiffness: 500,
  damping: 35,
};
