// 第二十一轮 P1-AZ:auto-save 失败必须给用户反馈(经 onError),但去重 —— 连续失败
// 只通知一次,一次成功后重置。数据不丢(dirty 保持),onError 仅补"为何脏点不消"的反馈。
// 见 README "第二十一轮"。被测:src/panels/Editor/auto-save.ts makeAutoSaveScheduler。

import { describe, it, expect, vi } from 'vitest';
import { makeAutoSaveScheduler } from '@/panels/Editor/auto-save';

// flush() 同步触发 runSave 并返回其 Promise,便于断言异步结果。
describe('makeAutoSaveScheduler onError(去重通知)', () => {
  it('保存失败 → onError 被调用一次,含 error', async () => {
    const onError = vi.fn();
    const save = vi.fn().mockRejectedValue(new Error('disk full'));
    const s = makeAutoSaveScheduler(save, 0, onError);
    s.schedule();
    await s.flush(); // flush 在 schedule 后清 timer 并跑 runSave
    // schedule 的 setTimeout(0) 与 flush 各跑一次;等微任务结算
    await new Promise((r) => setTimeout(r, 5));
    expect(onError).toHaveBeenCalled();
    expect(onError.mock.calls[0]?.[0]).toBeInstanceOf(Error);
  });

  it('连续多次失败 → onError 只触发一次(去重防刷屏)', async () => {
    const onError = vi.fn();
    const save = vi.fn().mockRejectedValue(new Error('still failing'));
    const s = makeAutoSaveScheduler(save, 0, onError);
    for (let i = 0; i < 3; i++) {
      s.schedule();
      await s.flush();
      await new Promise((r) => setTimeout(r, 5));
    }
    expect(save).toHaveBeenCalledTimes(3);
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it('失败后成功再失败 → onError 重置,第二次失败再通知', async () => {
    const onError = vi.fn();
    const save = vi
      .fn()
      .mockRejectedValueOnce(new Error('fail 1'))
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('fail 2'));
    const s = makeAutoSaveScheduler(save, 0, onError);
    for (let i = 0; i < 3; i++) {
      s.schedule();
      await s.flush();
      await new Promise((r) => setTimeout(r, 5));
    }
    expect(onError).toHaveBeenCalledTimes(2);
  });

  it('保存成功 → onError 不触发', async () => {
    const onError = vi.fn();
    const save = vi.fn().mockResolvedValue(undefined);
    const s = makeAutoSaveScheduler(save, 0, onError);
    s.schedule();
    await s.flush();
    await new Promise((r) => setTimeout(r, 5));
    expect(onError).not.toHaveBeenCalled();
  });

  it('不传 onError(向后兼容)→ 失败仅 swallow,不抛', async () => {
    const save = vi.fn().mockRejectedValue(new Error('boom'));
    const s = makeAutoSaveScheduler(save, 0);
    s.schedule();
    await expect(s.flush()).resolves.toBeUndefined();
  });
});
