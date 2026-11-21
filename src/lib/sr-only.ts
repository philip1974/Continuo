import type { CSSProperties } from 'react';

/**
 * a11y:视觉隐藏但对屏幕阅读器可读的内联样式 —— 单一来源。
 *
 * 用于「静态文本流」里给 AT 补充真实文本(承载语义的纯符号/emoji 旁,如 dirty ●、👍 计数)。
 * 文本流里 aria-label on 普通 span 在浏览模式不可靠,须用真实(视觉隐藏)文本。项目无 Tailwind
 * `sr-only` 工具类,故用内联样式自足。见 A37(StatusBar)/A39(Marketplace)/A40(TitleBar)。
 */
export const SR_ONLY_STYLE: CSSProperties = {
  position: 'absolute',
  width: 1,
  height: 1,
  padding: 0,
  margin: -1,
  overflow: 'hidden',
  clip: 'rect(0 0 0 0)',
  whiteSpace: 'nowrap',
  border: 0,
};
