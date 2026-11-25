// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, cleanup, act } from '@testing-library/react';
import { TitleBar } from '../../shell/TitleBar';
import { useEditorStore } from '../../stores/editor.store';
import { useWorkspaceStore } from '../../stores/workspace.store';

const h = vi.hoisted(() => ({ zoom: vi.fn(() => 1) }));
vi.mock('@/lib/co-api', () => ({ coApi: { window: { getZoomFactor: h.zoom } } }));

beforeEach(() => {
  useEditorStore.setState({ tabs: [], activeTabId: null });
  useWorkspaceStore.setState({ root: null });
});

afterEach(() => cleanup());

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

  it('非 macOS(原生标题栏,无红绿灯)/ 取不到缩放系数:不反向缩放', () => {
    setPlatform('Win32');
    h.zoom.mockReturnValue(0.8);
    const { container, unmount } = render(<TitleBar />);
    expect(header(container).style.zoom).toBe('');
    unmount();
    setPlatform('MacIntel');
    h.zoom.mockImplementation(() => {
      throw new Error('no api');
    });
    const again = render(<TitleBar />);
    expect(header(again.container).style.zoom).toBe('');
  });
});
