// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { fireEvent, render, cleanup, act, waitFor } from '@testing-library/react';

vi.mock('../../plugins/quick-open/walk-files', () => ({
  walkWorkspaceFiles: vi.fn(),
}));

import {
  _resetLmApiForTest,
  captureLmApi,
} from '../../lib/co-api';
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
  return {
    name,
    relPath: relPath ?? name,
    absPath: `/proj/${relPath ?? name}`,
  };
}

function installFs(over: Record<string, unknown> = {}): void {
  Object.defineProperty(window, 'api', {
    value: {
      fs: {
        listDir: vi.fn().mockResolvedValue({ ok: true, data: [] }),
        readFile: vi
          .fn()
          .mockResolvedValue({ ok: true, data: 'content' }),
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
});

afterEach(() => {
  delete (window as { api?: unknown }).api;
  cleanup();
  vi.restoreAllMocks();
});

describe('QuickOpenModal — 渲染态', () => {
  it('isOpen=false → 不渲染 Modal', () => {
    installFs();
    render(<QuickOpenModal />);
    expect(document.querySelector('.wm-modal-content')).toBeNull();
  });

  it('isOpen=true + root=null → 「请先在 Explorer 打开工作区」', () => {
    installFs();
    useQuickOpenStore.setState({ isOpen: true });
    render(<QuickOpenModal />);
    expect(document.querySelector('.wm-modal-content')!.textContent).toContain(
      '请先在 Explorer 打开工作区',
    );
  });

  it('walk 进行中 + results=[] → spinner「扫描中…」', () => {
    installFs();
    walkMock.mockReturnValue(new Promise(() => {})); // 永不 resolve
    useWorkspaceStore.setState({ root: '/proj', recentRoots: [] });
    useQuickOpenStore.setState({ isOpen: true });
    render(<QuickOpenModal />);
    expect(document.querySelector('.wm-modal-content')!.textContent).toContain(
      '扫描中…',
    );
  });

  it('walk 完成 + results=[] → 「工作区无文件」', async () => {
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
  });

  it('walk ok=false → setResults([]) + console.warn', async () => {
    installFs();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    walkMock.mockResolvedValue({
      ok: false,
      code: 'EACCES',
      message: 'denied',
    });
    useWorkspaceStore.setState({ root: '/proj', recentRoots: [] });
    useQuickOpenStore.setState({ isOpen: true });
    render(<QuickOpenModal />);
    await waitFor(() => {
      expect(useQuickOpenStore.getState().loading).toBe(false);
    });
    expect(warn).toHaveBeenCalled();
    expect(useQuickOpenStore.getState().results).toEqual([]);
  });

  it('有结果 → ul + li 列出', async () => {
    installFs();
    walkMock.mockResolvedValue({
      ok: true,
      data: [file('a.ts', 'src/a.ts'), file('b.ts', 'src/b.ts')],
    });
    useWorkspaceStore.setState({ root: '/proj', recentRoots: [] });
    useQuickOpenStore.setState({ isOpen: true });
    render(<QuickOpenModal />);
    await waitFor(() => {
      expect(document.querySelectorAll('ul li').length).toBeGreaterThanOrEqual(
        2,
      );
    });
    expect(document.querySelector('.wm-modal-content')!.textContent).toContain(
      'a.ts',
    );
  });
});

describe('QuickOpenModal — 搜索过滤', () => {
  it('query 输入 → fuzzyFilter 缩小列表', async () => {
    installFs();
    walkMock.mockResolvedValue({
      ok: true,
      data: [file('alpha.ts'), file('beta.ts'), file('gamma.ts')],
    });
    useWorkspaceStore.setState({ root: '/proj', recentRoots: [] });
    useQuickOpenStore.setState({ isOpen: true });
    render(<QuickOpenModal />);
    await waitFor(() => {
      expect(document.querySelectorAll('ul li').length).toBeGreaterThan(0);
    });

    const input = document.querySelector(
      '.wm-modal-content input',
    ) as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'alpha' } });
    await waitFor(() => {
      expect(
        document.querySelector('.wm-modal-content')!.textContent,
      ).toContain('alpha.ts');
      expect(
        document.querySelector('.wm-modal-content')!.textContent,
      ).not.toContain('beta.ts');
    });
  });

  it('全过滤掉 → 「无匹配文件」', async () => {
    installFs();
    walkMock.mockResolvedValue({
      ok: true,
      data: [file('alpha.ts')],
    });
    useWorkspaceStore.setState({ root: '/proj', recentRoots: [] });
    useQuickOpenStore.setState({ isOpen: true });
    render(<QuickOpenModal />);
    await waitFor(() => {
      expect(document.querySelectorAll('ul li').length).toBeGreaterThan(0);
    });
    const input = document.querySelector(
      '.wm-modal-content input',
    ) as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'zzz_no_match' } });
    await waitFor(() => {
      expect(
        document.querySelector('.wm-modal-content')!.textContent,
      ).toContain('无匹配文件');
    });
  });
});

