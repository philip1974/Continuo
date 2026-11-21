// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import { TitleBar } from '../../shell/TitleBar';
import { useEditorStore } from '../../stores/editor.store';
import { useWorkspaceStore } from '../../stores/workspace.store';

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

  it('active.filePath=null(草稿)→ "未命名"', () => {
    useEditorStore.setState({
      tabs: [
        {
          id: 'untitled-1',
          filePath: null,
          content: '',
          originalContent: '',
          dirty: false,
        },
      ],
      activeTabId: 'untitled-1',
    });
    const { container } = render(<TitleBar />);
    expect(container.textContent).toContain('未命名');
  });
});
