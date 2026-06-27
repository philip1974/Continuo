// race(R106,R8 同族):打开系统目录选择器的同步单飞闸门 —— 防同 tick 重复触发并发弹多个原生对话框。
import { describe, it, expect, beforeEach } from 'vitest';
import {
  trySelectDirectoryLock,
  releaseSelectDirectoryLock,
  __resetSelectDirectoryLockForTest,
} from '@/lib/select-directory-single-flight';

beforeEach(() => {
  __resetSelectDirectoryLockForTest();
});

describe('select-directory single-flight 闸门(R106)', () => {
  it('首次取锁成功,在途时再取失败', () => {
    expect(trySelectDirectoryLock()).toBe(true);
    expect(trySelectDirectoryLock()).toBe(false);
    expect(trySelectDirectoryLock()).toBe(false);
  });

  it('释放后可再次取锁', () => {
    expect(trySelectDirectoryLock()).toBe(true);
    releaseSelectDirectoryLock();
    expect(trySelectDirectoryLock()).toBe(true);
  });

  it('同 tick 连续 N 次取锁只有第一次成功(并发弹窗被挡)', () => {
    const results = Array.from({ length: 5 }, () => trySelectDirectoryLock());
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(results[0]).toBe(true);
  });
});
