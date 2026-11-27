// @vitest-environment jsdom
// 文件树列表为空时区分三态(VSCode Explorer:加载中显示进度、空文件夹显示空态、读取失败显示原因):
//   - 根目录还在读取 → 「加载中」
//   - 读取成功但没有可显示的项 → 「此文件夹为空」
//   - 读取失败 → 本地化的失败原因 + 「重试」按钮(调与 Header 刷新同一实现);重试成功后列出文件
//   - 根目录读取失败只走内联提示(不再另弹 toast,读屏不重复播报);子目录读取失败仍 toast
//   - 点「重试」后焦点不掉到 body:成功 → 树内焦点行;仍失败 → 新的「重试」按钮
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import type { FileEntry } from '../../lib/fs/types';
import { useExplorerStore } from '../../stores/explorer.store';

const h = vi.hoisted(() => ({
  // 根目录 listDir 的结果由用例控制(pending / 成功 / 失败);null = 用 fsTree
  rootListDir: null as null | (() => Promise<unknown>),
  openFileByPath: null as null | ((p: string) => Promise<{ ok: true }>),
  editorFile: null as null | { openFileByPath: (p: string) => Promise<{ ok: true }> },
  settings: {} as Record<string, unknown>,
  // 读取失败的目录(EACCES 等,main 已映射为 FS_DENIED)
  failDirs: new Set<string>(),
}));

const entries: FileEntry[] = [
  { path: '/work/alpha', name: 'alpha', isDirectory: true },
  { path: '/work/beta.ts', name: 'beta.ts', isDirectory: false },
  { path: '/work/bravo.ts', name: 'bravo.ts', isDirectory: false },
  { path: '/work/charlie.ts', name: 'charlie.ts', isDirectory: false },
];
const fsTree = new Map<string, FileEntry[]>([
  ['/work', entries],
  ['/work/alpha', [{ path: '/work/alpha/inner.ts', name: 'inner.ts', isDirectory: false }]],
]);

vi.mock('@/lib/co-api', () => ({
  coApi: {
    fs: {
      listDir: vi.fn(async (p: string) =>
        h.failDirs.has(p)
          ? { ok: false, code: 'FS_DENIED', message: `EACCES: permission denied, opendir '${p}'` }
          : p === '/work' && h.rootListDir
            ? h.rootListDir()
            : { ok: true, data: fsTree.get(p) ?? [] },
      ),
      move: vi.fn(async (_s: string, d: string) => ({ ok: true, data: d })),
      copy: vi.fn(async (_s: string, d: string) => ({ ok: true, data: d })),
      trash: vi.fn(async () => ({ ok: true, data: undefined })),
      reveal: vi.fn(),
      watchDir: vi.fn(async () => ({ ok: true })),
      unwatchDir: vi.fn(async () => ({ ok: true })),
      onDirChanged: vi.fn(() => vi.fn()),
      onWatchLost: vi.fn(() => vi.fn()),
      onRootPresenceChanged: vi.fn(() => vi.fn()),
    },
    terminal: { create: vi.fn() },
  },
}));
vi.mock('@tanstack/react-virtual', () => ({
  useVirtualizer: (opts: { count: number }) => ({
    getTotalSize: () => opts.count * 28,
    getVirtualItems: () =>
      Array.from({ length: opts.count }, (_, i) => ({ index: i, start: i * 28, size: 28, key: i })),
    scrollToIndex: () => {},
  }),
}));
vi.mock('@/panels/Editor/useEditorFile', () => ({
  useEditorFile: () => h.editorFile,
}));
vi.mock('@/plugins/settings/values-store', () => ({
  useSettingValue: (key: string, fallback: unknown) => (key in h.settings ? h.settings[key] : fallback),
}));
vi.mock('@/theme', () => ({ useTheme: () => ({ resolved: 'dark' }) }));
vi.mock('../../panels/Explorer/ExplorerHeader', () => ({ ExplorerHeader: () => null }));

