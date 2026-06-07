import { describe, expect, it, vi } from 'vitest';
import { pickArgvFolders } from '../../../electron/main/services/cli-args.service';

describe('pickArgvFolders', () => {
  it('packaged mode returns existing absolute folder argv entries', () => {
    const isDir = vi.fn((p: string) => p === '/Users/foo/proj');

    expect(
      pickArgvFolders(
        ['/Applications/Continuo.app/Contents/MacOS/Continuo', '/Users/foo/proj'],
        isDir,
        { skipFirstArg: false },
      ),
    ).toEqual(['/Users/foo/proj']);
  });

  it('dev mode skips argv[1] and keeps the dragged folder', () => {
    const isDir = vi.fn((p: string) => p === '/Users/foo/proj');

    expect(
      pickArgvFolders(['electron', '.', '/Users/foo/proj'], isDir, {
        skipFirstArg: true,
      }),
    ).toEqual(['/Users/foo/proj']);
    expect(isDir).not.toHaveBeenCalledWith('.');
  });

  it('drops non-existing paths', () => {
    const isDir = vi.fn((_p: string) => false);

    expect(
      pickArgvFolders(['Continuo', '/Users/foo/nope'], isDir, {
        skipFirstArg: false,
      }),
    ).toEqual([]);
  });

  it('dedupes duplicate folders preserving first-seen order', () => {
    const isDir = vi.fn((_p: string) => true);

    expect(
      pickArgvFolders(
        ['Continuo', '/Users/foo/proj', '/Users/foo/proj'],
        isDir,
        { skipFirstArg: false },
      ),
    ).toEqual(['/Users/foo/proj']);
  });

  it('skipAll returns empty even when argv has a folder', () => {
    const isDir = vi.fn((_p: string) => true);

    expect(
      pickArgvFolders(['Continuo', '/Users/foo/proj'], isDir, {
        skipFirstArg: false,
        skipAll: true,
      }),
    ).toEqual([]);
    expect(isDir).not.toHaveBeenCalled();
  });

  it('drops relative paths before checking isExistingDir', () => {
    const isDir = vi.fn((_p: string) => true);

    expect(
      pickArgvFolders(['Continuo', 'relative/path'], isDir, {
        skipFirstArg: false,
      }),
    ).toEqual([]);
    expect(isDir).not.toHaveBeenCalled();
  });

  it('keeps mixed absolute folders, drops relative paths, and dedupes', () => {
    const isDir = vi.fn((p: string) => p === '/abs/a' || p === '/abs/b');

    expect(
      pickArgvFolders(
        ['Continuo', '/abs/a', 'relative', '/abs/b', '/abs/a'],
        isDir,
        { skipFirstArg: false },
      ),
    ).toEqual(['/abs/a', '/abs/b']);
  });
});
