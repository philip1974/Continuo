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

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(openFileByPath).mockResolvedValue({ ok: true, data: undefined });
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
    waitForViewRef: vi.fn(async () => null),
  } as Partial<ReturnType<typeof useEditorStore.getState>>);
});

describe('app.editor.openFile tab mount race', () => {
  it('T1 reports tab-not-mounted when waitForViewRef times out', async () => {
    const result = await coApp.editor.openFile('/work/a.ts', { line: 1 });

    expect(useEditorStore.getState().waitForViewRef).toHaveBeenCalledWith(
      '/work/a.ts',
      500,
    );
    expect(scrollToLine).not.toHaveBeenCalled();
    expect(result).toEqual({
      ok: true,
      lineApplied: false,
      reason: 'tab-not-mounted',
    });
  });
});

