// @vitest-environment jsdom
// race(R9):StatusBar MCP 配置复制反馈的 1500ms 清空 timer 须保存 + token 校验。裸 setTimeout
// 不清旧 timer → 连续复制时第一轮 timeout 会在第二轮反馈刚显示后把状态清回 idle,SR/用户错过
// 真实结果。修复后:新复制清旧 timer,旧 timer 不得清掉新反馈。
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, cleanup, act } from '@testing-library/react';

vi.mock('../../plugins/sandbox-sweep', () => ({
  getCachedFetch: () => globalThis.fetch,
  getCachedClipboard: () => ({
    readText: () => Promise.resolve(''),
    writeText: vi.fn().mockResolvedValue(undefined),
  }),
  sandboxSweep: () => {},
}));

import { _resetLmApiForTest, captureLmApi } from '../../lib/co-api';
import { StatusBar } from '../../shell/StatusBar';
import { useEditorStore } from '../../stores/editor.store';
import { useWorkspaceStore } from '../../stores/workspace.store';
import { useLayoutUiStore } from '../../stores/layout-ui.store';
import { useTerminalStore } from '../../stores/terminal.store';
import { _resetAgentAuthForTest } from '../../stores/agent-auth.store';
import { coApp } from '../../plugins/co-app';
import { StatusBarRegistry } from '../../plugins/registries/StatusBarRegistry';

function installApi(): void {
  Object.defineProperty(window, 'api', {
    value: {
      mcp: {
        getStdioConfig: () =>
          Promise.resolve({
            ok: true,
            data: { available: true, claudeAddCommand: 'claude mcp add ...' },
          }),
      },
    },
    writable: true,
    configurable: true,
  });
  captureLmApi();
}

function copyButton(container: HTMLElement): HTMLButtonElement {
  const btn = Array.from(
    container.querySelectorAll<HTMLButtonElement>('button'),
  ).find((b) => (b.textContent ?? '').includes('复制 MCP 配置') ||
    (b.textContent ?? '').includes('已复制'));
  if (!btn) throw new Error('copy button not found');
  return btn;
}

beforeEach(() => {
  _resetLmApiForTest();
  _resetAgentAuthForTest();
  useEditorStore.setState({ tabs: [], activeTabId: null });
  useWorkspaceStore.setState({ root: null, recentRoots: [] });
  useLayoutUiStore.setState({ sidebarOpen: true, sidebarWidth: 280 });
  useTerminalStore.setState({ sessions: [], activeId: null });
  (coApp as { statusBar: StatusBarRegistry }).statusBar = new StatusBarRegistry();
});

afterEach(() => {
  delete (window as { api?: unknown }).api;
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('race(R9) — StatusBar 复制反馈 timer 不被旧轮清掉', () => {
  it('连续复制:第一轮旧 timeout 不清掉第二轮的「已复制」反馈', async () => {
    vi.useFakeTimers();
    installApi();
    const { container } = render(<StatusBar />);

    // 第一次复制 → 「已复制」
    await act(async () => {
      copyButton(container).click();
      await vi.advanceTimersByTimeAsync(0); // flush getStdioConfig + writeText 微任务
    });
    expect(copyButton(container).textContent).toContain('已复制');

    // 1000ms 后(第一轮 timer 还有 500ms 到期)再次复制
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    await act(async () => {
      copyButton(container).click();
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(copyButton(container).textContent).toContain('已复制');

    // 再过 600ms(第一轮 timer 原应在此前的 t=1500 到期清 idle)→ 新反馈须仍在。
    await act(async () => {
      await vi.advanceTimersByTimeAsync(600);
    });
    // 旧 timer 已被清,新 timer(t=1000+1500=2500)未到 → 仍「已复制」。
    expect(copyButton(container).textContent).toContain('已复制');

    // 直到新 timer 到期(再过 ~900ms 至 t=2500+)才清回 idle。
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(copyButton(container).textContent).toContain('复制 MCP 配置');
  });
});
