// @vitest-environment jsdom
// P2 未闭环回归(第八 session R4):dock-api-ref 的 focusPanel / openOrFocusPanel(existing
// 分支)聚焦已存在面板时只 setActive,**不取消排定中的真 close**。
//
// 根因:wrapPanelClose 把真 close 延后 EXIT_DURATION_MS(动画),这段时间面板仍存在。用户
// 关掉固定面板(Explorer/Output/Settings)随即又触发「打开/聚焦同 id 面板」(IconSidebar 点击 /
// plugin coApp.dock.openPanel / mod+, 重开 Settings)→ getPanel 命中 mid-EXIT 面板直接 setActive,
// 但排定的真 close 仍在 220ms 后执行 → 刚激活的面板凭空消失(用户感觉「点了没反应/一闪没了」)。
// DockShell editor 激活路径(DockShell.tsx:264)对完全相同的复活竞态显式调了
// cancelPendingPanelClose('editor'),但该守卫未传播到 dock-api-ref 两个兄弟入口。
//
// 修复:focusPanel / openOrFocusPanel 在 setActive 前调 cancelPendingPanelClose(id),镜像
// DockShell editor 路径。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DockviewApi } from 'dockview-react';
import {
  setDockApi,
  focusPanel,
  openOrFocusPanel,
} from '../../shell/dock/dock-api-ref';
import { wrapPanelClose } from '../../shell/dock/wrap-panel-close';
import { useClosingStore } from '../../stores/closing.store';
import { EXIT_DURATION_MS } from '../../shell/motion/tokens';

interface FakePanel {
  api: { id: string; close: () => void; setActive: ReturnType<typeof vi.fn> };
}

function makeWrappedPanel(id: string, realClose: () => void): FakePanel {
  const panel: FakePanel = {
    api: { id, close: realClose, setActive: vi.fn() },
  };
  wrapPanelClose(panel as never); // 替换 api.close 为延后真 close 的包装
  return panel;
}

function makeApi(panels: Map<string, FakePanel>): DockviewApi {
  return {
    getPanel: (id: string) => panels.get(id),
    addPanel: vi.fn(),
  } as unknown as DockviewApi;
}

describe('49 第八 session · dock-api-ref 聚焦取消 pending close', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    useClosingStore.setState({ ids: new Set() });
  });
  afterEach(() => {
    vi.useRealTimers();
    setDockApi(null);
  });

  it('focusPanel 在 EXIT 窗口内聚焦 → 撤销真 close,面板不消失', () => {
    const realClose = vi.fn();
    const panel = makeWrappedPanel('explorer', realClose);
    setDockApi(makeApi(new Map([['explorer', panel]])));

    panel.api.close(); // 用户关闭 → 排定真 close
    expect(useClosingStore.getState().ids.has('explorer')).toBe(true);

    focusPanel('explorer'); // EXIT 窗口内重新聚焦
    expect(panel.api.setActive).toHaveBeenCalled();
    expect(useClosingStore.getState().ids.has('explorer')).toBe(false); // 标记清除

    vi.advanceTimersByTime(EXIT_DURATION_MS + 50);
    expect(realClose).not.toHaveBeenCalled(); // 真 close 被撤销
  });

  it('openOrFocusPanel 命中 existing → 撤销真 close,面板不消失', () => {
    const realClose = vi.fn();
    const panel = makeWrappedPanel('settings', realClose);
    setDockApi(makeApi(new Map([['settings', panel]])));

    panel.api.close();
    openOrFocusPanel('settings', 'settings', 'Settings', 'panels.settings.title');
    expect(panel.api.setActive).toHaveBeenCalled();

    vi.advanceTimersByTime(EXIT_DURATION_MS + 50);
    expect(realClose).not.toHaveBeenCalled();
  });

  it('未处于关闭窗口的正常聚焦不受影响(setActive 照常)', () => {
    const realClose = vi.fn();
    const panel = makeWrappedPanel('output', realClose);
    setDockApi(makeApi(new Map([['output', panel]])));

    focusPanel('output'); // 没先 close
    expect(panel.api.setActive).toHaveBeenCalled();
    vi.advanceTimersByTime(EXIT_DURATION_MS + 50);
    expect(realClose).not.toHaveBeenCalled();
  });
});