import { coApi } from '@/lib/co-api';
import { notify } from '@/notifications/notify';
import { FolderTree } from '../../panels/Explorer/FolderTree';
import { __resetExplorerRequestsForTest, requestExplorer } from '../../panels/Explorer/explorer-requests';
import { useExplorerClipboardStore } from '../../panels/Explorer/clipboard-store';

const row = (container: HTMLElement, p: string) =>
  container.querySelector(`[title="${p}"]`) as HTMLElement | null;

let originalPlatform: PropertyDescriptor | undefined;
function setPlatform(p: string): void {
  Object.defineProperty(window.navigator, 'platform', { value: p, configurable: true });
}

beforeEach(() => {
  originalPlatform = Object.getOwnPropertyDescriptor(window.navigator, 'platform');
  setPlatform('Win32');
  h.openFileByPath = vi.fn(async () => ({ ok: true as const }));
  h.editorFile = { openFileByPath: h.openFileByPath };
  vi.mocked(coApi.fs.listDir).mockClear();
  h.rootListDir = null;
  h.settings = {};
  h.failDirs = new Set();
  vi.mocked(coApi.fs.copy).mockClear();
  vi.spyOn(notify, 'error').mockImplementation(() => '');
  useExplorerStore.setState({ expandedPaths: new Set(), sort: { by: 'name', reverse: false } });
  useExplorerClipboardStore.setState({ kind: null, paths: [] });
  __resetExplorerRequestsForTest();
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  if (originalPlatform) Object.defineProperty(window.navigator, 'platform', originalPlatform);
  else delete (window.navigator as { platform?: string }).platform;
});

const LOADING = /^(加载中|Loading)$/;
const EMPTY = /^(此文件夹为空|This folder is empty)$/;
const RETRY = /^(重试|Retry)$/;

describe('FolderTree · 空列表三态', () => {
  it('根目录读取中 → 显示「加载中」,不显示空目录', async () => {
    h.rootListDir = () => new Promise(() => {});
    const r = render(<FolderTree root="/work" />);
    expect(await r.findByText(LOADING)).toBeTruthy();
    expect(r.queryByText(EMPTY)).toBeNull();
    expect(r.queryByRole('alert')).toBeNull();
  });

  it('读取成功且为空 → 显示「此文件夹为空」', async () => {
    h.rootListDir = async () => ({ ok: true, data: [] });
    const r = render(<FolderTree root="/work" />);
    expect(await r.findByText(EMPTY)).toBeTruthy();
    expect(r.queryByText(LOADING)).toBeNull();
    expect(r.queryByRole('alert')).toBeNull();
  });

  it('读取失败 → 显示本地化原因与「重试」;重试成功后列出文件', async () => {
    h.rootListDir = async () => ({ ok: false, code: 'FS_DENIED', message: 'EACCES: permission denied' });
    const r = render(<FolderTree root="/work" />);
    const alert = await r.findByRole('alert');
    expect(alert.textContent).toMatch(/拒绝访问|Access denied/);
    expect(r.queryByText(EMPTY)).toBeNull();
    const calls = vi.mocked(coApi.fs.listDir).mock.calls.filter((c) => c[0] === '/work').length;
    h.rootListDir = null;
    act(() => {
      fireEvent.click(r.getByRole('button', { name: RETRY }));
    });
    await waitFor(() => expect(row(r.container, '/work/beta.ts')).not.toBeNull());
    expect(vi.mocked(coApi.fs.listDir).mock.calls.filter((c) => c[0] === '/work').length).toBeGreaterThan(calls);
    expect(r.queryByRole('alert')).toBeNull();
  });
});

