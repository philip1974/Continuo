// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, cleanup, act } from '@testing-library/react';
import { TitleBar } from '../../shell/TitleBar';
import { useEditorStore } from '../../stores/editor.store';
import { useWorkspaceStore } from '../../stores/workspace.store';

const h = vi.hoisted(() => ({
  zoom: vi.fn(() => 1),
  isFullScreen: vi.fn(async () => ({ ok: true as const, data: false })),
  fullScreenListeners: new Set<(v: boolean) => void>(),
}));
vi.mock('@/lib/co-api', () => ({
  coApi: {
    window: {
      getZoomFactor: h.zoom,
      isFullScreen: h.isFullScreen,
      onFullScreenChange: (cb: (v: boolean) => void) => {
        h.fullScreenListeners.add(cb);
        return () => h.fullScreenListeners.delete(cb);
      },
    },
  },
}));

// 应用内标题栏只在 macOS 渲染(Windows / Linux 是原生标题栏,见下方「非 macOS」用例与 src/__tests__/win-linux-parity/)。
const setNavigatorPlatform = (value: string) => Object.defineProperty(navigator, 'platform', { value, configurable: true });

beforeEach(() => {
  setNavigatorPlatform('MacIntel');
  useEditorStore.setState({ tabs: [], activeTabId: null });
  useWorkspaceStore.setState({ root: null });
});

afterEach(() => {
  cleanup();
  setNavigatorPlatform('');
});

describe('TitleBar', () => {
  it('无 workspace + 无 active → "Continuo"', () => {
    const { container } = render(<TitleBar />);
    expect(container.textContent).toContain('Continuo');
  });

  it('仅 root → basename(root)', () => {
    useWorkspaceStore.setState({ root: '/Users/foo/projects/myapp' });
    const { container } = render(<TitleBar />);
    expect(container.textContent).toContain('myapp');
    expect(container.textContent).not.toContain('Continuo');
  });

  it('active + root → file · workspace', () => {
    useWorkspaceStore.setState({ root: '/Users/foo/myapp' });
    useEditorStore.setState({
      tabs: [
        {
          id: '/Users/foo/myapp/src/a.ts',
          filePath: '/Users/foo/myapp/src/a.ts',
          content: 'x',
          originalContent: 'x',
          dirty: false,
        },
      ],
      activeTabId: '/Users/foo/myapp/src/a.ts',
    });
    const { container } = render(<TitleBar />);
    expect(container.textContent).toContain('a.ts');
    expect(container.textContent).toContain('myapp');
  });

  it('dirty=true → 文件名追加 " ●"', () => {
    useEditorStore.setState({
      tabs: [
        {
          id: '/x/a.ts',
          filePath: '/x/a.ts',
          content: 'new',
          originalContent: 'old',
          dirty: true,
        },
      ],
      activeTabId: '/x/a.ts',
    });
    const { container } = render(<TitleBar />);
    expect(container.textContent).toContain('a.ts ●');
  });

  // a11y(A40,A35/A37 同族):dirty ● 仅视觉(aria-hidden),未保存语义须给 AT 视觉隐藏真实文本。
  it('a11y · dirty → AT 可读「未保存」文本 + ● aria-hidden;clean → 无', () => {
    // chromeVersion 是 TitleBar useMemo 的失效键,须随 dirty 翻转 bump 才重算。
    useEditorStore.setState({
      tabs: [
        {
          id: '/x/a.ts',
          filePath: '/x/a.ts',
          content: 'new',
          originalContent: 'old',
          dirty: true,
        },
      ],
      activeTabId: '/x/a.ts',
      chromeVersion: 1,
    });
    const { container, rerender } = render(<TitleBar />);
    expect(container.textContent).toContain('未保存的更改');
    const dot = Array.from(
      container.querySelectorAll('span[aria-hidden="true"]'),
    ).find((s) => (s.textContent ?? '').includes('●'));
    expect(dot).toBeDefined();

    useEditorStore.setState({
      tabs: [
        {
          id: '/x/a.ts',
          filePath: '/x/a.ts',
          content: 'x',
          originalContent: 'x',
          dirty: false,
        },
      ],
      activeTabId: '/x/a.ts',
      chromeVersion: 2,
    });
    rerender(<TitleBar />);
    expect(container.textContent).not.toContain('未保存的更改');
  });
});

