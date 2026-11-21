// @vitest-environment jsdom
// topic 49 第六 session · P2:关闭后 EXIT 动画窗口内复活的 panel 取消排定的真 close。
//
// 根因:wrapPanelClose 把真 close 延后 EXIT_DURATION_MS(动画),这段时间 panel 仍存在。
// DockShell editor 激活 effect 在用户「关了 editor 面板随即又点开文件」时,getPanel('editor')
// 命中这个 mid-EXIT 旧 panel 直接 setActive —— 但既不 unmark 也无法取消那个已排定的真
// close。结果:文件看似打开,~220ms 后排定的 close 仍执行 → 面板及刚打开的文件凭空消失。
// 修复:wrapPanelClose 用 Map 存 timer,导出 cancelPendingPanelClose(id) 撤销 timer + unmark;
// DockShell editor effect 命中已存在 panel 时调用它。

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  wrapPanelClose,
  cancelPendingPanelClose,
} from '../../shell/dock/wrap-panel-close';
import { useClosingStore } from '../../stores/closing.store';
import { EXIT_DURATION_MS } from '../../shell/motion/tokens';

interface FakePanel {
  api: { id: string; close: () => void };
}
function makePanel(id: string, close: () => void): FakePanel {
  return { api: { id, close } };
}

describe('topic49 6thS · cancelPendingPanelClose 复活路径', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    useClosingStore.setState({ ids: new Set() });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('close 后 EXIT 窗口内 cancel → 真 close 不执行 + closing 标记清除', () => {
    const realClose = vi.fn();
    const panel = makePanel('editor', realClose);
    wrapPanelClose(panel as never);

    panel.api.close();
    expect(useClosingStore.getState().ids.has('editor')).toBe(true);

    // 动画中途复活(editor effect 命中 mid-EXIT panel)
    vi.advanceTimersByTime(EXIT_DURATION_MS - 50);
    cancelPendingPanelClose('editor');

    // closing 标记立即清除(PanelMount 据此动画回 IN)
    expect(useClosingStore.getState().ids.has('editor')).toBe(false);

    // 跨过原 EXIT 截止点,排定的真 close 不应再触发
    vi.advanceTimersByTime(100);
    expect(realClose).not.toHaveBeenCalled();
  });

  it('未复活 → 真 close 照常在 EXIT_DURATION_MS 执行(不破坏正常关闭)', () => {
    const realClose = vi.fn();
    const panel = makePanel('editor', realClose);
    wrapPanelClose(panel as never);

    panel.api.close();
    vi.advanceTimersByTime(EXIT_DURATION_MS);
    expect(realClose).toHaveBeenCalledTimes(1);
  });

  it('非 pending 时 cancel 是无害 no-op', () => {
    expect(() => cancelPendingPanelClose('never-closed')).not.toThrow();
    expect(useClosingStore.getState().ids.has('never-closed')).toBe(false);
  });

  it('复活后再次 close → 可重新排定并正常关闭(timer 不残留串台)', () => {
    const realClose = vi.fn();
    const panel = makePanel('editor', realClose);
    wrapPanelClose(panel as never);

    panel.api.close();
    cancelPendingPanelClose('editor'); // 复活
    panel.api.close(); // 用户再次关闭
    vi.advanceTimersByTime(EXIT_DURATION_MS);
    expect(realClose).toHaveBeenCalledTimes(1);
  });
});
