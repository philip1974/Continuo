// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { fireEvent, render, cleanup, waitFor } from '@testing-library/react';
import {
  _resetLmApiForTest,
  captureLmApi,
} from '../../lib/co-api';
import { EmptyWorkspace } from '../../panels/Explorer/EmptyWorkspace';
import { useWorkspaceStore } from '../../stores/workspace.store';
import { useEditorStore } from '../../stores/editor.store';
import { notify } from '../../notifications/notify';
import { workspaceRootSelectionGuard } from '../../lib/workspace-root-guard';
import {
  __resetSelectDirectoryLockForTest,
  trySelectDirectoryLock,
} from '../../lib/select-directory-single-flight';

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
  __resetSelectDirectoryLockForTest(); // race(R106):模块级单飞闸门测试间复位
  useWorkspaceStore.setState({ root: null, recentRoots: [] });
  useEditorStore.setState({ tabs: [], activeTabId: null });
});

afterEach(() => {
  delete (window as { api?: unknown }).api;
  cleanup();
  vi.restoreAllMocks();
});

describe('EmptyWorkspace', () => {
  it('recentRoots 空 → 不渲染最近列表', () => {
    installFs(vi.fn());
    const { container } = render(<EmptyWorkspace />);
    expect(container.querySelector('ul')).toBeNull();
  });

  // a11y(A19):最近目录是常驻列表,非弹出菜单 → 用 ul/li + 普通 button(role=button),
  // 不暴露 role=menu/menuitem(否则 AT 误读成应用菜单 + menuitem 脱离 menu 父级非法)。
  it('recentRoots 非空 → ul 列表(非 menu)列出,点击 setRoot', async () => {
    installFs(vi.fn());
    useWorkspaceStore.setState({
      root: null,
      recentRoots: ['/Users/foo/projects/myapp'],
    });
    const { container } = render(<EmptyWorkspace />);
    // 正确语义:list,不是 menu
    expect(container.querySelector('[role=menu]')).toBeNull();
    expect(container.querySelector('[role=menuitem]')).toBeNull();
    const list = container.querySelector('ul');
    expect(list).not.toBeNull();
    expect(list!.getAttribute('aria-label')).toBeTruthy();
    expect(list!.textContent).toContain('myapp');

    // 行项是普通 button,点击 → listDir 校验通过后 setRoot(A147:现为 async)
    const item = list!.querySelector('li button') as HTMLButtonElement;
    expect(item).not.toBeNull();
    fireEvent.click(item);
    await waitFor(() =>
      expect(useWorkspaceStore.getState().root).toBe('/Users/foo/projects/myapp'),
    );
  });

  // a11y(A147):点已失效的 recent root(listDir !ok)→ notify.error 且不切 root。
  it('点 recent root 但 listDir {ok:false} → notify.error 不切 root', async () => {
    const errSpy = vi.spyOn(notify, 'error').mockImplementation(() => {});
    installFs(
      vi.fn(),
      vi.fn().mockResolvedValue({ ok: false, code: 'FS_NOT_FOUND', message: 'gone' }),
    );
    useWorkspaceStore.setState({ root: null, recentRoots: ['/stale/dir'] });
    const { container } = render(<EmptyWorkspace />);
    const item = container.querySelector('li button') as HTMLButtonElement;
    fireEvent.click(item);
    await waitFor(() => expect(errSpy).toHaveBeenCalledTimes(1));
    expect(useWorkspaceStore.getState().root).toBeNull();
  });

  // a11y(A80,A78 同族):空 workspace 最近目录按钮可见 basename 可截断/同名 → aria-label 含完整路径。
  it('a11y · 同 basename 的 recent 按钮 aria-label 含完整路径可区分', () => {
    installFs(vi.fn());
    useWorkspaceStore.setState({
      root: null,
      recentRoots: ['/a/work', '/b/work'],
    });
    const { container } = render(<EmptyWorkspace />);
    const labels = Array.from(
      container.querySelectorAll<HTMLButtonElement>('li button'),
    )
      .map((b) => b.getAttribute('aria-label') ?? '')
      .filter(Boolean);
    expect(labels.some((l) => l.includes('/a/work'))).toBe(true);
    expect(labels.some((l) => l.includes('/b/work'))).toBe(true);
  });

  // a11y(A96,A93 同族):打开目录选择器 loading 须 aria-busy + 视觉隐藏 role=status 播报「打开中」。
  it('a11y · 打开文件夹 loading → 按钮 aria-busy + role=status 播报打开中', async () => {
    const selectDirectory = vi.fn().mockReturnValue(new Promise(() => {})); // 永不 resolve
    installFs(selectDirectory);
    const { container } = render(<EmptyWorkspace />);
    const btn = Array.from(
      container.querySelectorAll<HTMLButtonElement>('button'),
    ).find((b) => b.textContent === '打开文件夹')!;
    fireEvent.click(btn);
    await waitFor(() => {
      const busy = Array.from(
        container.querySelectorAll<HTMLButtonElement>('button'),
      ).find((b) => b.getAttribute('aria-busy') === 'true');
      expect(busy).toBeDefined();
    });
    const statuses = Array.from(container.querySelectorAll('[role=status]'));
    expect(statuses.some((s) => (s.textContent ?? '').includes('打开中'))).toBe(true);
  });

  it('点「打开文件夹」+ ok+data → setRoot(data)', async () => {
    const selectDirectory = vi.fn().mockResolvedValue({
      ok: true,
      data: '/Users/foo/picked',
    });
    installFs(selectDirectory);
    const { container } = render(<EmptyWorkspace />);

    const btn = Array.from(
      container.querySelectorAll<HTMLButtonElement>('button'),
    ).find((b) => b.textContent === '打开文件夹')!;
    fireEvent.click(btn);
    await waitFor(() => {
      expect(useWorkspaceStore.getState().root).toBe('/Users/foo/picked');
    });
  });

  // race(R106,R8 同族):另一入口(ExplorerHeader 切换 / WindowPlugin 新窗口打开)正持有目录选择器
  // 单飞锁时,点本组件「打开文件夹」不得再发起 selectDirectory —— 全 app 同时只一个原生对话框。
  // (busy 是异步 state,无法挡同 tick / 跨入口并发;同步闸门才能挡 → 此测试验证 open() 接入闸门。)
  it('单飞锁被他处持有 → 点打开文件夹不发起 selectDirectory', () => {
    const selectDirectory = vi.fn().mockResolvedValue({ ok: true, data: '/x' });
    installFs(selectDirectory);
    expect(trySelectDirectoryLock()).toBe(true); // 模拟另一入口先持锁
    const { container } = render(<EmptyWorkspace />);
    const btn = Array.from(
      container.querySelectorAll<HTMLButtonElement>('button'),
    ).find((b) => b.textContent === '打开文件夹')!;
    fireEvent.click(btn);
    expect(selectDirectory).not.toHaveBeenCalled(); // 闸门挡下,不弹第二个对话框
  });

  it('ok=false → 不 setRoot', async () => {
    const selectDirectory = vi.fn().mockResolvedValue({
      ok: false,
      code: 'CANCELLED',
      message: 'user cancelled',
    });
    installFs(selectDirectory);
    const { container } = render(<EmptyWorkspace />);

    const btn = Array.from(
      container.querySelectorAll<HTMLButtonElement>('button'),
    ).find((b) => b.textContent === '打开文件夹')!;
    fireEvent.click(btn);
    await waitFor(() => expect(selectDirectory).toHaveBeenCalled());
    expect(useWorkspaceStore.getState().root).toBeNull();
  });

  // a11y(A146,A141 同族):打开文件夹 !r.ok / reject 须 notify.error;取消(ok+null)不报。
  it('打开文件夹 {ok:false} → notify.error', async () => {
    const errSpy = vi.spyOn(notify, 'error').mockImplementation(() => {});
    installFs(vi.fn().mockResolvedValue({ ok: false, code: 'EACCES', message: 'no perm' }));
    const { container } = render(<EmptyWorkspace />);
    const btn = Array.from(
      container.querySelectorAll<HTMLButtonElement>('button'),
    ).find((b) => b.textContent === '打开文件夹')!;
    fireEvent.click(btn);
    await waitFor(() => expect(errSpy).toHaveBeenCalledTimes(1));
  });

  it('打开文件夹 reject → notify.error(不抛)', async () => {
    const errSpy = vi.spyOn(notify, 'error').mockImplementation(() => {});
    installFs(vi.fn().mockRejectedValue(new Error('ipc down')));
    const { container } = render(<EmptyWorkspace />);
    const btn = Array.from(
      container.querySelectorAll<HTMLButtonElement>('button'),
    ).find((b) => b.textContent === '打开文件夹')!;
    fireEvent.click(btn);
    await waitFor(() => expect(errSpy).toHaveBeenCalledTimes(1));
  });

  it('打开文件夹 取消(ok + null)→ 不 notify', async () => {
    const errSpy = vi.spyOn(notify, 'error').mockImplementation(() => {});
    installFs(vi.fn().mockResolvedValue({ ok: true, data: null }));
    const { container } = render(<EmptyWorkspace />);
    const btn = Array.from(
      container.querySelectorAll<HTMLButtonElement>('button'),
    ).find((b) => b.textContent === '打开文件夹')!;
    fireEvent.click(btn);
    await new Promise((r) => setTimeout(r, 0));
    expect(errSpy).not.toHaveBeenCalled();
    expect(useWorkspaceStore.getState().root).toBeNull();
  });

  // race(R27):打开文件夹的对话框结果落地前,别的 root 选择入口(drop / 打开最近 / 切换)发起
  // 新选择 → 本次过期,不得 setRoot(共享守卫)。否则迟到的对话框结果会覆盖更新的选择。
  it('R27 打开文件夹结果落地前另一入口接管 → 不 setRoot(共享守卫作废过期结果)', async () => {
    let release: (v: unknown) => void = () => {};
    const selectDirectory = vi.fn(
      () => new Promise((resolve) => {
        release = resolve;
      }),
    );
    installFs(selectDirectory);
    const { container } = render(<EmptyWorkspace />);
    const btn = Array.from(
      container.querySelectorAll<HTMLButtonElement>('button'),
    ).find((b) => b.textContent === '打开文件夹')!;
    fireEvent.click(btn);
    await waitFor(() => expect(selectDirectory).toHaveBeenCalled());
    // 模拟另一个 root 选择入口接管(drop / 打开最近)→ 共享守卫 begin()。
    workspaceRootSelectionGuard.begin();
    release({ ok: true, data: '/late/picked' });
    await new Promise((r) => setTimeout(r, 0));
    expect(useWorkspaceStore.getState().root).toBeNull(); // 过期结果未落地
  });

  it('busy 期间按钮 disabled + 文案「打开中…」', async () => {
    let release: (v: unknown) => void = () => {};
    const selectDirectory = vi.fn(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    installFs(selectDirectory);
    const { container } = render(<EmptyWorkspace />);
    const btn = Array.from(
      container.querySelectorAll<HTMLButtonElement>('button'),
    ).find((b) => b.textContent === '打开文件夹')!;
    fireEvent.click(btn);
    await waitFor(() => {
      const updated = Array.from(
        container.querySelectorAll<HTMLButtonElement>('button'),
      ).find((b) => b.textContent === '打开中…');
      expect(updated).toBeDefined();
      expect(updated!.disabled).toBe(true);
    });
    release({ ok: false });
  });
});
