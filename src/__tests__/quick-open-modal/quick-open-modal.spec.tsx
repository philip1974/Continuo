// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fireEvent, render, cleanup, act, waitFor } from '@testing-library/react';

vi.mock('../../plugins/quick-open/walk-files', () => ({
  walkWorkspaceFiles: vi.fn(),
}));

// 虚拟化(打磨 R25):jsdom 无布局 → 真 virtualizer 量到 0 高 → 渲染 0 行。
// mock 成"渲染全部 index",让既有断言(列表项渲染 / 键盘选择)继续有效;
// 生产用真 @tanstack/react-virtual 只渲染可视行。同 FolderTree 测试策略。
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

import {
  _resetLmApiForTest,
  captureLmApi,
} from '../../lib/co-api';
import {
  QuickOpenModal,
  quickOpenRowClassName,
} from '../../plugins/quick-open/QuickOpenModal';
import {
  useQuickOpenStore,
  type QuickOpenFile,
} from '../../plugins/quick-open/store';
import { useWorkspaceStore } from '../../stores/workspace.store';
import { useEditorStore } from '../../stores/editor.store';
import { walkWorkspaceFiles } from '../../plugins/quick-open/walk-files';

const walkMock = walkWorkspaceFiles as unknown as ReturnType<typeof vi.fn>;

