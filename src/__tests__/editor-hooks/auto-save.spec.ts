import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { makeAutoSaveScheduler } from '../../panels/Editor/auto-save';

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('makeAutoSaveScheduler', () => {
  it('schedule 一次 → delayMs 后调 saveFile 一次', async () => {
    const saveFile = vi.fn(async () => true);
    const s = makeAutoSaveScheduler(saveFile, 100);
    s.schedule();
    expect(saveFile).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(110);
    expect(saveFile).toHaveBeenCalledTimes(1);
  });

  it('连续 schedule → debounce 合并为 1 次,以最后一次的 delay 为准', async () => {
    const saveFile = vi.fn(async () => true);
    const s = makeAutoSaveScheduler(saveFile, 100);
    s.schedule();
    await vi.advanceTimersByTimeAsync(50);
    s.schedule();
    await vi.advanceTimersByTimeAsync(50); // 第一次累计 100,但被 reset 了
    expect(saveFile).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(60); // 第二次累计 110
    expect(saveFile).toHaveBeenCalledTimes(1);
  });

  it('cancel 后 saveFile 不被调', async () => {
    const saveFile = vi.fn(async () => true);
    const s = makeAutoSaveScheduler(saveFile, 100);
    s.schedule();
    s.cancel();
    await vi.advanceTimersByTimeAsync(200);
    expect(saveFile).not.toHaveBeenCalled();
  });

  it('cancel 后再 schedule 仍工作', async () => {
    const saveFile = vi.fn(async () => true);
    const s = makeAutoSaveScheduler(saveFile, 100);
    s.schedule();
    s.cancel();
    s.schedule();
    await vi.advanceTimersByTimeAsync(110);
    expect(saveFile).toHaveBeenCalledTimes(1);
  });

  it('saveFile 抛错时被吞掉(不污染未来 schedule)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      let call = 0;
      const saveFile = vi.fn(async () => {
        call++;
        if (call === 1) throw new Error('boom');
        return true;
      });
      const s = makeAutoSaveScheduler(saveFile, 100);
      s.schedule();
      await vi.advanceTimersByTimeAsync(110);
      // 关键:第一次抛错没让 scheduler 死掉
      s.schedule();
      await vi.advanceTimersByTimeAsync(110);
      expect(saveFile).toHaveBeenCalledTimes(2);
      expect(warn).toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });
});
