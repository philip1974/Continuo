import { beforeEach, describe, expect, it, vi } from 'vitest';
import { coApp } from '@/plugins/co-app';
import { openFileByPath } from '@/panels/Editor/editor-file-actions';
import { scrollToLine } from '@/panels/Editor/scrollToLine';

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

beforeEach(() => {
  vi.clearAllMocks();
});

describe('app.editor.openFile failure taxonomy', () => {
  it.each([
    ['FS_NOT_FOUND', 'missing'],
    ['FS_NOT_FILE', 'not file'],
    ['FS_DENIED', 'denied'],
    ['FS_IO', 'io failed'],
  ] as const)('T1-T4 preserves %s', async (code, message) => {
    mockedOpenFileByPath.mockResolvedValue({ ok: false, code, message });

    const result = await coApp.editor.openFile('/work/a.ts', { line: 1 });

    expect(result).toEqual({ ok: false, code, message });
    expect(scrollToLine).not.toHaveBeenCalled();
  });

  it('T5 maps thrown open failures to EXCEPTION', async () => {
    mockedOpenFileByPath.mockRejectedValue(new Error('boom'));

    const result = await coApp.editor.openFile('/work/a.ts', { line: 1 });

    expect(result).toMatchObject({
      ok: false,
      code: 'EXCEPTION',
      message: expect.stringContaining('boom'),
    });
  });

  it('T6 rejects relative paths as INVALID_PATH before opening', async () => {
    const result = await coApp.editor.openFile('relative.ts', { line: 1 });

    expect(mockedOpenFileByPath).not.toHaveBeenCalled();
    expect(result).toEqual({
      ok: false,
      code: 'INVALID_PATH',
      message: 'path must be absolute',
    });
  });
});

