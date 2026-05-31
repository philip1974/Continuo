import { beforeEach, describe, expect, it, vi } from 'vitest';
import { coApp } from '@/plugins/co-app';
import { openFileByPath } from '@/panels/Editor/editor-file-actions';
import { scrollToLine } from '@/panels/Editor/scrollToLine';
import { useEditorStore } from '@/stores/editor.store';

vi.mock('@/panels/Editor/editor-file-actions', () => ({
  openFileByPath: vi.fn(),
}));

vi.mock('@/panels/Editor/scrollToLine', () => ({
  scrollToLine: vi.fn(),
}));

vi.mock('@/lib/co-api', () => ({
  coApi: { fs: { readFile: vi.fn(), writeFile: vi.fn() } },
}));

const mockedOpenFileByPath = vi.mocked(openFileByPath);
const mockedScrollToLine = vi.mocked(scrollToLine);
const view = { id: 'view' };

beforeEach(() => {
  vi.clearAllMocks();
  mockedOpenFileByPath.mockResolvedValue({ ok: true, data: undefined });
  mockedScrollToLine.mockReturnValue('applied');
});

function setMarkdownState(mode: 'edit' | 'source') {
  useEditorStore.setState({
    tabs: [
      {
        id: '/work/readme.md',
        filePath: '/work/readme.md',
        content: '# title',
        originalContent: '# title',
        dirty: false,
      },
    ],
    activeTabId: '/work/readme.md',
    mode,
    waitForViewRef: vi.fn(async () => view),
  } as Partial<ReturnType<typeof useEditorStore.getState>>);
}

describe('app.editor.openFile markdown degradation', () => {
  it('T1 reports milkdown-engine for markdown edit mode', async () => {
    setMarkdownState('edit');

    const result = await coApp.editor.openFile('/work/readme.md', { line: 3 });

    expect(mockedScrollToLine).not.toHaveBeenCalled();
    expect(result).toEqual({
      ok: true,
      lineApplied: false,
      reason: 'milkdown-engine',
    });
  });

  it('T2 treats markdown source mode as CodeMirror', async () => {
    setMarkdownState('source');

    const result = await coApp.editor.openFile('/work/readme.md', { line: 3 });

    expect(useEditorStore.getState().waitForViewRef).toHaveBeenCalledWith(
      '/work/readme.md',
      500,
    );
    expect(mockedScrollToLine).toHaveBeenCalledWith(view, 3);
    expect(result).toEqual({ ok: true, lineApplied: true });
  });
});