describe('FolderTree · 读取失败反馈', () => {
  it('根目录读取失败 → 只有一处 role=alert 的内联提示,不另弹 toast', async () => {
    h.rootListDir = async () => ({ ok: false, code: 'FS_DENIED', message: 'EACCES: permission denied' });
    const r = render(<FolderTree root="/work" />);
    await r.findByRole('alert');
    await new Promise((res) => setTimeout(res, 20));
    expect(r.getAllByRole('alert')).toHaveLength(1);
    expect(notify.error).not.toHaveBeenCalled();
  });

  it('子目录读取失败 → 该目录下内联错误行(本地化原因 + 重试),不弹 toast', async () => {
    const r = render(<FolderTree root="/work" />);
    await waitFor(() => expect(row(r.container, '/work/alpha')).not.toBeNull());
    h.failDirs.add('/work/alpha');
    act(() => {
      fireEvent.click(row(r.container, '/work/alpha')!);
    });
    const message = await r.findByText(/^(无法读取此文件夹|Unable to read this folder)/);
    expect(message.textContent).toMatch(/拒绝访问|Access denied/);
    expect(message.textContent).not.toMatch(/EACCES|listDir|\/work/);
    // 错误行紧跟在失败目录之后
    const tree = r.container.querySelector('[role="tree"]')!;
    expect(tree.contains(message)).toBe(true);
    await new Promise((res) => setTimeout(res, 20));
    expect(notify.error).not.toHaveBeenCalled();
  });

  it('子目录错误行「重试」成功 → 列出子项、错误行消失,焦点回到该目录行', async () => {
    const r = render(<FolderTree root="/work" />);
    await waitFor(() => expect(row(r.container, '/work/alpha')).not.toBeNull());
    h.failDirs.add('/work/alpha');
    act(() => {
      fireEvent.click(row(r.container, '/work/alpha')!);
    });
    await r.findByRole('button', { name: RETRY });
    h.failDirs.delete('/work/alpha');
    const retry = r.getByRole('button', { name: RETRY });
    retry.focus();
    act(() => {
      fireEvent.click(retry);
    });
    await waitFor(() => expect(row(r.container, '/work/alpha/inner.ts')).not.toBeNull());
    expect(r.queryByRole('button', { name: RETRY })).toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(row(r.container, '/work/alpha')));
  });
});

