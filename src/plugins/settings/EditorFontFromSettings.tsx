// editor.fontFamily / editor.lineHeight → 本窗口 <html> 的 CSS 变量(代码编辑器、Markdown 源码模式、Markdown 代码块经 var() 取用):
//   --wm-editor-font-family   编辑器字体串(空 → 默认 = --wm-font-mono 同值)
//   --wm-editor-line-height   行高像素;自动(0)→ 移除变量,用编辑器默认行高
// 设置改动即时生效;其它窗口经设置跨窗同步各自更新;popout 子窗跑自己的 App,同样挂本组件写它自己的 <html>。
// BDD: src/__tests__/font-settings/

import { useLayoutEffect } from 'react';
import { useSettingValue } from './values-store';
import { EDITOR_FONT_FAMILY, EDITOR_FONT_SIZE, EDITOR_LINE_HEIGHT } from './core-setting-specs';
import { resolveEditorFontFamily, resolveEditorLineHeightPx } from './font-settings';

export const EDITOR_FONT_FAMILY_VAR = '--wm-editor-font-family';
export const EDITOR_LINE_HEIGHT_VAR = '--wm-editor-line-height';

export function EditorFontFromSettings(): null {
  const family = resolveEditorFontFamily(useSettingValue(EDITOR_FONT_FAMILY.id, EDITOR_FONT_FAMILY.default));
  const fontSize = useSettingValue(EDITOR_FONT_SIZE.id, EDITOR_FONT_SIZE.default);
  const lineHeight = resolveEditorLineHeightPx(useSettingValue(EDITOR_LINE_HEIGHT.id, EDITOR_LINE_HEIGHT.default), fontSize);
  useLayoutEffect(() => {
    const style = document.documentElement.style;
    style.setProperty(EDITOR_FONT_FAMILY_VAR, family);
    if (lineHeight === null) style.removeProperty(EDITOR_LINE_HEIGHT_VAR);
    else style.setProperty(EDITOR_LINE_HEIGHT_VAR, `${lineHeight}px`);
  }, [family, lineHeight]);
  return null;
}
