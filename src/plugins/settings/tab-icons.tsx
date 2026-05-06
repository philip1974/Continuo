// 内置 SettingTab 的 icon SVG 集合(M-Settings v6 / UI polish)。
// 16×16 stroke 风格,与 IconSidebar / ExplorerHeader 同体系。
// 每个 export 是一个 React 元素工厂,直接放入 SettingTabSpec.icon。

import { createElement } from 'react';

const COMMON_PROPS = {
  width: 14,
  height: 14,
  viewBox: '0 0 16 16',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.4,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
  'aria-hidden': true,
};

/** 通用:齿轮(general) */
export function GeneralIcon() {
  return createElement(
    'svg',
    COMMON_PROPS,
    createElement('circle', { cx: 8, cy: 8, r: 2 }),
    createElement('path', {
      d: 'M8 1.5v2M8 12.5v2M14.5 8h-2M3.5 8h-2M12.6 3.4l-1.4 1.4M4.8 11.2l-1.4 1.4M12.6 12.6l-1.4-1.4M4.8 4.8L3.4 3.4',
    }),
  );
}

/** 编辑器:文档/笔 */
export function EditorIcon() {
  return createElement(
    'svg',
    COMMON_PROPS,
    createElement('path', { d: 'M9 1.5H3.5A1.5 1.5 0 0 0 2 3v10a1.5 1.5 0 0 0 1.5 1.5h9A1.5 1.5 0 0 0 14 13V6.5L9 1.5Z' }),
    createElement('path', { d: 'M9 1.5V6h5' }),
    createElement('path', { d: 'M5 9h6M5 11.5h4' }),
  );
}

/** 资源管理器:文件夹 */
export function ExplorerIcon() {
  return createElement(
    'svg',
    COMMON_PROPS,
    createElement('path', {
      d: 'M1.5 4A1.5 1.5 0 0 1 3 2.5h3l1.5 1.5h5.5A1.5 1.5 0 0 1 14.5 5.5v6.5A1.5 1.5 0 0 1 13 13.5H3a1.5 1.5 0 0 1-1.5-1.5V4Z',
    }),
  );
}

/** 终端:命令提示符框 */
export function TerminalIcon() {
  return createElement(
    'svg',
    COMMON_PROPS,
    createElement('rect', { x: 1.5, y: 2.5, width: 13, height: 11, rx: 1.5 }),
    createElement('path', { d: 'M4 6l2 2-2 2M8 10.5h4' }),
  );
}

/** 快捷键:键盘 */
export function KeybindingsIcon() {
  return createElement(
    'svg',
    COMMON_PROPS,
    createElement('rect', { x: 1.5, y: 4.5, width: 13, height: 8, rx: 1 }),
    createElement('path', {
      d: 'M4 7h.01M6 7h.01M8 7h.01M10 7h.01M12 7h.01M4 9.5h.01M6 9.5h.01M10 9.5h.01M12 9.5h.01M5 11.5h6',
    }),
  );
}

/** 插件:拼图块 */
export function PluginsIcon() {
  return createElement(
    'svg',
    COMMON_PROPS,
    createElement('path', {
      d: 'M6.5 2.5h-3v3h-1a1 1 0 0 0-1 1v2.5h2a1 1 0 0 1 0 2H1.5V13a.5.5 0 0 0 .5.5h2.5v-2a1 1 0 0 1 2 0v2H9a.5.5 0 0 0 .5-.5v-3h2a1 1 0 0 0 0-2h-2v-3h-3a1 1 0 0 1-2 0Z',
    }),
  );
}

/** 商店:购物袋 */
export function MarketplaceIcon() {
  return createElement(
    'svg',
    COMMON_PROPS,
    createElement('path', {
      d: 'M3 5h10l-.8 8.2a1 1 0 0 1-1 .9H4.8a1 1 0 0 1-1-.9L3 5Z',
    }),
    createElement('path', { d: 'M5.5 5V3.5a2.5 2.5 0 0 1 5 0V5' }),
  );
}
