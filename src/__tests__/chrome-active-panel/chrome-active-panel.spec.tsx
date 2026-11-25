// @vitest-environment jsdom
// BDD:标题栏 / 状态栏 / 窗口标题跟随主窗活动的 dock 面板。见同目录 README.md。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render } from '@testing-library/react';
import { DockviewComponent, type DockviewApi } from 'dockview-react';
import { setDockApi } from '@/shell/dock/dock-api-ref';
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
  useWorkspaceStore.setState({ root: '/w' });
  useEditorStore.setState({
    tabs: [{ id: README, filePath: README, content: '# hi\n', originalContent: '# hi\n', dirty: false }],
    activeTabId: README,
  });
});

afterEach(() => {
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

  it('dock 尚未就绪 → 按编辑器活动 tab 显示(启动期不闪)', () => {
    const { container } = render(<TitleBar />);
    expect(titleText(container)).toContain('README.md');
  });
});
