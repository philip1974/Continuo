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
export const PANEL_MOUNT_EXIT = { opacity: 0, y: -4, scale: 0.99 };

// SharedTab 拦截 api.close() 后等多久才真 close,要与 PANEL_MOUNT_TRANSITION
// 的 duration(秒)对齐,转毫秒。
export const EXIT_DURATION_MS = Math.round(PANEL_MOUNT_TRANSITION.duration * 1000);

// SharedTab indicator spring(高频小元素,弹一下更灵敏)。
export const TAB_INDICATOR_SPRING = {
  type: 'spring' as const,
  stiffness: 500,
  damping: 35,
};

// 落点 ③:active tab 标题跨 group 飞行的 spring。damping 略高,
// 避免标题文字在长距离飞行后过冲过明显。
export const TAB_TITLE_SPRING = {
  type: 'spring' as const,
  stiffness: 500,
  damping: 38,
};
