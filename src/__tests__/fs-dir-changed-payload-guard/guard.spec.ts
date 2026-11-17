// 边界(E173,E168-E172 同族 IPC ingress 纵深防御):fs:dir-changed payload 形态守卫。
// preload onDirChanged 复用本守卫,畸形 payload drop 不下传脏 path 给 Explorer watcher/外部同步。
import { describe, it, expect } from 'vitest';
import {
  isFsDirChangedPayload,
  readFsDirChangedFiles,
  type FsDirChangedPayload,
} from '../../../electron/shared/fs-channels';

const MAX = 8192; // FS_PATH_MAX

describe('isFsDirChangedPayload (E173)', () => {
  it('合规 { path: string } → true', () => {
    expect(isFsDirChangedPayload({ path: '/repo/src' }, MAX)).toBe(true);
    expect(isFsDirChangedPayload({ path: '' }, MAX)).toBe(true); // 空 path 合法(根/相对)
    expect(isFsDirChangedPayload({ path: 'a'.repeat(MAX) }, MAX)).toBe(true); // 恰好上限
  });

  it('null / 非对象 / 数组 → false', () => {
    expect(isFsDirChangedPayload(null, MAX)).toBe(false);
    expect(isFsDirChangedPayload(undefined, MAX)).toBe(false);
    expect(isFsDirChangedPayload('a string', MAX)).toBe(false);
    expect(isFsDirChangedPayload(42, MAX)).toBe(false);
    expect(isFsDirChangedPayload(['/p'], MAX)).toBe(false);
  });

  it('path 非字符串 → false', () => {
    expect(isFsDirChangedPayload({ path: 123 }, MAX)).toBe(false);
    expect(isFsDirChangedPayload({ path: null }, MAX)).toBe(false);
    expect(isFsDirChangedPayload({ path: {} }, MAX)).toBe(false);
    expect(isFsDirChangedPayload({}, MAX)).toBe(false); // 缺 path
  });

  it('path 超长 → false', () => {
    expect(isFsDirChangedPayload({ path: 'a'.repeat(MAX + 1) }, MAX)).toBe(false);
  });
});

// 性能:payload 可选携带变更文件名集合 files;畸形/超限 → undefined(退化为目录级,不丢整条事件)。
describe('readFsDirChangedFiles', () => {
  it('缺省 files → undefined;合规字符串数组 → 原样返回', () => {
    expect(readFsDirChangedFiles({ path: '/p' }, 4, MAX)).toBeUndefined();
    expect(readFsDirChangedFiles({ path: '/p', files: ['a.md', 'b'] }, 4, MAX)).toEqual([
      'a.md',
      'b',
    ]);
  });

  it('非数组 / 含非字符串 / 单项超长 / 数量超上限 → undefined(退化)', () => {
    // 畸形 IPC payload:path 合规但 files 类型不对(绕过静态类型)
    const bad = (files: unknown) => ({ path: '/p', files }) as unknown as FsDirChangedPayload;
    expect(readFsDirChangedFiles(bad('a.md'), 4, MAX)).toBeUndefined();
    expect(readFsDirChangedFiles(bad(['a', 1]), 4, MAX)).toBeUndefined();
    expect(
      readFsDirChangedFiles({ path: '/p', files: ['a'.repeat(MAX + 1)] }, 4, MAX),
    ).toBeUndefined();
    expect(
      readFsDirChangedFiles({ path: '/p', files: ['1', '2', '3', '4', '5'] }, 4, MAX),
    ).toBeUndefined();
  });
});
