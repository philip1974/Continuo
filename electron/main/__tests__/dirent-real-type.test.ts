import { describe, expect, it, vi } from 'vitest';
import { direntTypeIsReliable, realDirentType, type DirentTypeLike } from '../lib/dirent-real-type';

const kind = (k: 'file' | 'dir' | 'link' | 'unknown'): DirentTypeLike => ({
  isFile: () => k === 'file',
  isDirectory: () => k === 'dir',
  isSymbolicLink: () => k === 'link',
});

describe('direntTypeIsReliable', () => {
  it('文件/目录在任何平台可采信;类型未知不可采信', () => {
    for (const p of ['win32', 'linux', 'darwin'] as const) {
      expect(direntTypeIsReliable(kind('file'), p)).toBe(true);
      expect(direntTypeIsReliable(kind('dir'), p)).toBe(true);
      expect(direntTypeIsReliable(kind('unknown'), p)).toBe(false);
    }
  });

  it('dirent 报 symlink:仅 win32 不可采信', () => {
    expect(direntTypeIsReliable(kind('link'), 'win32')).toBe(false);
    expect(direntTypeIsReliable(kind('link'), 'linux')).toBe(true);
    expect(direntTypeIsReliable(kind('link'), 'darwin')).toBe(true);
  });
});

describe('realDirentType', () => {
  it('win32 dirent 报 symlink 而 lstat 为目录 → 目录', async () => {
    const lstat = vi.fn(async () => kind('dir'));
    expect(await realDirentType(kind('link'), 'C:\\x', { platform: 'win32', lstat })).toEqual({
      isFile: false,
      isDirectory: true,
      isSymlink: false,
    });
    expect(lstat).toHaveBeenCalledWith('C:\\x');
  });

  it('win32 真 symlink 在 lstat 下仍是 symlink', async () => {
    const lstat = vi.fn(async () => kind('link'));
    expect(await realDirentType(kind('link'), 'C:\\x', { platform: 'win32', lstat })).toMatchObject({
      isSymlink: true,
      isDirectory: false,
    });
  });

  it('可采信时不 lstat', async () => {
    const lstat = vi.fn(async () => kind('dir'));
    expect(await realDirentType(kind('link'), '/x', { platform: 'linux', lstat })).toMatchObject({ isSymlink: true });
    expect(await realDirentType(kind('file'), '/x', { platform: 'win32', lstat })).toMatchObject({ isFile: true });
    expect(lstat).not.toHaveBeenCalled();
  });

  it('lstat 失败 → null', async () => {
    const lstat = vi.fn(async () => {
      throw Object.assign(new Error('gone'), { code: 'ENOENT' });
    });
    expect(await realDirentType(kind('link'), 'C:\\x', { platform: 'win32', lstat })).toBeNull();
  });
});