// macOS hiddenInset:红绿灯是原生控件、不随网页缩放。标题栏随 ⌘- 变矮时红绿灯伸出标题栏 → 按 1 / 缩放系数反向缩放
//(VSCode titlebarPart:标题栏没有可缩放的自定义项时 counter-zoom,`zoom: calc(1 / var(--zoom-factor))`),实际高度不变。
describe('TitleBar · macOS 界面缩放下高度不变', () => {
  const setPlatform = (value: string) => Object.defineProperty(navigator, 'platform', { value, configurable: true });
  const header = (c: HTMLElement) => c.querySelector('header')!;
  afterEach(() => {
    setPlatform('');
    h.zoom.mockReturnValue(1);
  });

  it('macOS:缩小 / 放大时标题栏按 1 / 缩放系数反向缩放,随缩放变化(resize)更新;100% 不加', () => {
    setPlatform('MacIntel');
    h.zoom.mockReturnValue(0.8);
    const { container } = render(<TitleBar />);
    expect(Number(header(container).style.zoom)).toBeCloseTo(1.25);
    h.zoom.mockReturnValue(1.5);
    act(() => {
      window.dispatchEvent(new Event('resize'));
    });
    expect(Number(header(container).style.zoom)).toBeCloseTo(1 / 1.5);
    h.zoom.mockReturnValue(1);
    act(() => {
      window.dispatchEvent(new Event('resize'));
    });
    expect(header(container).style.zoom).toBe('');
  });

  it('非 macOS(原生标题栏)不渲染应用内标题栏;取不到缩放系数:不反向缩放', () => {
    setPlatform('Win32');
    h.zoom.mockReturnValue(0.8);
    const { container, unmount } = render(<TitleBar />);
    expect(container.querySelector('header')).toBeNull();
    unmount();
    setPlatform('MacIntel');
    h.zoom.mockImplementation(() => {
      throw new Error('no api');
    });
    const again = render(<TitleBar />);
    expect(header(again.container).style.zoom).toBe('');
  });
});

describe('TitleBar · macOS 红绿灯留位(VSCode mac window-controls-container,全屏时隐藏)', () => {
  const setPlatform = (value: string) => Object.defineProperty(navigator, 'platform', { value, configurable: true });
  const title = (c: HTMLElement) => c.querySelector<HTMLElement>('[data-title-text]')!;
  const flush = () => act(async () => {});
  afterEach(() => {
    setPlatform('');
    h.isFullScreen.mockResolvedValue({ ok: true, data: false });
    h.fullScreenListeners.clear();
  });
  const push = (v: boolean) =>
    act(() => {
      for (const l of [...h.fullScreenListeners]) l(v);
    });

  it('macOS 非全屏:标题两侧各留 80px(对称居中、长标题不压红绿灯);进入全屏 → 48px,退出 → 恢复', async () => {
    setPlatform('MacIntel');
    useWorkspaceStore.setState({ root: `/w/${'long-name-'.repeat(20)}` });
    const { container } = render(<TitleBar />);
    await flush();
    expect(title(container).className).toContain('px-20');
    expect(title(container).className).toContain('truncate');
    push(true);
    expect(title(container).className).toContain('px-12');
    expect(title(container).className).not.toContain('px-20');
    push(false);
    expect(title(container).className).toContain('px-20');
  });

  it('启动即全屏(查询初值)→ 不留位;推送先于迟到的初值到达时以推送为准', async () => {
    setPlatform('MacIntel');
    h.isFullScreen.mockResolvedValue({ ok: true, data: true });
    const { container, unmount } = render(<TitleBar />);
    await flush();
    expect(title(container).className).toContain('px-12');
    unmount();
    let resolve!: (v: { ok: true; data: boolean }) => void;
    h.isFullScreen.mockImplementation(() => new Promise((r) => (resolve = r)));
    const again = render(<TitleBar />);
    push(true);
    await act(async () => resolve({ ok: true, data: false }));
    expect(title(again.container).className).toContain('px-12');
  });

  it('非 macOS(原生标题栏)不渲染应用内标题栏、不查询全屏', async () => {
    setPlatform('Win32');
    h.isFullScreen.mockClear();
    const { container } = render(<TitleBar />);
    await flush();
    expect(container.querySelector('[data-title-text]')).toBeNull();
    expect(h.isFullScreen).not.toHaveBeenCalled();
  });
});
