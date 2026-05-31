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
  mockedScrollToLine.mockReturnValue('out-of-range');
  useEditorStore.setState({
    tabs: [
      {
        id: '/work/a.ts',
        filePath: '/work/a.ts',
        content: 'one',
        originalContent: 'one',
        dirty: false,
      },
    ],
    activeTabId: '/work/a.ts',
    mode: 'edit',
    waitForViewRef: vi.fn(async () => view),
  } as Partial<ReturnType<typeof useEditorStore.getState>>);
});

describe('app.editor.openFile line boundary handling', () => {
  it.each([0, 999, Number.NaN, 1.5])(
    'T1-T4 reports line-out-of-range for line=%s',
    async (line) => {
      const result = await coApp.editor.openFile('/work/a.ts', { line });

      expect(mockedScrollToLine).toHaveBeenCalledWith(view, line);
      expect(result).toEqual({
        ok: true,
        lineApplied: false,
        reason: 'line-out-of-range',
      });
    },
  );
});

