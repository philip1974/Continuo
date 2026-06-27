// BDD: startup-mode (Issue #30)
// 纯函数 pickStartupMode(pendingPaths, isExistingDir) — 决策 dock vs restore。

import { describe, it, expect, vi } from 'vitest';
import { pickStartupMode } from '../../../electron/main/services/startup-mode.service';
import {
  MAX_STARTUP_DIRS,
  MAX_STARTUP_DIR_PATH_LEN,
} from '../../../electron/main/services/cli-args.service';

const allDirs = (_p: string) => true;
const noDirs = (_p: string) => false;

describe('pickStartupMode', () => {
  it('缓冲为空 → restore 模式', () => {
    expect(pickStartupMode([], allDirs)).toEqual({ mode: 'restore' });
  });

  it('缓冲全部非目录 → restore 模式(文件 / 不存在的路径)', () => {
    expect(pickStartupMode(['/x.md', '/missing'], noDirs)).toEqual({
      mode: 'restore',
    });
  });

  it('缓冲有 1 个目录 → dock 模式,dirs 含该路径', () => {
    expect(pickStartupMode(['/proj'], allDirs)).toEqual({
      mode: 'dock',
      dirs: ['/proj'],
    });
  });

  it('多个目录 → dock 模式,保留输入顺序', () => {
    expect(pickStartupMode(['/a', '/b', '/c'], allDirs)).toEqual({
      mode: 'dock',
      dirs: ['/a', '/b', '/c'],
    });
  });

  it('混合目录 + 文件 → dock 模式,只含目录,顺序保留', () => {
    const isDir = (p: string) => p === '/a' || p === '/c';
    expect(pickStartupMode(['/a', '/file.md', '/c'], isDir)).toEqual({
      mode: 'dock',
      dirs: ['/a', '/c'],
    });
  });

  it('重复目录 → 保留第一次出现', () => {
    expect(pickStartupMode(['/a', '/b', '/a'], allDirs)).toEqual({
      mode: 'dock',
      dirs: ['/a', '/b'],
    });
  });

  it('全部路径不存在 → restore 模式(等同空缓冲)', () => {
    expect(pickStartupMode(['/gone1', '/gone2'], noDirs)).toEqual({
      mode: 'restore',
    });
  });

  it('isExistingDir 抛错的路径视为不存在(defensive)', () => {
    const isDir = (p: string) => {
      if (p === '/throws') throw new Error('boom');
      return p === '/ok';
    };
    expect(pickStartupMode(['/throws', '/ok'], isDir)).toEqual({
      mode: 'dock',
      dirs: ['/ok'],
    });
  });

  // 边界(E58,与 pickArgvFolders 同款):目录数封顶 + 超长路径先跳过(不 stat)。
  describe('E58 · 数量/路径长度上限', () => {
    it('目录数超上限 → 封顶到 MAX_STARTUP_DIRS', () => {
      const isDir = vi.fn(() => true);
      const many = Array.from(
        { length: MAX_STARTUP_DIRS + 20 },
        (_, i) => `/d${i}`,
      );
      const r = pickStartupMode(many, isDir);
      expect(r.mode).toBe('dock');
      if (r.mode === 'dock') expect(r.dirs).toHaveLength(MAX_STARTUP_DIRS);
      expect(isDir.mock.calls.length).toBeLessThanOrEqual(MAX_STARTUP_DIRS);
    });

    it('超长路径 → 跳过且不 stat', () => {
      const isDir = vi.fn(() => true);
      const longPath = '/' + 'x'.repeat(MAX_STARTUP_DIR_PATH_LEN);
      const r = pickStartupMode([longPath, '/ok'], isDir);
      expect(r).toEqual({ mode: 'dock', dirs: ['/ok'] });
      expect(isDir).not.toHaveBeenCalledWith(longPath);
    });
  });
});
