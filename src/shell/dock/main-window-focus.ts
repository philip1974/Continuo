// 用户入口把面板 / 选择器打开在主窗、而系统焦点在 dockview popout 子窗(从子窗经菜单 / 命令面板 / 热键触发 ⇧⌘F、⌘,、新终端…)
// → 激活主窗,焦点与打开的东西在同一窗口(VSCode:辅助窗口里 ⇧⌘F 打开主窗的搜索视图并聚焦主窗)。不激活的话面板内容在主窗
// 拿到 DOM 焦点,接着输入的字却进了子窗的编辑器 / 终端。renderer 的 window.focus() 无用户激活时不激活窗口,经 main(window:focus)。
// BDD: src/__tests__/popout-picker/

import { coApi } from '@/lib/co-api';
import { getPopoutDocuments } from './popout-documents';

/** 有 popout 子窗获焦时激活主窗;主窗本就获焦 / 没有子窗 → 无操作。 */
export function focusMainWindowFromPopout(): void {
  if (!getPopoutDocuments().some((doc) => doc.hasFocus())) return;
  // 激活失败只是焦点留在子窗(原状),不打扰用户
  coApi.window.focus().catch(() => undefined);
}
