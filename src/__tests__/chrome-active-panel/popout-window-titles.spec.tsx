// @vitest-environment jsdom
// BDD:窗口标题按窗口分别计算 —— 主窗标题栏 / 状态栏 / 窗口标题只显示主窗的活动编辑器,popout 子窗原生标题是子窗自己的活动文件。
// 见同目录 README.md。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render } from '@testing-library/react';
import { DockviewComponent, type DockviewApi, type IDockviewPanel } from 'dockview-react';
import { setDockApi } from '@/shell/dock/dock-api-ref';
import { trackPopoutDocuments } from '@/shell/dock/popout-documents';
import { trackPopoutWindowTitles } from '@/shell/dock/popout-window-titles';
import { trackEditorGroups } from '@/shell/dock/editor-groups-dock-sync';
import { TitleBar } from '@/shell/TitleBar';
import { StatusBar } from '@/shell/StatusBar';
import { createTab, useEditorStore } from '@/stores/editor.store';
import { useWorkspaceStore } from '@/stores/workspace.store';

class NoopResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

const A = '/w/main-file.ts';
const B = '/w/child-file.ts';
const disposers: { dispose(): void }[] = [];

function childWindow(): Window {
  const frame = document.createElement('iframe');
  document.body.appendChild(frame);
  return frame.contentWindow!;
}

function popOut(group: IDockviewPanel['group'], win: Window): void {
  (group as unknown as { model: { location: unknown } }).model.location = { type: 'popout', getWindow: () => win };
}

/** 主窗 editor(A)、popout 子窗 editor:2(B);活动组 / 活动编辑器组在子窗(⌘` 切过去 / 重启恢复挂上子窗)。 */
function editorGroupsInBothWindows() {
  useEditorStore.setState({
    tabs: [createTab(A, 'a\n'), createTab(B, 'b\nb\nb\n')],
    groups: [
      { id: 'editor', tabIds: [A], activeTabId: A },
      { id: 'editor:2', tabIds: [B], activeTabId: B },
    ],
    activeGroupId: 'editor',
    activeTabId: A,
  });
  vi.stubGlobal('ResizeObserver', NoopResizeObserver);
  const container = document.createElement('div');
  document.body.appendChild(container);
  const api: DockviewApi = new DockviewComponent(container, {
    createComponent: () => ({ element: document.createElement('div'), init: () => {} }),
  }).api;
  const main = api.addPanel({ id: 'editor', component: 'editor', title: 'Editor' });
  const child = api.addPanel({ id: 'editor:2', component: 'editor', title: 'Editor', position: { direction: 'right' } });
  const win = childWindow();
  disposers.push(trackPopoutDocuments(api), trackEditorGroups(api));
  act(() => {
    popOut(child.group, win);
    main.api.setActive();
    setDockApi(api);
  });
  act(() => child.api.setActive());
  expect(useEditorStore.getState().activeGroupId).toBe('editor:2');
  return { api, main, child, win };
}

const titleText = (container: HTMLElement) => container.querySelector('header')!.textContent ?? '';
const footerText = (container: HTMLElement) => container.querySelector('footer')!.textContent ?? '';

beforeEach(() => {
  useWorkspaceStore.setState({ root: '/w' });
});
afterEach(() => {
  cleanup();
  for (const d of disposers.splice(0)) d.dispose();
  act(() => setDockApi(null));
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
  document.title = '';
});

describe('主窗标题栏 / 状态栏 / 窗口标题只显示主窗的活动编辑器', () => {
  it('活动编辑器组在子窗 → 主窗仍显示主窗组的活动文件,不显示子窗的文件', () => {
    editorGroupsInBothWindows();
    const { container } = render(
      <>
        <TitleBar />
        <StatusBar />
      </>,
    );
    expect(titleText(container)).toContain('main-file.ts');
    expect(titleText(container)).not.toContain('child-file.ts');
    expect(footerText(container)).toContain('main-file.ts');
    expect(footerText(container)).not.toContain('child-file.ts');
    expect(document.title).toBe('main-file.ts · w');
  });

  it('主窗组切换活动文件 → 主窗标题跟随;子窗组切换 → 主窗标题不变', () => {
    editorGroupsInBothWindows();
    const C = '/w/other-main.ts';
    const { container } = render(<TitleBar />);
    act(() => useEditorStore.getState().openTab(createTab(C, 'c'), { groupId: 'editor', activate: true }));
    expect(titleText(container)).toContain('other-main.ts');
    act(() => useEditorStore.getState().openTab(createTab('/w/other-child.ts', 'd'), { groupId: 'editor:2', activate: true }));
    expect(titleText(container)).toContain('other-main.ts');
    expect(titleText(container)).not.toContain('other-child.ts');
  });

  it('主窗没有面板(全部弹出到子窗)→ 主窗只显示工作区,不显示子窗的文件', () => {
    const { main } = editorGroupsInBothWindows();
    act(() => main.api.close());
    const { container } = render(<TitleBar />);
    expect(titleText(container)).not.toContain('child-file.ts');
    expect(document.title).toBe('w');
  });
});

describe('popout 子窗的原生窗口标题是子窗自己的活动文件', () => {
  it('子窗标题 = 子窗组的活动文件 · 工作区;dockview 开窗时抄来的主窗标题被替换', () => {
    const { api, win } = editorGroupsInBothWindows();
    win.document.title = 'main-file.ts · w'; // dockview 开窗时抄的主窗标题
    disposers.push(trackPopoutWindowTitles(api));
    expect(win.document.title).toBe('child-file.ts · w');
  });

  it('子窗文件变脏 / 切换活动文件 → 子窗标题跟随;主窗组的变化不影响子窗标题', () => {
    const { api, win } = editorGroupsInBothWindows();
    disposers.push(trackPopoutWindowTitles(api));
    act(() => useEditorStore.getState().updateContent(B, 'changed'));
    expect(win.document.title).toBe('child-file.ts ● · w');
    act(() => useEditorStore.getState().openTab(createTab('/w/next-child.ts', 'n'), { groupId: 'editor:2', activate: true }));
    expect(win.document.title).toBe('next-child.ts · w');
    act(() => useEditorStore.getState().openTab(createTab('/w/next-main.ts', 'n'), { groupId: 'editor', activate: true }));
    expect(win.document.title).toBe('next-child.ts · w');
  });

  it('子窗活动的是非编辑器面板 → 子窗标题是面板名;停止跟踪后不再改写', async () => {
    const { api, child, win } = editorGroupsInBothWindows();
    const tracking = trackPopoutWindowTitles(api);
    const output = api.addPanel({ id: 'output', component: 'output', title: 'Output', position: { referencePanel: child } });
    await act(async () => {
      output.api.setActive();
      await Promise.resolve();
    });
    expect(win.document.title).toBe('Output · w');
    tracking.dispose();
    act(() => child.api.setActive());
    expect(win.document.title).toBe('Output · w');
  });
});

