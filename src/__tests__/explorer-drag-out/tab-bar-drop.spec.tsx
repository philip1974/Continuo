// @vitest-environment jsdom
// BDD:树拖出的文件拖到编辑器组的 tab 栏 → 高亮 tab 栏,放下在该组常驻打开(不拆分)。见同目录 README「行为 2」。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { EXPLORER_DRAG_MIME } from '@/lib/explorer-drag';
import { createTab, useEditorStore } from '@/stores/editor.store';
import { coApp } from '@/plugins/co-app';
import { EditorActionRegistry } from '@/plugins/registries/EditorActionRegistry';

const mocks = vi.hoisted(() => ({
  readFile: vi.fn(async (p: string) => ({ ok: true as const, data: `// ${p}` })),
}));
vi.mock('@/panels/Editor/editor-file-deps', () => ({
  editorFileDeps: { fs: { readFile: mocks.readFile, writeFile: vi.fn() } },
}));

import { EditorHeader } from '@/panels/Editor/EditorHeader';

function dataTransfer(entries: unknown, types = [EXPLORER_DRAG_MIME]) {
  const data = new Map([[EXPLORER_DRAG_MIME, JSON.stringify(entries)]]);
  return { types, dropEffect: 'none', getData: (f: string) => data.get(f) ?? '' };
}

beforeEach(() => {
  (coApp as { editorActions: EditorActionRegistry }).editorActions = new EditorActionRegistry();
  useEditorStore.setState({
    tabs: [],
    activeTabId: null,
    groups: [{ id: 'editor', tabIds: [], activeTabId: null }],
    activeGroupId: 'editor',
    tabMru: new Map(),
    previewTabs: new Map(),
    mode: 'source',
  });
  useEditorStore.getState().openTab(createTab('/w/readme.md', ''));
});
afterEach(() => cleanup());

const tabBar = () => screen.getByRole('tablist').closest('[data-editor-tab-bar]') as HTMLElement;

describe('拖到 tab 栏', () => {
  it('树拖出经过 → 接管(preventDefault,copy)并高亮;离开取消高亮;放下 → 文件在本组常驻打开、文件夹跳过', async () => {
    render(<EditorHeader onCloseRequest={vi.fn()} />);
    const bar = tabBar();
    const dt = dataTransfer([
      { path: '/w/a.ts', isDirectory: false },
      { path: '/w/src', isDirectory: true },
    ]);
    const over = fireEvent.dragOver(bar, { dataTransfer: dt });
    expect(over).toBe(false); // 已 preventDefault
    expect(dt.dropEffect).toBe('copy');
    expect(bar.className).toContain('bg-accent/20');
    fireEvent.dragLeave(bar, { dataTransfer: dt, relatedTarget: document.body });
    expect(bar.className).not.toContain('bg-accent/20');

    fireEvent.dragOver(bar, { dataTransfer: dt });
    await act(async () => {
      fireEvent.drop(bar, { dataTransfer: dt });
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(bar.className).not.toContain('bg-accent/20');
    const s = useEditorStore.getState();
    expect(s.tabs.map((t) => t.filePath)).toEqual(['/w/readme.md', '/w/a.ts']);
    expect(s.previewTabs.size).toBe(0);
    expect(mocks.readFile).toHaveBeenCalledTimes(1);
  });

  it('不是树拖出(OS 文件 / 普通文本)→ 不接管、不高亮', () => {
    render(<EditorHeader onCloseRequest={vi.fn()} />);
    const bar = tabBar();
    const dt = dataTransfer([], ['Files']);
    expect(fireEvent.dragOver(bar, { dataTransfer: dt })).toBe(true);
    expect(bar.className).not.toContain('bg-accent/20');
  });
});