// 错误行里的「重试」是树里的普通按钮(不是 treeitem):树的键盘命令(Enter 切换展开 / Delete 删除 / F2 改名 /
// 方向键收起展开 / ⌘C 复制 …)只作用于来自行本身的按键,焦点在「重试」上时一概不动失败目录;按钮自身的
// Enter / 空格激活(浏览器默认动作)照常执行重试。
describe('FolderTree · 错误行「重试」上的按键', () => {
  async function renderFailedAlpha() {
    const r = render(<FolderTree root="/work" />);
    await waitFor(() => expect(row(r.container, '/work/alpha')).not.toBeNull());
    h.failDirs.add('/work/alpha');
    act(() => {
      fireEvent.click(row(r.container, '/work/alpha')!);
    });
    const retry = await r.findByRole('button', { name: RETRY });
    retry.focus();
    return { r, retry };
  }
  const press = (el: HTMLElement, init: KeyboardEventInit) => {
    act(() => {
      fireEvent.keyDown(el, init);
      fireEvent.keyUp(el, init);
    });
  };

  it('Enter / ← / → / F2 → 失败目录不收起、不改名,错误行与焦点留在「重试」', async () => {
    const { r, retry } = await renderFailedAlpha();
    for (const init of [
      { key: 'Enter', code: 'Enter' },
      { key: 'ArrowLeft', code: 'ArrowLeft' },
      { key: 'ArrowRight', code: 'ArrowRight' },
      { key: 'F2', code: 'F2' },
    ]) {
      press(retry, init);
    }
    await new Promise((res) => setTimeout(res, 20));
    expect(row(r.container, '/work/alpha')!.getAttribute('aria-expanded')).toBe('true');
    expect(r.getByRole('button', { name: RETRY })).toBe(retry);
    expect(document.activeElement).toBe(retry);
    expect(r.container.querySelector('input')).toBeNull();
  });

  it('Delete / Ctrl+C → 不对失败目录发起删除 / 复制', async () => {
    const { r, retry } = await renderFailedAlpha();
    press(retry, { key: 'Delete', code: 'Delete' });
    press(retry, { key: 'c', code: 'KeyC', ctrlKey: true });
    await new Promise((res) => setTimeout(res, 20));
    expect(coApi.fs.trash).not.toHaveBeenCalled();
    expect(r.queryByRole('alertdialog')).toBeNull();
    expect(r.queryByRole('dialog')).toBeNull();
    expect(useExplorerClipboardStore.getState().paths).toEqual([]);
  });

  it('只截树用到的键:F5 / 单字母等其它无修饰键照常冒泡到全局热键(用户自绑的单键命令仍生效)', async () => {
    const { retry } = await renderFailedAlpha();
    const reached: string[] = [];
    const onDoc = (e: KeyboardEvent) => reached.push(e.key);
    document.addEventListener('keydown', onDoc);
    try {
      for (const key of ['F5', 'q', 'Escape', 'Enter', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End', 'F2', 'Delete', ' ']) {
        press(retry, { key });
      }
      press(retry, { key: 'ArrowDown', shiftKey: true }); // Shift+↓ 扩选同样是树的键
    } finally {
      document.removeEventListener('keydown', onDoc);
    }
    expect(reached).toEqual(['F5', 'q', 'Escape']);
  });

  // 高负载下错误行提交后、其 passive effect 执行前就可能按到键(真机主线程繁忙同理):用 MutationObserver 在提交后的
  // 微任务里聚焦「重试」并按键。截键监听须在提交时就已挂上,否则这些键漏到树容器,把失败目录收起。
  it('错误行刚提交(effect 尚未执行)就在「重试」上按 Enter / ← → 失败目录仍不收起', async () => {
    const r = render(<FolderTree root="/work" />);
    await waitFor(() => expect(row(r.container, '/work/alpha')).not.toBeNull());
    h.failDirs.add('/work/alpha');
    const retry = new Promise<HTMLElement>((resolve) => {
      const mo = new MutationObserver(() => {
        const el = r.queryByRole('button', { name: RETRY });
        if (el) {
          mo.disconnect();
          resolve(el);
        }
      });
      mo.observe(r.container, { childList: true, subtree: true });
    });
    act(() => {
      fireEvent.click(row(r.container, '/work/alpha')!);
    });
    const el = await retry;
    el.focus();
    for (const key of ['Enter', 'ArrowLeft']) {
      fireEvent.keyDown(el, { key, code: key });
      fireEvent.keyUp(el, { key, code: key });
    }
    await new Promise((res) => setTimeout(res, 20));
    expect(row(r.container, '/work/alpha')!.getAttribute('aria-expanded')).toBe('true');
  });

  it('「重试」按钮激活(Enter 的默认动作 = click)→ 重新读取该目录', async () => {
    const { r, retry } = await renderFailedAlpha();
    h.failDirs.delete('/work/alpha');
    act(() => {
      fireEvent.click(retry);
    });
    await waitFor(() => expect(row(r.container, '/work/alpha/inner.ts')).not.toBeNull());
  });
});

// 读屏:子目录读取失败在记入失败表时经常驻的 live region 播报一次(带目录名);虚拟列表里的错误行只放普通文本 ——
// 错误行随滚动出入 overscan、收起再展开而重新挂载时不再重播。
describe('FolderTree · 子目录读取失败的播报', () => {
  it('失败时播报一次(带目录名与原因);错误行本身不是 live region;收起再展开不重播', async () => {
    const r = render(<FolderTree root="/work" />);
    await waitFor(() => expect(row(r.container, '/work/alpha')).not.toBeNull());
    h.failDirs.add('/work/alpha');
    act(() => {
      fireEvent.click(row(r.container, '/work/alpha')!);
    });
    await r.findByRole('button', { name: RETRY });
    // 经全局常驻播报区(src/lib/announce):不在 FolderTree 自己维护第二套 live region
    expect(r.container.querySelector('[aria-live]')).toBeNull();
    const liveOf = () => document.querySelector('[data-live-announcer] [aria-live="assertive"]') as HTMLElement | null;
    await waitFor(() => expect(liveOf()?.textContent).toMatch(/alpha/));
    const live = liveOf()!;
    expect(live.textContent).toMatch(/拒绝访问|Access denied/);
    const announcedCount = live.childElementCount;
    // 错误行里没有 role=alert / aria-live
    const message = r.getByText(/^(无法读取此文件夹|Unable to read this folder)/);
    expect(message.closest('[role="alert"],[aria-live]')).toBeNull();
    // 收起再展开:错误行重新挂载,播报区内容不变(不重播)
    act(() => {
      fireEvent.click(row(r.container, '/work/alpha')!);
    });
    await waitFor(() => expect(r.queryByRole('button', { name: RETRY })).toBeNull());
    act(() => {
      fireEvent.click(row(r.container, '/work/alpha')!);
    });
    await r.findByRole('button', { name: RETRY });
    await new Promise((res) => setTimeout(res, 150));
    expect(live.childElementCount).toBe(announcedCount);
  });

  it('已折叠目录在后台刷新时读取失败 → toast 按错误码本地化并带目录名,不含原始诊断串', async () => {
    const r = render(<FolderTree root="/work" />);
    await waitFor(() => expect(row(r.container, '/work/alpha')).not.toBeNull());
    act(() => {
      fireEvent.click(row(r.container, '/work/alpha')!);
    });
    await waitFor(() => expect(row(r.container, '/work/alpha/inner.ts')).not.toBeNull());
    act(() => {
      fireEvent.click(row(r.container, '/work/alpha')!);
    });
    await waitFor(() => expect(row(r.container, '/work/alpha/inner.ts')).toBeNull());
    h.failDirs.add('/work/alpha');
    // 切换「显示隐藏文件」刷新全部已加载目录(含已折叠的 alpha)
    h.settings = { 'explorer.showHiddenFiles': false }; // 从默认开切到关
    r.rerender(<FolderTree root="/work" />);
    await waitFor(() => expect(notify.error).toHaveBeenCalled());
    const text = vi.mocked(notify.error).mock.calls[0]![0];
    expect(text).toMatch(/alpha/);
    expect(text).toMatch(/拒绝访问|Access denied/);
    expect(text).not.toMatch(/EACCES|listDir|\/work\/alpha/);
  });
});

describe('FolderTree · 重试后的焦点', () => {
  it('重试成功 → 焦点移到树内焦点行(不掉到 body)', async () => {
    h.rootListDir = async () => ({ ok: false, code: 'FS_DENIED', message: 'denied' });
    const r = render(<FolderTree root="/work" />);
    const retry = await r.findByRole('button', { name: RETRY });
    retry.focus();
    h.rootListDir = null;
    act(() => {
      fireEvent.click(retry);
    });
    await waitFor(() => expect(row(r.container, '/work/alpha')).not.toBeNull());
    await waitFor(() => {
      const active = document.activeElement as HTMLElement | null;
      expect(active?.closest('[role="tree"]')).not.toBeNull();
    });
  });

  it('重试成功但根目录为空 → 焦点落到空态提示;之后根目录出现文件也不把焦点从别处拉回树', async () => {
    h.rootListDir = async () => ({ ok: false, code: 'FS_DENIED', message: 'denied' });
    const r = render(<FolderTree root="/work" />);
    const retry = await r.findByRole('button', { name: RETRY });
    retry.focus();
    h.rootListDir = async () => ({ ok: true, data: [] });
    act(() => {
      fireEvent.click(retry);
    });
    const empty = await r.findByText(EMPTY);
    await waitFor(() => expect(document.activeElement).toBe(empty));
    // 用户把焦点移到别处(编辑器 / 终端)
    const outside = document.createElement('input');
    document.body.appendChild(outside);
    outside.focus();
    // 根目录随后出现文件(刷新全部已加载目录)
    h.rootListDir = null;
    h.settings = { 'explorer.showHiddenFiles': false }; // 从默认开切到关
    r.rerender(<FolderTree root="/work" />);
    await waitFor(() => expect(row(r.container, '/work/beta.ts')).not.toBeNull());
    await new Promise((res) => setTimeout(res, 30));
    expect(document.activeElement).toBe(outside);
    outside.remove();
  });

  // 「重试」按钮刚提交到 DOM、显示它的那次渲染的 effect 还没执行时就点下(手快 / 主线程繁忙):不在 act 里等渲染,
  // 用 MutationObserver 在提交后的微任务里点。旧 effect 闭包里的 rootLoad 还是上次的失败结果,不能据此把焦点落到
  // 即将卸载的旧按钮并清掉落点请求。
  async function clickRetryRightAfterCommit(
    r: ReturnType<typeof render>,
    nextRootListDir: typeof h.rootListDir,
  ): Promise<void> {
    const retry = await new Promise<HTMLElement>((resolve) => {
      const find = () => r.queryByRole('button', { name: RETRY });
      const mo = new MutationObserver(() => {
        const el = find();
        if (el) {
          mo.disconnect();
          resolve(el);
        }
      });
      mo.observe(r.container, { childList: true, subtree: true });
    });
    h.rootListDir = nextRootListDir;
    retry.focus();
    fireEvent.click(retry);
  }

  it('点得比上次渲染的 effect 早 → 重试成功仍把焦点移到树内焦点行', async () => {
    h.rootListDir = async () => ({ ok: false, code: 'FS_DENIED', message: 'denied' });
    const r = render(<FolderTree root="/work" />);
    await clickRetryRightAfterCommit(r, null);
    await waitFor(() => expect(row(r.container, '/work/alpha')).not.toBeNull());
    await waitFor(() => {
      const active = document.activeElement as HTMLElement | null;
      expect(active?.closest('[role="tree"]')).not.toBeNull();
    });
  });

  it('点得比上次渲染的 effect 早 → 重试成功但为空仍把焦点落到空态提示', async () => {
    h.rootListDir = async () => ({ ok: false, code: 'FS_DENIED', message: 'denied' });
    const r = render(<FolderTree root="/work" />);
    await clickRetryRightAfterCommit(r, async () => ({ ok: true, data: [] }));
    const empty = await r.findByText(EMPTY);
    await waitFor(() => expect(document.activeElement).toBe(empty));
  });

  it('点得比上次渲染的 effect 早 → 重试仍失败仍把焦点落在新的「重试」按钮', async () => {
    h.rootListDir = async () => ({ ok: false, code: 'FS_DENIED', message: 'denied' });
    const r = render(<FolderTree root="/work" />);
    await clickRetryRightAfterCommit(r, h.rootListDir);
    await waitFor(() => {
      const again = r.getByRole('button', { name: RETRY });
      expect(document.activeElement).toBe(again);
    });
  });

  // 空根目录已加载(rootLoad 已是 loaded)后整目录重新读取:读取期间来了 focusTree 请求,读取完成时 rootLoad 不变、
  // 列表仍为空 —— 焦点仍须在根目录子项写入缓存后落到空态提示(不永远挂起,也不留着标记日后把焦点拉回树)。
  it('空根目录重新读取期间请求焦点进树 → 读取完成后焦点落到空态提示', async () => {
    h.rootListDir = async () => ({ ok: true, data: [] });
    const r = render(<FolderTree root="/work" />);
    await r.findByText(EMPTY);
    let finishReload: (v: unknown) => void = () => {};
    const reload = new Promise((res) => {
      finishReload = res;
    });
    // 切换「显示隐藏文件」刷新根目录:刷新路径自己的 listDir 失败 → 走 invalidate 经 loader 重读(挂起)
    let call = 0;
    h.rootListDir = async () =>
      ++call === 1 ? { ok: false, code: 'FS_DENIED', message: 'denied' } : reload;
    h.settings = { 'explorer.showHiddenFiles': false }; // 从默认开切到关
    r.rerender(<FolderTree root="/work" />);
    await waitFor(() => expect(call).toBe(2));
    act(() => {
      requestExplorer({ kind: 'focusTree', root: '/work' });
    });
    await new Promise((res) => setTimeout(res, 20));
    await act(async () => {
      finishReload({ ok: true, data: [] });
    });
    await waitFor(() => expect(document.activeElement).toBe(r.getByText(EMPTY)));
  });

  // focusWithinOrLost:请求之后、树加载完之前用户把焦点移到别处(如切换文件夹后立刻打开「更多操作」菜单)→ 不抢;
  // 请求时的焦点元素仍在焦点上 / 焦点已丢失(触发按钮随 root 变化卸载)→ 照常交给树。
  it('请求焦点进树后、读取完成前焦点被移到别处 → 读取完成后不抢焦点', async () => {
    h.rootListDir = async () => ({ ok: true, data: [] });
    const r = render(<FolderTree root="/work" />);
    await r.findByText(EMPTY);
    let finishReload: (v: unknown) => void = () => {};
    const reload = new Promise((res) => {
      finishReload = res;
    });
    let call = 0;
    h.rootListDir = async () =>
      ++call === 1 ? { ok: false, code: 'FS_DENIED', message: 'denied' } : reload;
    h.settings = { 'explorer.showHiddenFiles': false }; // 从默认开切到关
    r.rerender(<FolderTree root="/work" />);
    await waitFor(() => expect(call).toBe(2));
    const origin = document.createElement('button');
    const elsewhere = document.createElement('button');
    document.body.append(origin, elsewhere);
    origin.focus();
    act(() => {
      requestExplorer({ kind: 'focusTree', root: '/work' });
    });
    elsewhere.focus();
    await act(async () => {
      finishReload({ ok: true, data: [] });
    });
    await new Promise((res) => setTimeout(res, 20));
    expect(document.activeElement).toBe(elsewhere);
    origin.remove();
    elsewhere.remove();
  });

  // 切换文件夹后新 root 的树稍后才挂载(请求先挂起):期间用户把焦点移到别处(如立刻打开「更多操作」菜单)→ 挂载、加载
  // 完成后不抢。焦点起点按发请求时记,不按树挂载时记。
  it('请求先挂起、树挂载前焦点被移到别处 → 挂载并加载完成后不抢焦点', async () => {
    h.rootListDir = async () => ({ ok: true, data: [] });
    const origin = document.createElement('button');
    const elsewhere = document.createElement('button');
    document.body.append(origin, elsewhere);
    origin.focus();
    requestExplorer({ kind: 'focusTree', root: '/work' });
    elsewhere.focus();
    const r = render(<FolderTree root="/work" />);
    await r.findByText(EMPTY);
    await new Promise((res) => setTimeout(res, 20));
    expect(document.activeElement).toBe(elsewhere);
    origin.remove();
    elsewhere.remove();
  });

  it('请求先挂起、发请求时的焦点元素随后卸载(焦点丢失)→ 树挂载并加载完成后焦点进树', async () => {
    h.rootListDir = async () => ({ ok: true, data: [] });
    const origin = document.createElement('button');
    document.body.append(origin);
    origin.focus();
    requestExplorer({ kind: 'focusTree', root: '/work' });
    origin.remove();
    const r = render(<FolderTree root="/work" />);
    await waitFor(() => expect(document.activeElement).toBe(r.getByText(EMPTY)));
  });

  it('重试仍失败 → 焦点落在新的「重试」按钮', async () => {
    h.rootListDir = async () => ({ ok: false, code: 'FS_DENIED', message: 'denied' });
    const r = render(<FolderTree root="/work" />);
    const retry = await r.findByRole('button', { name: RETRY });
    retry.focus();
    act(() => {
      fireEvent.click(retry);
    });
    await waitFor(() => {
      const again = r.getByRole('button', { name: RETRY });
      expect(document.activeElement).toBe(again);
    });
  });
});
