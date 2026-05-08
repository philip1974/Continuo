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

function installFs(selectDirectory: ReturnType<typeof vi.fn>): void {
  Object.defineProperty(window, 'api', {
    value: { fs: { selectDirectory } },
    writable: true,
    configurable: true,
  });
  captureLmApi();
}

beforeEach(() => {
  _resetLmApiForTest();
  useWorkspaceStore.setState({ root: null, recentRoots: [] });
  useEditorStore.setState({ tabs: [], activeTabId: null });
});

afterEach(() => {
  delete (window as { api?: unknown }).api;
  cleanup();
  vi.restoreAllMocks();
});

describe('EmptyWorkspace', () => {
  it('recentRoots 空 → 不渲染 menu', () => {
    installFs(vi.fn());
    const { container } = render(<EmptyWorkspace />);
    expect(container.querySelector('[role=menu]')).toBeNull();
  });

  it('recentRoots 非空 → menu 列出,点击 setRoot', () => {
    installFs(vi.fn());
    useWorkspaceStore.setState({
      root: null,
      recentRoots: ['/Users/foo/projects/myapp'],
    });
    const { container } = render(<EmptyWorkspace />);
    const menu = container.querySelector('[role=menu]');
    expect(menu).not.toBeNull();
    expect(menu!.textContent).toContain('myapp');

    const item = container.querySelector('[role=menuitem]') as HTMLElement;
    fireEvent.click(item);
    expect(useWorkspaceStore.getState().root).toBe('/Users/foo/projects/myapp');
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
