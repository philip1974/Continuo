// Crepe 拖放指示线(@milkdown/plugin-cursor → prosemirror-drop-indicator 0.1.x)的延迟隐藏在编辑器销毁后抛错的守卫。
// 指示线在 drop / dragleave / dragend 时排一个 30ms 计时器,到点 `ctx.set(dropIndicatorState, null)`;它的视图 destroy
// 不清这个计时器(0.1.4 仍未修)。放下即销毁编辑器很常见 —— 资源管理器拖文件放到 Markdown 编辑视图 = 打开该文件、编辑器重挂;
// 拖动中关 tab / 切模式 —— 销毁时 dropIndicatorState 已被移除,计时器到点抛「Context "dropIndicatorState" not found」未处理异常。
// 销毁后把该 slice 补回(只剩一个无人订阅的值,ctx 随编辑器一并丢弃),迟到的 set 成为空操作。
// BDD: src/__tests__/explorer-drag-out/(editor-content-drop.spec)
import type { MilkdownPlugin } from '@milkdown/kit/ctx';
import { dropIndicatorState } from '@milkdown/kit/plugin/cursor';

export const dropIndicatorDestroyGuard: MilkdownPlugin = (ctx) => () => async () => {
  // 各插件的清理同步依次执行;等它们(含移除 dropIndicatorState 的那个)跑完再补
  await Promise.resolve();
  if (!ctx.isInjected(dropIndicatorState.key)) ctx.inject(dropIndicatorState.key);
};
