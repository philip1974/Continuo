// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { fireEvent, render, cleanup, act, waitFor } from '@testing-library/react';
import {
  _resetLmApiForTest,
  captureLmApi,
} from '../../lib/co-api';
import { ExplorerHeader } from '../../panels/Explorer/ExplorerHeader';
import { useWorkspaceStore } from '../../stores/workspace.store';
import { useEditorStore } from '../../stores/editor.store';
import { notify } from '../../notifications/notify';
import { workspaceRootSelectionGuard } from '../../lib/workspace-root-guard';

function installFs(
  selectDirectory: ReturnType<typeof vi.fn>,
  // a11y(A147):点 recent root 现先 listDir 校验 → 默认给 ok 桩,失败用例显式覆盖。
  listDir: ReturnType<typeof vi.fn> = vi.fn().mockResolvedValue({ ok: true, data: [] }),
): void {
  Object.defineProperty(window, 'api', {
    value: { fs: { selectDirectory, listDir } },
    writable: true,
    configurable: true,
  });
  captureLmApi();
}

beforeEach(() => {
  _resetLmApiForTest();
  useWorkspaceStore.setState({ root: '/proj', recentRoots: ['/proj'] });
  useEditorStore.setState({ tabs: [], activeTabId: null });
});

afterEach(() => {
  delete (window as { api?: unknown }).api;
  cleanup();
  vi.restoreAllMocks();
});

describe('ExplorerHeader — 标题', () => {
  it('显示 basename(root) + title=完整路径', () => {
    installFs(vi.fn());
    const { container } = render(
      <ExplorerHeader root="/Users/foo/projects/myapp" />,
    );
    const title = container.querySelector('span[title]') as HTMLElement;
    expect(title.textContent).toBe('myapp');
    expect(title.getAttribute('title')).toBe('/Users/foo/projects/myapp');
  });
});

describe('ExplorerHeader — Hover 工具条', () => {
  it('callbacks 缺 → 不渲染对应按钮', () => {
    installFs(vi.fn());
    const { container } = render(<ExplorerHeader root="/proj" />);
    expect(container.querySelector('button[aria-label=新建文件]')).toBeNull();
    expect(container.querySelector('button[aria-label=新建文件夹]')).toBeNull();
    expect(container.querySelector('button[aria-label=刷新]')).toBeNull();
    expect(container.querySelector('button[aria-label=折叠全部]')).toBeNull();
  });

  it('onNewFile 提供 → 点击调 fn', () => {
    installFs(vi.fn());
    const onNewFile = vi.fn();
    const { container } = render(
      <ExplorerHeader root="/proj" onNewFile={onNewFile} />,
    );
    fireEvent.click(
      container.querySelector('button[aria-label=新建文件]') as HTMLButtonElement,
    );
    expect(onNewFile).toHaveBeenCalledTimes(1);
  });

  it('onNewDir / onRefresh / onCollapseAll 同模式', () => {
    installFs(vi.fn());
    const onNewDir = vi.fn();
    const onRefresh = vi.fn();
    const onCollapseAll = vi.fn();
    const { container } = render(
      <ExplorerHeader
        root="/proj"
        onNewDir={onNewDir}
        onRefresh={onRefresh}
        onCollapseAll={onCollapseAll}
      />,
    );
    fireEvent.click(
      container.querySelector(
        'button[aria-label=新建文件夹]',
      ) as HTMLButtonElement,
    );
    fireEvent.click(
      container.querySelector('button[aria-label=刷新资源管理器]') as HTMLButtonElement,
    );
    fireEvent.click(
      container.querySelector(
        'button[aria-label=折叠全部]',
      ) as HTMLButtonElement,
    );
    expect(onNewDir).toHaveBeenCalledTimes(1);
    expect(onRefresh).toHaveBeenCalledTimes(1);
    expect(onCollapseAll).toHaveBeenCalledTimes(1);
  });
});

