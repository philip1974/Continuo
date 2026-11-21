import { beforeEach, describe, expect, it, vi } from 'vitest';
import { coApp } from '@/plugins/co-app';
import { openFileByPath } from '@/panels/Editor/editor-file-actions';
import { useEditorStore } from '@/stores/editor.store';

vi.mock('@/panels/Editor/editor-file-actions', () => ({
  openFileByPath: vi.fn(),
}));

vi.mock('@/lib/co-api', () => ({
  coApi: {
    fs: {
      readFile: vi.fn(),
      writeFile: vi.fn(),
    },
  },
}));

const mockedOpenFileByPath = vi.mocked(openFileByPath);

beforeEach(() => {
  vi.clearAllMocks();
  useEditorStore.setState({
    tabs: [],
    activeTabId: null,
    mode: 'edit',
  });
});

describe('app.editor.openFile happy path', () => {
  it('T1 opens a file without line and reports no-line-arg', async () => {
    mockedOpenFileByPath.mockResolvedValue({ ok: true, data: undefined });

    const result = await coApp.editor.openFile('/work/a.ts');

    expect(mockedOpenFileByPath).toHaveBeenCalledWith(
      '/work/a.ts',
      expect.objectContaining({ store: useEditorStore }),
    );
    expect(result).toEqual({
      ok: true,
      lineApplied: false,
      reason: 'no-line-arg',
    });
  });

  it('T2 delegates already-open files to openFileByPath switch behavior', async () => {
    useEditorStore.setState({
      tabs: [
        {
          id: '/work/a.ts',
          filePath: '/work/a.ts',
          content: 'cached',
          originalContent: 'cached',
          dirty: false,
        },
      ],
      activeTabId: '/work/other.ts',
      mode: 'edit',
    });
    mockedOpenFileByPath.mockResolvedValue({ ok: true, data: undefined });

    const result = await coApp.editor.openFile('/work/a.ts');

    expect(mockedOpenFileByPath).toHaveBeenCalledWith(
      '/work/a.ts',
      expect.any(Object),
    );
    expect(result).toEqual({
      ok: true,
      lineApplied: false,
      reason: 'no-line-arg',
    });
  });

  it('T3 delegates unopened files to create and open', async () => {
    mockedOpenFileByPath.mockResolvedValue({ ok: true, data: undefined });

    const result = await coApp.editor.openFile('/work/new.ts');

    expect(mockedOpenFileByPath).toHaveBeenCalledTimes(1);
    expect(mockedOpenFileByPath).toHaveBeenCalledWith(
      '/work/new.ts',
      expect.any(Object),
    );
    expect(result.ok).toBe(true);
  });
});