describe('QuickOpenModal — 键盘 + 点击', () => {
  it('Enter → openFileByPath + close', async () => {
    const readFile = vi
      .fn()
      .mockResolvedValue({ ok: true, data: 'hello' });
    installFs({ readFile });
    walkMock.mockResolvedValue({
      ok: true,
      data: [file('a.ts', 'src/a.ts')],
    });
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
      expect(useQuickOpenStore.getState().isOpen).toBe(false);
      expect(readFile).toHaveBeenCalledWith('/proj/src/a.ts');
    });
  });

  it('ArrowDown / ArrowUp → 移动 selectedIndex', async () => {
    installFs();
    walkMock.mockResolvedValue({
      ok: true,
      data: [file('a.ts'), file('b.ts'), file('c.ts')],
    });
    useWorkspaceStore.setState({ root: '/proj', recentRoots: [] });
    useQuickOpenStore.setState({ isOpen: true, selectedIndex: 0 });
    render(<QuickOpenModal />);
    await waitFor(() => {
      expect(document.querySelectorAll('ul li').length).toBeGreaterThan(0);
    });
    const input = document.querySelector(
      '.wm-modal-content input',
    ) as HTMLInputElement;
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    expect(useQuickOpenStore.getState().selectedIndex).toBe(1);
    fireEvent.keyDown(input, { key: 'ArrowUp' });
    expect(useQuickOpenStore.getState().selectedIndex).toBe(0);
  });

  it('点 li → openFile + close', async () => {
    const readFile = vi
      .fn()
      .mockResolvedValue({ ok: true, data: 'x' });
    installFs({ readFile });
    walkMock.mockResolvedValue({
      ok: true,
      data: [file('a.ts'), file('b.ts')],
    });
    useWorkspaceStore.setState({ root: '/proj', recentRoots: [] });
    useQuickOpenStore.setState({ isOpen: true });
    render(<QuickOpenModal />);
    await waitFor(() => {
      expect(document.querySelectorAll('ul li').length).toBeGreaterThan(0);
    });
    const items = document.querySelectorAll('ul li');
    fireEvent.click(items[1]!);
    await waitFor(() => {
      expect(useQuickOpenStore.getState().isOpen).toBe(false);
    });
  });
});

describe('QuickOpenModal — 5000 文件尾巴提示', () => {
  it('results.length≥5000 + filtered>0 → 显示尾巴提示', async () => {
    installFs();
    const many = Array.from({ length: 5000 }, (_, i) =>
      file(`f${i}.ts`, `f${i}.ts`),
    );
    walkMock.mockResolvedValue({ ok: true, data: many });
    useWorkspaceStore.setState({ root: '/proj', recentRoots: [] });
    useQuickOpenStore.setState({ isOpen: true });
    render(<QuickOpenModal />);
    await waitFor(() => {
      expect(document.querySelectorAll('ul li').length).toBeGreaterThan(0);
    });
    expect(document.querySelector('.wm-modal-content')!.textContent).toContain(
      '仅显示前 5000 个文件',
    );
  });
});

describe('QuickOpenModal — open/close 副作用', () => {
  it('打开时 setLoading(true) + walk → setResults', async () => {
    installFs();
    walkMock.mockResolvedValue({
      ok: true,
      data: [file('x.ts')],
    });
    useWorkspaceStore.setState({ root: '/proj', recentRoots: [] });
    render(<QuickOpenModal />);

    act(() => {
      useQuickOpenStore.getState().open();
    });
    await waitFor(() => {
      expect(useQuickOpenStore.getState().loading).toBe(false);
      expect(useQuickOpenStore.getState().results.length).toBe(1);
    });
  });
});
