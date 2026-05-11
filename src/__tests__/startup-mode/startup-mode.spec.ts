// BDD: startup-mode (Issue #30)
// 纯函数 pickStartupMode(pendingPaths, isExistingDir) — 决策 dock vs restore。

import { describe, it, expect } from 'vitest';
import { pickStartupMode } from '../../../electron/main/services/startup-mode.service';

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
});
