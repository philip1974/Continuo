// 边界(E173,E168-E172 同族 IPC ingress 纵深防御):fs:dir-changed payload 形态守卫。
// preload onDirChanged 复用本守卫,畸形 payload drop 不下传脏 path 给 Explorer watcher/外部同步。
import { describe, it, expect } from 'vitest';
import {
  isFsDirChangedPayload,
  readFsDirChangedChangeOnly,
  readFsDirChangedFiles,
  type FsDirChangedPayload,
} from '../../../electron/shared/fs-channels';

const MAX = 8192; // FS_PATH_MAX

describe('isFsDirChangedPayload (E173)', () => {
  it('合规 { path: string } → true', () => {
    expect(isFsDirChangedPayload({ path: '/repo/src' })).toBe(true);
    expect(isFsDirChangedPayload({ path: '' })).toBe(true); // 空 path 合法(根/相对)
    expect(isFsDirChangedPayload({ path: 'a'.repeat(MAX) })).toBe(true); // 恰好上限
  });

  it('null / 非对象 / 数组 → false', () => {
    expect(isFsDirChangedPayload(null)).toBe(false);
    expect(isFsDirChangedPayload(undefined)).toBe(false);
    expect(isFsDirChangedPayload('a string')).toBe(false);
    expect(isFsDirChangedPayload(42)).toBe(false);
    expect(isFsDirChangedPayload(['/p'])).toBe(false);
  });

  it('path 非字符串 → false', () => {
    expect(isFsDirChangedPayload({ path: 123 })).toBe(false);
    expect(isFsDirChangedPayload({ path: null })).toBe(false);
    expect(isFsDirChangedPayload({ path: {} })).toBe(false);
    expect(isFsDirChangedPayload({})).toBe(false); // 缺 path
  });

  it('path 超长 → false', () => {
    expect(isFsDirChangedPayload({ path: 'a'.repeat(MAX + 1) })).toBe(false);
  });
});

// 性能:payload 可选携带变更文件名集合 files;畸形/超限 → undefined(退化为目录级,不丢整条事件)。
describe('readFsDirChangedFiles', () => {
  it('缺省 files → undefined;合规字符串数组 → 原样返回', () => {
    expect(readFsDirChangedFiles({ path: '/p' }, 4)).toBeUndefined();
    expect(readFsDirChangedFiles({ path: '/p', files: ['a.md', 'b'] }, 4)).toEqual([
      'a.md',
      'b',
    ]);
  });

  it('非数组 / 含非字符串 / 单项超长 / 数量超上限 → undefined(退化)', () => {
    // 畸形 IPC payload:path 合规但 files 类型不对(绕过静态类型)
    const bad = (files: unknown) => ({ path: '/p', files }) as unknown as FsDirChangedPayload;
    expect(readFsDirChangedFiles(bad('a.md'), 4)).toBeUndefined();
    expect(readFsDirChangedFiles(bad(['a', 1]), 4)).toBeUndefined();
    expect(
      readFsDirChangedFiles({ path: '/p', files: ['a'.repeat(MAX + 1)] }, 4),
    ).toBeUndefined();
    expect(
      readFsDirChangedFiles({ path: '/p', files: ['1', '2', '3', '4', '5'] }, 4),
    ).toBeUndefined();
  });
});

// 性能:payload 可选 changeOnly(仅内容变化,目录列表不变);仅严格 true 生效,缺省 / 畸形 → false。
describe('readFsDirChangedChangeOnly', () => {
  it('仅 changeOnly === true 时为 true', () => {
    expect(readFsDirChangedChangeOnly({ path: '/p', changeOnly: true })).toBe(true);
    expect(readFsDirChangedChangeOnly({ path: '/p' })).toBe(false);
    expect(readFsDirChangedChangeOnly({ path: '/p', changeOnly: false })).toBe(false);
    const bad = { path: '/p', changeOnly: 'true' } as unknown as FsDirChangedPayload;
    expect(readFsDirChangedChangeOnly(bad)).toBe(false);
  });
});
