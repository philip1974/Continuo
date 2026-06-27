// 边界(E173,E168-E172 同族 IPC ingress 纵深防御):fs:dir-changed payload 形态守卫。
// preload onDirChanged 复用本守卫,畸形 payload drop 不下传脏 path 给 Explorer watcher/外部同步。
import { describe, it, expect } from 'vitest';
import { isFsDirChangedPayload } from '../../../electron/shared/fs-channels';

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
