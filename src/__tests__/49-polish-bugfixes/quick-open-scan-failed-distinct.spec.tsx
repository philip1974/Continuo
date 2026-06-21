// @vitest-environment jsdom
// 第二十一轮 P1-AY:Quick Open 的 walk 扫描失败必须与"空 workspace"区分 + 给重试入口,
// 不让失败静默伪装成空列表把用户引向死胡同。P1-AX:打开文件失败弹 error toast(modal 已关)。
// 见 README "第二十一轮"。被测:src/plugins/quick-open/QuickOpenModal.tsx。

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, cleanup, waitFor, fireEvent } from '@testing-library/react';

vi.mock('../../plugins/quick-open/walk-files', () => ({
  walkWorkspaceFiles: vi.fn(),
}));

// 虚拟化(打磨 R25):jsdom 无布局,mock 成渲染全部 index 让列表断言有效。
vi.mock('@tanstack/react-virtual', () => ({
  useVirtualizer: ({ count }: { count: number }) => ({
    getTotalSize: () => count * 28,
    getVirtualItems: () =>
      Array.from({ length: count }, (_, i) => ({
        index: i,
        start: i * 28,
        size: 28,
        key: i,
      })),
    scrollToIndex: vi.fn(),
  }),
}));

const notifyError = vi.fn();
vi.mock('../../notifications/notify', () => ({
  notify: { error: (...a: unknown[]) => notifyError(...a) },
}));

import { _resetLmApiForTest, captureLmApi } from '../../lib/co-api';
import { QuickOpenModal } from '../../plugins/quick-open/QuickOpenModal';
import {
  useQuickOpenStore,
  type QuickOpenFile,
} from '../../plugins/quick-open/store';
import { useWorkspaceStore } from '../../stores/workspace.store';
import { useEditorStore } from '../../stores/editor.store';
import { walkWorkspaceFiles } from '../../plugins/quick-open/walk-files';

const walkMock = walkWorkspaceFiles as unknown as ReturnType<typeof vi.fn>;

function file(name: string, relPath?: string): QuickOpenFile {
  return { name, relPath: relPath ?? name, absPath: `/proj/${relPath ?? name}` };
}

function installFs(over: Record<string, unknown> = {}): void {
  Object.defineProperty(window, 'api', {
    value: {
      fs: {
        listDir: vi.fn().mockResolvedValue({ ok: true, data: [] }),
        readFile: vi.fn().mockResolvedValue({ ok: true, data: 'content' }),
        writeFile: vi.fn().mockResolvedValue({ ok: true, data: undefined }),
        ...over,
      },
    },
    writable: true,
    configurable: true,
  });
  captureLmApi();
}

beforeEach(() => {
  _resetLmApiForTest();
  useQuickOpenStore.setState({
    isOpen: false,
    query: '',
    selectedIndex: 0,
    results: [],
    loading: false,
    scanFailed: false,
  });
  useWorkspaceStore.setState({ root: null, recentRoots: [] });
  useEditorStore.setState({ tabs: [], activeTabId: null });
  walkMock.mockReset();
  notifyError.mockReset();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  delete (window as { api?: unknown }).api;
  cleanup();
  vi.restoreAllMocks();
});

describe('QuickOpen 扫描失败 ≠ 空 workspace', () => {
  it('walk ok=false → 显示「扫描失败」+ 重试,而非「工作区无文件」', async () => {
    installFs();
    walkMock.mockResolvedValue({ ok: false, code: 'EACCES', message: 'denied' });
    useWorkspaceStore.setState({ root: '/proj', recentRoots: [] });
    useQuickOpenStore.setState({ isOpen: true });
    render(<QuickOpenModal />);
    await waitFor(() => {
      const txt = document.querySelector('.wm-modal-content')!.textContent ?? '';
      expect(txt).toContain('扫描工作区文件失败');
    });
    const txt = document.querySelector('.wm-modal-content')!.textContent ?? '';
    expect(txt).not.toContain('工作区无文件');
    expect(useQuickOpenStore.getState().scanFailed).toBe(true);
  });

  it('walk 抛异常 → 同样置 scanFailed(不挂死)', async () => {
    installFs();
    walkMock.mockRejectedValue(new Error('walk crashed'));
    useWorkspaceStore.setState({ root: '/proj', recentRoots: [] });
    useQuickOpenStore.setState({ isOpen: true });
    render(<QuickOpenModal />);
    await waitFor(() => {
      expect(useQuickOpenStore.getState().loading).toBe(false);
    });
    expect(useQuickOpenStore.getState().scanFailed).toBe(true);
  });

  it('点「重试」→ 重新调用 walk;恢复成功后显示结果且清 scanFailed', async () => {
    installFs();
    walkMock.mockResolvedValueOnce({ ok: false, code: 'EACCES', message: 'x' });
    useWorkspaceStore.setState({ root: '/proj', recentRoots: [] });
    useQuickOpenStore.setState({ isOpen: true });
    render(<QuickOpenModal />);
    await waitFor(() => {
      expect(
        document.querySelector('.wm-modal-content')!.textContent,
      ).toContain('扫描工作区文件失败');
    });
    expect(walkMock).toHaveBeenCalledTimes(1);

    // 下一次 walk 成功
    walkMock.mockResolvedValueOnce({ ok: true, data: [file('a.ts', 'src/a.ts')] });
    const retryBtn = Array.from(
      document.querySelectorAll('.wm-modal-content button'),
    ).find((b) => (b.textContent ?? '').includes('重试'))!;
    fireEvent.click(retryBtn);

    await waitFor(() => {
      expect(walkMock).toHaveBeenCalledTimes(2);
      expect(useQuickOpenStore.getState().scanFailed).toBe(false);
      expect(document.querySelectorAll('ul li').length).toBeGreaterThanOrEqual(1);
    });
  });

  it('空 workspace(walk ok=true, data=[])→ scanFailed 仍为 false,显示「工作区无文件」', async () => {
    installFs();
    walkMock.mockResolvedValue({ ok: true, data: [] });
    useWorkspaceStore.setState({ root: '/proj', recentRoots: [] });
    useQuickOpenStore.setState({ isOpen: true });
    render(<QuickOpenModal />);
    await waitFor(() => {
      expect(
        document.querySelector('.wm-modal-content')!.textContent,
      ).toContain('工作区无文件');
    });
    expect(useQuickOpenStore.getState().scanFailed).toBe(false);
  });
});

describe('QuickOpen 打开文件失败弹 toast', () => {
  it('openFileByPath 返回 !ok → notify.error(含文件名)', async () => {
    installFs({
      readFile: vi.fn().mockResolvedValue({ ok: false, code: 'ENOENT', message: 'gone' }),
    });
    walkMock.mockResolvedValue({ ok: true, data: [file('a.ts', 'src/a.ts')] });
    useWorkspaceStore.setState({ root: '/proj', recentRoots: [] });
    useQuickOpenStore.setState({ isOpen: true, selectedIndex: 0 });
    render(<QuickOpenModal />);
    await waitFor(() => {
      expect(document.querySelectorAll('ul li').length).toBeGreaterThan(0);
    });
    const input = document.querySelector(
      '.wm-modal-content input',
    ) as HTMLInputElement;
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => {
      expect(notifyError).toHaveBeenCalled();
    });
    expect(String(notifyError.mock.calls[0]?.[0])).toContain('a.ts');
  });
});