describe('ExplorerHeader — ⋯ 菜单', () => {
  it('默认关闭', () => {
    installFs(vi.fn());
    render(<ExplorerHeader root="/proj" />);
    expect(document.querySelector('[role=menu]')).toBeNull();
  });

  // a11y(A78,A75 同族):最近目录菜单项只显视觉 basename,同名目录须靠 aria-label(完整路径)区分。
  it('a11y · 同 basename 的 recent 菜单项 aria-label 含完整路径可区分', () => {
    installFs(vi.fn());
    useWorkspaceStore.setState({
      root: '/proj',
      recentRoots: ['/proj', '/a/work', '/b/work'],
    });
    const { container } = render(<ExplorerHeader root="/proj" />);
    const moreBtn = container.querySelector(
      'button[aria-label=更多操作]',
    ) as HTMLButtonElement;
    fireEvent.click(moreBtn);
    const labels = Array.from(
      document.querySelectorAll<HTMLButtonElement>('[role=menuitem]'),
    )
      .map((b) => b.getAttribute('aria-label') ?? '')
      .filter((l) => l.includes('打开最近'));
    expect(labels.some((l) => l.includes('/a/work'))).toBe(true);
    expect(labels.some((l) => l.includes('/b/work'))).toBe(true);
  });

  it('recent 菜单排除当前 root', () => {
    installFs(vi.fn());
    useWorkspaceStore.setState({
      root: '/proj',
      recentRoots: ['/proj', '/old'],
    });
    const { container } = render(<ExplorerHeader root="/proj" />);
    fireEvent.click(
      container.querySelector('button[aria-label=更多操作]') as HTMLButtonElement,
    );
    const labels = Array.from(
      document.querySelectorAll<HTMLButtonElement>('[role=menuitem]'),
    )
      .map((b) => b.getAttribute('aria-label') ?? '')
      .filter((l) => l.includes('打开最近'));
    expect(labels.some((l) => l.includes('/old'))).toBe(true);
    expect(labels.some((l) => l.includes('/proj'))).toBe(false);
  });

  it('recentRoots 只有当前 root 时不渲染 recent group', () => {
    installFs(vi.fn());
    useWorkspaceStore.setState({
      root: '/proj',
      recentRoots: ['/proj'],
    });
    const { container } = render(<ExplorerHeader root="/proj" />);
    fireEvent.click(
      container.querySelector('button[aria-label=更多操作]') as HTMLButtonElement,
    );
    expect(document.querySelector('[role=group][aria-label]')).toBeNull();
  });

  // a11y(A113):role=menu 内 recent 区结构完整 —— 分隔线 role=separator、最近项在 role=group(有组名)。
  it('a11y · recent 菜单区有 separator + 命名 group 包住最近项', () => {
    installFs(vi.fn());
    useWorkspaceStore.setState({
      root: '/proj',
      recentRoots: ['/proj', '/a/work'],
    });
    const { container } = render(<ExplorerHeader root="/proj" />);
    fireEvent.click(
      container.querySelector('button[aria-label=更多操作]') as HTMLButtonElement,
    );
    const menu = document.querySelector('[role=menu]')!;
    // 分隔线标 role=separator(不再是裸 div)
    expect(menu.querySelectorAll('[role=separator]').length).toBeGreaterThanOrEqual(1);
    // 最近项在命名 group 内
    const group = menu.querySelector('[role=group][aria-label]');
    expect(group).not.toBeNull();
    expect((group!.getAttribute('aria-label') ?? '').length).toBeGreaterThan(0);
    expect(group!.querySelectorAll('[role=menuitem]').length).toBeGreaterThanOrEqual(1);
  });

  it('点 ⋯ → 打开;再点 → 关', () => {
    installFs(vi.fn());
    const { container } = render(<ExplorerHeader root="/proj" />);
    const moreBtn = container.querySelector(
      'button[aria-label=更多操作]',
    ) as HTMLButtonElement;
    fireEvent.click(moreBtn);
    expect(document.querySelector('[role=menu]')).not.toBeNull();
    fireEvent.click(moreBtn);
    expect(document.querySelector('[role=menu]')).toBeNull();
  });

  // race(R27):切换文件夹的对话框结果落地前,别的 root 选择入口(drop / 打开最近 / EmptyWorkspace
  // 打开)发起新选择 → 本次过期,不得 setRoot(共享守卫)。否则迟到的对话框结果覆盖更新的选择。
  it('R27 切换文件夹结果落地前另一入口接管 → 不 setRoot(共享守卫作废过期结果)', async () => {
    let release: (v: unknown) => void = () => {};
    const selectDirectory = vi.fn(
      () => new Promise((resolve) => {
        release = resolve;
      }),
    );
    installFs(selectDirectory);
    render(<ExplorerHeader root="/proj" />);
    fireEvent.click(
      document.querySelector('button[aria-label=更多操作]') as HTMLButtonElement,
    );
    const switchItem = Array.from(
      document.querySelectorAll<HTMLElement>('[role=menuitem]'),
    ).find((b) => (b.textContent ?? '').includes('切换文件夹'))!;
    expect(switchItem).toBeDefined();
    fireEvent.click(switchItem);
    await waitFor(() => expect(selectDirectory).toHaveBeenCalled());
    // 另一个 root 选择入口接管 → 共享守卫 begin() 使本次过期。
    workspaceRootSelectionGuard.begin();
    release({ ok: true, data: '/late/picked' });
    await new Promise((r) => setTimeout(r, 0));
    expect(useWorkspaceStore.getState().root).toBe('/proj'); // 未被过期结果覆盖
  });

  // race(R28):切换文件夹在途时点「关闭文件夹」(同步 setRoot(null)),迟到的 selectDirectory
  // 结果不得撤销关闭(关闭前 cancelPendingWorkspaceRootSelection 作废在途选择)。
  it('R28 切换文件夹在途时点关闭文件夹 → 迟到结果不撤销关闭', async () => {
    let release: (v: unknown) => void = () => {};
    const selectDirectory = vi.fn(
      () => new Promise((resolve) => {
        release = resolve;
      }),
    );
    installFs(selectDirectory);
    useWorkspaceStore.setState({ root: '/proj', recentRoots: ['/proj'] });
    render(<ExplorerHeader root="/proj" />);

    // 打开菜单 → 点「切换文件夹…」(发起在途 selectDirectory,菜单随之关闭)
    fireEvent.click(
      document.querySelector('button[aria-label=更多操作]') as HTMLButtonElement,
    );
    const switchItem = Array.from(
      document.querySelectorAll<HTMLElement>('[role=menuitem]'),
    ).find((b) => (b.textContent ?? '').includes('切换文件夹'))!;
    fireEvent.click(switchItem);
    await waitFor(() => expect(selectDirectory).toHaveBeenCalled());

    // 重新打开菜单 → 点「关闭文件夹」(同步 setRoot(null) + 作废在途)
    fireEvent.click(
      document.querySelector('button[aria-label=更多操作]') as HTMLButtonElement,
    );
    const closeItem = Array.from(
      document.querySelectorAll<HTMLElement>('[role=menuitem]'),
    ).find((b) => (b.textContent ?? '').includes('关闭文件夹'))!;
    fireEvent.click(closeItem);
    expect(useWorkspaceStore.getState().root).toBeNull(); // 已关闭

    // 切换文件夹的对话框迟到 resolve → 不得撤销关闭。
    release({ ok: true, data: '/late/picked' });
    await new Promise((r) => setTimeout(r, 0));
    expect(useWorkspaceStore.getState().root).toBeNull();
  });

  // a11y(A6):菜单触发按钮须告知 AT 它弹 menu 弹层(aria-haspopup)及当前展开态(aria-expanded)。
  it('a11y · ⋯ 按钮有 aria-haspopup=menu + aria-expanded 随开合切换', () => {
    installFs(vi.fn());
    const { container } = render(<ExplorerHeader root="/proj" />);
    const moreBtn = container.querySelector(
      'button[aria-label=更多操作]',
    ) as HTMLButtonElement;
    expect(moreBtn.getAttribute('aria-haspopup')).toBe('menu');
    expect(moreBtn.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(moreBtn);
    expect(moreBtn.getAttribute('aria-expanded')).toBe('true');
    fireEvent.click(moreBtn);
    expect(moreBtn.getAttribute('aria-expanded')).toBe('false');
  });

  // a11y(A18):菜单打开后焦点须移入第一个可用 menuitem;Escape 关闭并还原焦点到触发按钮;
  // 方向键在 menuitem 间漫游(WAI-ARIA menu 键盘契约)。
  it('a11y · 菜单打开移焦入首项 / Escape 还原焦点 / ArrowDown 漫游', () => {
    installFs(vi.fn());
    const { container } = render(
      <ExplorerHeader root="/proj" onExpandAll={vi.fn()} />,
    );
    const moreBtn = container.querySelector(
      'button[aria-label=更多操作]',
    ) as HTMLButtonElement;

    // 打开 → 焦点移入第一个可用 menuitem(展开全部)
    fireEvent.click(moreBtn);
    const active1 = document.activeElement as HTMLElement;
    expect(active1.getAttribute('role')).toBe('menuitem');
    expect(active1.textContent).toBe('展开全部');

    // ArrowDown → 焦点移到下一个 menuitem(切换文件夹…)
    const menu = document.querySelector('[role=menu]') as HTMLElement;
    fireEvent.keyDown(menu, { key: 'ArrowDown' });
    expect((document.activeElement as HTMLElement).textContent).toBe(
      '切换文件夹…',
    );

    // Escape → 关菜单 + 焦点还原到触发按钮
    fireEvent.keyDown(menu, { key: 'Escape' });
    expect(document.querySelector('[role=menu]')).toBeNull();
    expect(document.activeElement).toBe(moreBtn);
  });

  it('a11y · 菜单方向键漫游不通过 Array.from 物化 menuitem 列表', () => {
    installFs(vi.fn());
    const { container } = render(
      <ExplorerHeader root="/proj" onExpandAll={vi.fn()} />,
    );
    fireEvent.click(
      container.querySelector(
        'button[aria-label=更多操作]',
      ) as HTMLButtonElement,
    );
    const menu = document.querySelector('[role=menu]') as HTMLElement;
    const fromSpy = vi.spyOn(Array, 'from');

    try {
      fireEvent.keyDown(menu, { key: 'ArrowDown' });
      expect((document.activeElement as HTMLElement).textContent).toBe(
        '切换文件夹…',
      );
      const nodeListCalls = fromSpy.mock.calls.filter(
        ([arg]) => arg instanceof NodeList,
      );
      expect(nodeListCalls).toHaveLength(0);
    } finally {
      fromSpy.mockRestore();
    }
  });

  // a11y(A30,A18/A27 同族):自写 menu 项激活后须把焦点还原到触发按钮(否则随菜单卸载焦点落
  // body)。普通项(展开全部等,不会主动聚焦新目标)用 closeAndRestore。
  it('a11y · 菜单项激活后焦点还原到触发按钮', () => {
    installFs(vi.fn());
    const onExpandAll = vi.fn();
    const { container } = render(
      <ExplorerHeader root="/proj" onExpandAll={onExpandAll} />,
    );
    const moreBtn = container.querySelector(
      'button[aria-label=更多操作]',
    ) as HTMLButtonElement;
    fireEvent.click(moreBtn);
    const expandItem = Array.from(
      document.querySelectorAll<HTMLButtonElement>('[role=menuitem]'),
    ).find((b) => b.textContent === '展开全部')!;
    fireEvent.click(expandItem);
    expect(onExpandAll).toHaveBeenCalledTimes(1);
    expect(document.querySelector('[role=menu]')).toBeNull(); // 菜单关闭
    expect(document.activeElement).toBe(moreBtn); // 焦点还原到触发按钮
  });

  // a11y(A31):menuitem 都 tabIndex=-1,Tab 关闭菜单并把焦点还原到触发按钮(避免焦点 leak)。
  it('a11y · 菜单项 tabIndex=-1 + Tab 关闭菜单还原焦点', () => {
    installFs(vi.fn());
    const { container } = render(<ExplorerHeader root="/proj" onExpandAll={vi.fn()} />);
    const moreBtn = container.querySelector(
      'button[aria-label=更多操作]',
    ) as HTMLButtonElement;
    fireEvent.click(moreBtn);
    const items = Array.from(
      document.querySelectorAll<HTMLButtonElement>('[role=menuitem]'),
    );
    expect(items.length).toBeGreaterThan(0);
    expect(items.every((b) => b.tabIndex === -1)).toBe(true); // 不在 Tab 顺序
    const menu = document.querySelector('[role=menu]') as HTMLElement;
    fireEvent.keyDown(menu, { key: 'Tab' });
    expect(document.querySelector('[role=menu]')).toBeNull(); // Tab 关闭菜单
    expect(document.activeElement).toBe(moreBtn); // 焦点还原
  });

  it('「展开全部」disabled=!onExpandAll', () => {
    installFs(vi.fn());
    const { container, rerender } = render(<ExplorerHeader root="/proj" />);
    fireEvent.click(
      container.querySelector(
        'button[aria-label=更多操作]',
      ) as HTMLButtonElement,
    );
    let expandItem = Array.from(
      document.querySelectorAll<HTMLButtonElement>('[role=menuitem]'),
    ).find((b) => b.textContent === '展开全部')!;
    expect(expandItem.disabled).toBe(true);

    rerender(
      <ExplorerHeader root="/proj" onExpandAll={vi.fn()} />,
    );
    expandItem = Array.from(
      document.querySelectorAll<HTMLButtonElement>('[role=menuitem]'),
    ).find((b) => b.textContent === '展开全部')!;
    expect(expandItem.disabled).toBe(false);
  });

  it('点「展开全部」→ onExpandAll + 关菜单', () => {
    installFs(vi.fn());
    const onExpandAll = vi.fn();
    const { container } = render(
      <ExplorerHeader root="/proj" onExpandAll={onExpandAll} />,
    );
    fireEvent.click(
      container.querySelector(
        'button[aria-label=更多操作]',
      ) as HTMLButtonElement,
    );
    const expandItem = Array.from(
      document.querySelectorAll<HTMLButtonElement>('[role=menuitem]'),
    ).find((b) => b.textContent === '展开全部')!;
    fireEvent.click(expandItem);
    expect(onExpandAll).toHaveBeenCalledTimes(1);
    expect(document.querySelector('[role=menu]')).toBeNull();
  });

  it('点「关闭文件夹」 → setRoot(null) + 关菜单', () => {
    installFs(vi.fn());
    const { container } = render(<ExplorerHeader root="/proj" />);
    fireEvent.click(
      container.querySelector(
        'button[aria-label=更多操作]',
      ) as HTMLButtonElement,
    );
    const closeItem = Array.from(
      document.querySelectorAll<HTMLButtonElement>('[role=menuitem]'),
    ).find((b) => b.textContent === '关闭文件夹')!;
    fireEvent.click(closeItem);
    expect(useWorkspaceStore.getState().root).toBeNull();
  });

  it('点「切换文件夹…」 → selectDirectory ok=true + setRoot', async () => {
    const selectDirectory = vi
      .fn()
      .mockResolvedValue({ ok: true, data: '/picked' });
    installFs(selectDirectory);
    const { container } = render(<ExplorerHeader root="/proj" />);
    fireEvent.click(
      container.querySelector(
        'button[aria-label=更多操作]',
      ) as HTMLButtonElement,
    );
    const switchItem = Array.from(
      document.querySelectorAll<HTMLButtonElement>('[role=menuitem]'),
    ).find((b) => b.textContent === '切换文件夹…')!;
    fireEvent.click(switchItem);
    await waitFor(() => {
      expect(useWorkspaceStore.getState().root).toBe('/picked');
    });
  });

  function clickSwitchFolder(container: HTMLElement) {
    fireEvent.click(
      container.querySelector('button[aria-label=更多操作]') as HTMLButtonElement,
    );
    const switchItem = Array.from(
      document.querySelectorAll<HTMLButtonElement>('[role=menuitem]'),
    ).find((b) => b.textContent === '切换文件夹…')!;
    fireEvent.click(switchItem);
  }

  // a11y(A146,A141 同族):selectDirectory !r.ok / reject 须 notify.error(此前静默);取消(ok+无 data)不报。
  it('切换文件夹 selectDirectory {ok:false} → notify.error', async () => {
    const errSpy = vi.spyOn(notify, 'error').mockImplementation(() => {});
    installFs(vi.fn().mockResolvedValue({ ok: false, code: 'EACCES', message: 'no perm' }));
    const { container } = render(<ExplorerHeader root="/proj" />);
    clickSwitchFolder(container);
    await waitFor(() => {
      expect(errSpy).toHaveBeenCalledTimes(1);
    });
    expect(useWorkspaceStore.getState().root).toBe('/proj');
  });

  it('切换文件夹 selectDirectory reject → notify.error(不抛)', async () => {
    const errSpy = vi.spyOn(notify, 'error').mockImplementation(() => {});
    installFs(vi.fn().mockRejectedValue(new Error('ipc down')));
    const { container } = render(<ExplorerHeader root="/proj" />);
    clickSwitchFolder(container);
    await waitFor(() => {
      expect(errSpy).toHaveBeenCalledTimes(1);
    });
  });

  it('切换文件夹 取消(ok + 无 data)→ 不 notify', async () => {
    const errSpy = vi.spyOn(notify, 'error').mockImplementation(() => {});
    installFs(vi.fn().mockResolvedValue({ ok: true, data: null }));
    const { container } = render(<ExplorerHeader root="/proj" />);
    clickSwitchFolder(container);
    await new Promise((r) => setTimeout(r, 0));
    expect(errSpy).not.toHaveBeenCalled();
    expect(useWorkspaceStore.getState().root).toBe('/proj');
  });

  it('文档 pointerdown 在 wrap 外 → 关菜单', () => {
    installFs(vi.fn());
    const { container } = render(<ExplorerHeader root="/proj" />);
    fireEvent.click(
      container.querySelector(
        'button[aria-label=更多操作]',
      ) as HTMLButtonElement,
    );
    expect(document.querySelector('[role=menu]')).not.toBeNull();

    act(() => {
      document.dispatchEvent(
        new PointerEvent('pointerdown', { bubbles: true }),
      );
    });
    expect(document.querySelector('[role=menu]')).toBeNull();
  });
});

describe('ExplorerHeader — 最近打开列表', () => {
  it('recentOthers 空(只有当前)→ 不渲染「打开最近」', () => {
    useWorkspaceStore.setState({ root: '/proj', recentRoots: ['/proj'] });
    installFs(vi.fn());
    const { container } = render(<ExplorerHeader root="/proj" />);
    fireEvent.click(
      container.querySelector(
        'button[aria-label=更多操作]',
      ) as HTMLButtonElement,
    );
    expect(document.querySelector('[role=menu]')!.textContent).not.toContain(
      '打开最近',
    );
  });

  it('recentOthers 非空 → 列出 basename,点击 setRoot', async () => {
    useWorkspaceStore.setState({
      root: '/proj',
      recentRoots: ['/proj', '/Users/foo/older'],
    });
    installFs(vi.fn());
    const { container } = render(<ExplorerHeader root="/proj" />);
    fireEvent.click(
      container.querySelector(
        'button[aria-label=更多操作]',
      ) as HTMLButtonElement,
    );
    const olderItem = Array.from(
      document.querySelectorAll<HTMLButtonElement>('[role=menuitem]'),
    ).find((b) => b.textContent?.trim() === 'older')!;
    expect(olderItem).toBeDefined();
    // A147:点 recent → listDir 校验通过后才 setRoot(async)
    fireEvent.click(olderItem);
    await waitFor(() =>
      expect(useWorkspaceStore.getState().root).toBe('/Users/foo/older'),
    );
  });

  // a11y(A147):点已失效 recent root(listDir !ok)→ notify.error 且不切 root。
  it('点 recent root 但 listDir {ok:false} → notify.error 不切 root', async () => {
    const errSpy = vi.spyOn(notify, 'error').mockImplementation(() => {});
    useWorkspaceStore.setState({
      root: '/proj',
      recentRoots: ['/proj', '/Users/foo/older'],
    });
    installFs(
      vi.fn(),
      vi.fn().mockResolvedValue({ ok: false, code: 'FS_NOT_FOUND', message: 'gone' }),
    );
    const { container } = render(<ExplorerHeader root="/proj" />);
    fireEvent.click(
      container.querySelector('button[aria-label=更多操作]') as HTMLButtonElement,
    );
    const olderItem = Array.from(
      document.querySelectorAll<HTMLButtonElement>('[role=menuitem]'),
    ).find((b) => b.textContent?.trim() === 'older')!;
    fireEvent.click(olderItem);
    await waitFor(() => expect(errSpy).toHaveBeenCalledTimes(1));
    expect(useWorkspaceStore.getState().root).toBe('/proj');
  });
});
