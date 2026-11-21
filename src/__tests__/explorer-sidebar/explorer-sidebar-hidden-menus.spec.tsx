// @vitest-environment jsdom
// 交互回归(侧栏保活隐藏引入):侧栏关闭改为 aside hidden 保活后,Explorer 的弹出菜单(Header
// 「更多操作」portal 到 body、文件行 Radix 右键菜单 Portal)不随隐藏关闭 → 菜单悬浮可操作看不见的
// 树,Radix 模态菜单令 body pointer-events:none 直到点外面/Esc。
// 契约:菜单打开时侧栏被隐藏(⌘B / 打开设置 → setSidebarOpen(false))→ 菜单节点移除且 body 无
// pointer-events:none 残留;再次显示侧栏不自动重开菜单。
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, cleanup, act, fireEvent } from '@testing-library/react';

vi.mock('../../panels/Explorer/FolderTree', async () => {
  const { ExplorerHeader } = await import('../../panels/Explorer/ExplorerHeader');
  const { ContextMenu } = await import('../../panels/Explorer/ContextMenu');
  const noop = () => {};
  const actions = {
    onRename: noop,
    onNewFile: noop,
    onNewDir: noop,
    onCopyPath: noop,
    onCopyRelativePath: noop,
    onRevealInFinder: noop,
    onOpenInTerminal: noop,
    onTrash: noop,
    onCut: noop,
    onCopy: noop,
    onPaste: noop,
  };
  return {
    FolderTree: ({ root }: { root: string }) => (
      <div>
        <ExplorerHeader root={root} />
        <ContextMenu
          target={{ name: 'a.ts', path: `${root}/a.ts`, isDirectory: false } as never}
          selectedPaths={new Set()}
          rootPath={root}
          actions={actions}
          hasClipboard={false}
          pluginItems={[]}
        >
          <div data-testid="row">a.ts</div>
        </ContextMenu>
      </div>
    ),
  };
});

import { ExplorerSidebar } from '../../shell/ExplorerSidebar';
import { useLayoutUiStore } from '../../stores/layout-ui.store';
import { useWorkspaceStore } from '../../stores/workspace.store';

beforeEach(() => {
  useWorkspaceStore.setState({ root: '/work', recentRoots: [] });
  useLayoutUiStore.setState({ sidebarOpen: true, sidebarWidth: 280 });
});
afterEach(() => cleanup());

const menus = () => document.querySelectorAll('[role=menu]');
const setSidebarOpen = (v: boolean) =>
  act(() => useLayoutUiStore.getState().setSidebarOpen(v));

describe('ExplorerSidebar · 隐藏时关闭 Explorer 弹出菜单', () => {
  it('Header「更多操作」菜单打开 → 隐藏侧栏:菜单移除;再显示不自动重开', () => {
    const { container } = render(<ExplorerSidebar />);
    const trigger = container.querySelector('[aria-haspopup=menu]') as HTMLElement;
    act(() => fireEvent.click(trigger));
    expect(menus()).toHaveLength(1);

    setSidebarOpen(false);
    expect(menus()).toHaveLength(0);
    expect(trigger.getAttribute('aria-expanded')).toBe('false');

    setSidebarOpen(true);
    expect(menus()).toHaveLength(0);

    // 显示后再点触发按钮仍可正常打开
    act(() => fireEvent.click(trigger));
    expect(menus()).toHaveLength(1);
  });

  it('文件行右键菜单打开 → 隐藏侧栏:菜单移除、body 无 pointer-events:none 残留;再显示不自动重开', () => {
    const { getByTestId } = render(<ExplorerSidebar />);
    act(() => {
      fireEvent.contextMenu(getByTestId('row'), { clientX: 10, clientY: 10 });
    });
    expect(menus()).toHaveLength(1);
    expect(document.body.style.pointerEvents).toBe('none');

    setSidebarOpen(false);
    expect(menus()).toHaveLength(0);
    expect(document.body.style.pointerEvents).not.toBe('none');

    setSidebarOpen(true);
    expect(menus()).toHaveLength(0);
    expect(document.body.style.pointerEvents).not.toBe('none');

    // 显示后再右键仍可正常打开
    act(() => {
      fireEvent.contextMenu(getByTestId('row'), { clientX: 10, clientY: 10 });
    });
    expect(menus()).toHaveLength(1);
  });
});
