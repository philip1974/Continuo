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
  useEditorStore.setState({
    tabs: [
      {
        id: '/work/a.ts',
        filePath: '/work/a.ts',
        content: 'one\ntwo',
        originalContent: 'one\ntwo',
        dirty: false,
      },
    ],
    activeTabId: '/work/a.ts',
    mode: 'edit',
    waitForViewRef: vi.fn(async () => view),
  } as Partial<ReturnType<typeof useEditorStore.getState>>);
});

describe('app.editor.openFile line jump', () => {
  it('T1 scrolls a CodeMirror file to the requested line', async () => {
    const result = await coApp.editor.openFile('/work/a.ts', { line: 2 });

    expect(useEditorStore.getState().waitForViewRef).toHaveBeenCalledWith(
      '/work/a.ts',
      500,
    );
    expect(mockedScrollToLine).toHaveBeenCalledWith(view, 2);
    expect(result).toEqual({ ok: true, lineApplied: true });
  });

  it('T2 does not scroll when line is omitted', async () => {
    const result = await coApp.editor.openFile('/work/a.ts');

    expect(mockedScrollToLine).not.toHaveBeenCalled();
    expect(result).toEqual({
      ok: true,
      lineApplied: false,
      reason: 'no-line-arg',
    });
  });
});

