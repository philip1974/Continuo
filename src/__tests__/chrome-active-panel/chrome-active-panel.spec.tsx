// @vitest-environment jsdom
// BDD:标题栏 / 状态栏 / 窗口标题跟随主窗活动的 dock 面板。见同目录 README.md。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render } from '@testing-library/react';
import { DockviewComponent, type DockviewApi } from 'dockview-react';
import { setDockApi } from '@/shell/dock/dock-api-ref';
import { POPOUT_RESTORE_POLL_MS, trackPopoutRestore } from '@/shell/dock/popout-restore-settle';
import { TitleBar } from '@/shell/TitleBar';
import { StatusBar } from '@/shell/StatusBar';
import { useEditorStore } from '@/stores/editor.store';
import { useWorkspaceStore } from '@/stores/workspace.store';

class NoopResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

function createDock(): DockviewApi {
  vi.stubGlobal('ResizeObserver', NoopResizeObserver);
  const container = document.createElement('div');
  document.body.appendChild(container);
  const dock = new DockviewComponent(container, {
    createComponent: () => ({ element: document.createElement('div'), init: () => {} }),
  });
  return dock.api;
}

const README = '/w/README.md';

beforeEach(() => {
  // 应用内标题栏只在 macOS 渲染(Windows / Linux 用原生标题栏,见 src/__tests__/win-linux-parity/)
  Object.defineProperty(navigator, 'platform', { value: 'MacIntel', configurable: true });
  useWorkspaceStore.setState({ root: '/w' });
  useEditorStore.setState({
    tabs: [{ id: README, filePath: README, content: '# hi\n', originalContent: '# hi\n', dirty: false }],
    activeTabId: README,
  });
});

afterEach(() => {
  Object.defineProperty(navigator, 'platform', { value: '', configurable: true });
  cleanup();
  act(() => setDockApi(null));
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
  document.title = '';
});

/** 编辑器与终端在同一组(tab 并列),返回 dock api。 */
function dockWithEditorAndTerminal(): DockviewApi {
  const api = createDock();
  api.addPanel({ id: 'editor', component: 'editor', title: 'Editor' });
  api.addPanel({ id: 'terminal-1', component: 'terminal', title: 'zsh' });
  api.getPanel('editor')!.api.setActive();
  act(() => setDockApi(api));
  return api;
}

const titleText = (container: HTMLElement) => container.querySelector('header')!.textContent ?? '';
const footerText = (container: HTMLElement) => container.querySelector('footer')!.textContent ?? '';
/** 状态栏里的行 / 词 / 字符统计文本(窄宽最先隐藏的那一项)。 */
const statsText = (container: HTMLElement) =>
  container.querySelector('footer span[class*="@max-2xl:hidden"]')?.textContent ?? '';

describe('标题栏 / 状态栏 / 窗口标题跟随活动 dock 面板', () => {
  it('编辑器活动 → 显示活动文件(标题栏、状态栏文件名与统计、窗口标题)', () => {
    dockWithEditorAndTerminal();
    const { container } = render(
      <>
        <TitleBar />
        <StatusBar />
      </>,
    );
    expect(titleText(container)).toContain('README.md');
    expect(footerText(container)).toContain('README.md');
    expect(document.title).toContain('README.md');
    expect(document.title).toContain('w');
  });

  it('切到终端 → 标题显示终端名 · 工作区;状态栏不显示文件名与统计;窗口标题同步', () => {
    const api = dockWithEditorAndTerminal();
    const { container } = render(
      <>
        <TitleBar />
        <StatusBar />
      </>,
    );
    const stats = statsText(container);
    expect(stats).toMatch(/\d/);
    act(() => api.getPanel('terminal-1')!.api.setActive());
    expect(titleText(container)).toContain('zsh');
    expect(titleText(container)).not.toContain('README.md');
    expect(footerText(container)).not.toContain('README.md');
    expect(footerText(container)).not.toContain(stats);
    expect(document.title).toContain('zsh');
    expect(document.title).not.toContain('README.md');
  });

  it('终端改名(面板标题变化)→ 标题随之更新;切回编辑器 → 恢复文件', () => {
    const api = dockWithEditorAndTerminal();
    const { container } = render(<TitleBar />);
    act(() => api.getPanel('terminal-1')!.api.setActive());
    act(() => api.getPanel('terminal-1')!.api.setTitle('build'));
    expect(titleText(container)).toContain('build');
    expect(document.title).toContain('build');
    act(() => api.getPanel('editor')!.api.setActive());
    expect(titleText(container)).toContain('README.md');
    expect(document.title).toContain('README.md');
  });

  it('重启恢复 popout:活动组是 popout 组且挂上时 dockview 不发事件 → 落定后标题改取主窗的活动编辑器', async () => {
    vi.useFakeTimers();
    try {
      const api = createDock();
      api.addPanel({ id: 'editor', component: 'editor', title: 'Editor' });
      // fromJSON 后:popout 组已建、已是活动组,但还没挂进子窗(location 仍是 grid)
      api.addPanel({ id: 'ui44', component: 'plugin', title: 'UI44 Panel', position: { direction: 'right' } });
      act(() => setDockApi(api));
      const tracking = trackPopoutRestore(api, 1);
      const { container } = render(<TitleBar />);
      expect(titleText(container)).toContain('UI44 Panel');

      // dockview addPopoutGroup 挂上:只改 location,组已是活动组 → 不派发任何事件
      const popoutGroup = api.getPanel('ui44')!.group as unknown as { model: { location: unknown } };
      popoutGroup.model.location = { type: 'popout', getWindow: () => window };
      await act(async () => {
        await vi.advanceTimersByTimeAsync(POPOUT_RESTORE_POLL_MS * 2);
      });
      expect(titleText(container)).toContain('README.md');
      expect(titleText(container)).not.toContain('UI44 Panel');
      expect(document.title).toContain('README.md');
      tracking.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it('popout 子窗关闭、面板收回主窗:组结构事件先于 location 变化派发、活动组不变 → 标题跟随收回的面板', async () => {
    const api = createDock();
    api.addPanel({ id: 'editor', component: 'editor', title: 'Editor' });
    api.addPanel({ id: 'ui44', component: 'plugin', title: 'UI44 Panel', position: { direction: 'right' } });
    const group = api.getPanel('ui44')!.group as unknown as { model: { location: unknown } };
    group.model.location = { type: 'popout', getWindow: () => window };
    act(() => setDockApi(api));
    const { container } = render(<TitleBar />);
    expect(titleText(container)).toContain('README.md');

    // dockview 收回 popout:doRemoveGroup 派发 onDidRemoveGroup(location 仍是 popout)→ 改回 grid → 静默加回,活动组不变
    const component = (api as unknown as { component: { _onDidRemoveGroup: { fire(g: unknown): void } } }).component;
    await act(async () => {
      component._onDidRemoveGroup.fire(group);
      group.model.location = { type: 'grid' };
      await Promise.resolve();
    });
    expect(titleText(container)).toContain('UI44 Panel');
  });

  it('dock 尚未就绪 → 按编辑器活动 tab 显示(启动期不闪)', () => {
    const { container } = render(<TitleBar />);
    expect(titleText(container)).toContain('README.md');
  });
});
