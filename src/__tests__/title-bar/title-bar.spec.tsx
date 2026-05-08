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