function file(name: string, relPath?: string): QuickOpenFile {
  const rp = relPath ?? name;
  return {
    name,
    relPath: rp,
    relPathLower: rp.toLowerCase(),
    absPath: `/proj/${rp}`,
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
  it('placeholder 快捷键 label 预计算,不在 render 中重复 detectPlatform', () => {
    const src = readFileSync(join(process.cwd(), 'src/plugins/quick-open/QuickOpenModal.tsx'), 'utf8');

    expect(src).toContain('const QUICK_OPEN_SHORTCUT_LABEL = formatHotkey');
    expect(src).toContain('shortcut: QUICK_OPEN_SHORTCUT_LABEL');
    expect(src).not.toContain("shortcut: formatHotkey('mod+shift+p', detectPlatform())");
  });

  it('输入框 aria 与 placeholder label 在 body render 内复用', () => {
    const src = readFileSync(join(process.cwd(), 'src/plugins/quick-open/QuickOpenModal.tsx'), 'utf8');

    expect(src).toContain('const inputAriaLabel = t(');
    expect(src).toContain('const placeholderLabel = t(');
    expect(src).toContain('aria-label={inputAriaLabel}');
    expect(src).toContain('placeholder={placeholderLabel}');
    expect(
      src.match(/aria-label=\{t\('quick_open\.input_aria'\)\}/g)?.length ?? 0,
    ).toBe(1);
    expect(src).not.toContain("placeholder={t('quick_open.placeholder'");
  });

  it('行 className 不通过数组 join 重建', () => {
    const joinSpy = vi.spyOn(Array.prototype, 'join');

    try {
      expect(quickOpenRowClassName(true)).toContain('bg-hover text-fg');
      expect(quickOpenRowClassName(false)).toContain(
        'text-fg-muted hover:bg-hover/50',
      );
      expect(joinSpy).not.toHaveBeenCalled();
    } finally {
      joinSpy.mockRestore();
    }
  });

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

  // a11y(A69,A56 同族):无 workspace 空态须 live region,弹窗打开焦点落搜索框时 SR 能播报。
  it('a11y · 无 workspace 空态在 role=status', () => {
    installFs();
    useQuickOpenStore.setState({ isOpen: true });
    render(<QuickOpenModal />);
    const status = document.querySelector('.wm-modal-content [role=status]');
    expect(status).not.toBeNull();
    expect(status!.textContent).toContain('请先在 Explorer 打开工作区');
  });

  // a11y(A2,A1 同族):搜索框须有稳定可访问名(aria-label),placeholder 含快捷键不适合,
  // 用专用简洁 aria-label。locale-无关:断言 aria-label 非空且 != placeholder(后者含快捷键)。
  it('a11y · 搜索 Input 有专用 aria-label(非含快捷键的 placeholder)', () => {
    installFs();
    walkMock.mockReturnValue(new Promise(() => {})); // Input 渲染不依赖 walk 完成
    useWorkspaceStore.setState({ root: '/proj', recentRoots: [] });
    useQuickOpenStore.setState({ isOpen: true });
    render(<QuickOpenModal />);
    const input = document.querySelector(
      '.wm-modal-content input',
    ) as HTMLInputElement | null;
    expect(input).not.toBeNull();
    const ariaLabel = input!.getAttribute('aria-label') ?? '';
    expect(ariaLabel.length).toBeGreaterThan(0);
    expect(ariaLabel).not.toBe(input!.getAttribute('placeholder'));
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

  // a11y(A102,A93 同族):扫描中态须 role=status 播报「扫描中」具体语义(非 Spinner 泛化 Loading)。
  it('a11y · 扫描中 → role=status 含「扫描中」且 Spinner 对 AT 隐藏', () => {
    installFs();
    walkMock.mockReturnValue(new Promise(() => {}));
    useWorkspaceStore.setState({ root: '/proj', recentRoots: [] });
    useQuickOpenStore.setState({ isOpen: true });
    render(<QuickOpenModal />);
    const statuses = Array.from(
      document.querySelectorAll('.wm-modal-content [role=status]'),
    );
    const scanning = statuses.find((s) => (s.textContent ?? '').includes('扫描中'));
    expect(scanning).toBeTruthy();
    // Spinner 标 aria-hidden(抑制泛化 Loading,避免与扫描 status 双重播报)
    expect(scanning!.querySelector('[aria-hidden="true"]')).not.toBeNull();
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

  // a11y(A45,A41 同族):扫描失败提示异步插入,须 role=alert(焦点在搜索框时也能播报)。
  it('a11y · 扫描失败 → 提示容器有 role=alert', async () => {
    installFs();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    walkMock.mockResolvedValue({ ok: false, code: 'EACCES', message: 'denied' });
    useWorkspaceStore.setState({ root: '/proj', recentRoots: [] });
    useQuickOpenStore.setState({ isOpen: true });
    const { container } = render(<QuickOpenModal />);
    await waitFor(() => {
      expect(useQuickOpenStore.getState().scanFailed).toBe(true);
    });
    const alert = container.querySelector('[role=alert]');
    expect(alert).not.toBeNull();
    expect((alert!.textContent ?? '').length).toBeGreaterThan(0); // 含失败文案
    expect(alert!.querySelector('button')).not.toBeNull(); // 含重试按钮
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

  // a11y(A65,A56 同族):结果达 5000 截断提示是动态出现的信息,焦点锁搜索框时 SR 须能播报。
  it('a11y · 结果达 5000 截断时 limit_hint 在 role=status', async () => {
    installFs();
    const many = Array.from({ length: 5000 }, (_, i) =>
      file(`f${i}.ts`, `src/f${i}.ts`),
    );
    walkMock.mockResolvedValue({ ok: true, data: many });
    useWorkspaceStore.setState({ root: '/proj', recentRoots: [] });
    useQuickOpenStore.setState({ isOpen: true });
    render(<QuickOpenModal />);
    await waitFor(() => {
      expect(document.querySelectorAll('ul li').length).toBeGreaterThan(0);
    });
    // filtered.length>0 时唯一的 role=status 即截断提示
    const status = document.querySelector('.wm-modal-content [role=status]');
    expect(status).not.toBeNull();
    expect(status!.textContent).toContain('仅显示前 5000 个文件');
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
    // a11y(A56,CommandPalette 兄弟):空态须在 live region(role=status)播报无匹配。
    const status = document.querySelector('.wm-modal-content [role=status]');
    expect(status).not.toBeNull();
    expect(status!.textContent).toContain('无匹配文件');
    // a11y(A100,CommandPalette 同模式):无结果时 combobox aria-expanded 仍 true(弹层可见),
    // aria-activedescendant 移除。
    expect(input.getAttribute('aria-expanded')).toBe('true');
    expect(input.getAttribute('aria-activedescendant')).toBeNull();
    // a11y(A101):无结果 listbox 不渲染 → aria-controls 移除,避免悬空。
    expect(input.getAttribute('aria-controls')).toBeNull();
  });
});

describe('QuickOpenModal — a11y(A111)/race(R48)越界 selectedIndex 钳回有效项', () => {
  it('遗留越界 selectedIndex → R48 钳回有效项,aria-activedescendant 指向有效 option(不悬空)', async () => {
    installFs();
    walkMock.mockResolvedValue({ ok: true, data: [file('a.ts', 'src/a.ts')] });
    useWorkspaceStore.setState({ root: '/proj', recentRoots: [] });
    // 只有 1 个结果但 selectedIndex=5(模拟结果异步变短后遗留旧下标)
    useQuickOpenStore.setState({ isOpen: true, selectedIndex: 5 });
    render(<QuickOpenModal />);
    await waitFor(() => {
      expect(document.querySelectorAll('ul li').length).toBe(1);
    });
    const input = document.querySelector(
      '.wm-modal-content input',
    ) as HTMLInputElement;
    // race(R48):filtered.length 变化触发 clampSelection → selectedIndex 钳到 0(唯一有效项),
    // aria-activedescendant 指向**存在的** option-0(A111 意图「不指向不存在 option」仍满足,
    // 且 Enter 现在能打开有效项,而非越界静默无操作)。
    await waitFor(() => {
      expect(useQuickOpenStore.getState().selectedIndex).toBe(0);
      expect(input.getAttribute('aria-activedescendant')).toBe(
        'quick-open-option-0',
      );
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

// race(R2):切 workspace 后旧 root 的 results 仍在 store(复用优化),不得在新 root 扫描期间
// 展示/允许打开 → 跨 root 泄漏。
describe('QuickOpenModal — R2 跨 root 旧结果不泄漏', () => {
  it('旧 root 结果 + 切到新 root 打开 → 不展示旧结果(展示扫描中),新扫描只落新 root', async () => {
    installFs();
    // 旧 root 的结果已在 store(上次在 /old 打开扫描所得)。
    useQuickOpenStore.setState({
      isOpen: false,
      results: [file('old-file.ts', 'old-file.ts')],
      resultsRoot: '/old',
      loading: false,
      scanFailed: false,
    });
    // 当前已切到新 workspace /new;新 root 扫描挂起(不 resolve)→ 模拟慢扫描窗口。
    useWorkspaceStore.setState({ root: '/new', recentRoots: [] });
    let resolveWalk!: (v: unknown) => void;
    walkMock.mockReturnValue(
      new Promise((res) => {
        resolveWalk = res;
      }),
    );
    render(<QuickOpenModal />);
    act(() => {
      useQuickOpenStore.getState().open();
    });

    // 扫描挂起期间:绝不展示旧 root 的 old-file.ts,而是「正在扫描」。
    await waitFor(() => {
      const txt = document.querySelector('.wm-modal-content')!.textContent ?? '';
      expect(txt).not.toContain('old-file.ts');
    });
    expect(document.querySelectorAll('[role=option]').length).toBe(0);

    // 新扫描完成 → 只落新 root 结果。
    await act(async () => {
      resolveWalk({ ok: true, data: [file('new-file.ts', 'new-file.ts')] });
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(useQuickOpenStore.getState().resultsRoot).toBe('/new');
      const txt = document.querySelector('.wm-modal-content')!.textContent ?? '';
      expect(txt).toContain('new-file.ts');
      expect(txt).not.toContain('old-file.ts');
    });
  });
});
