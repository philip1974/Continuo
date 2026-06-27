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

  it('flush 立即执行 pending 的 saveFile(不等 delay)', async () => {
    const saveFile = vi.fn(async () => true);
    const s = makeAutoSaveScheduler(saveFile, 1000);
    s.schedule();
    expect(saveFile).not.toHaveBeenCalled();
    s.flush();
    await vi.advanceTimersByTimeAsync(0);
    expect(saveFile).toHaveBeenCalledTimes(1);
    // flush 后 timer 已清,delay 到了也不再触发第二次
    await vi.advanceTimersByTimeAsync(1100);
    expect(saveFile).toHaveBeenCalledTimes(1);
  });

  it('flush 无 pending 时 no-op(不产生多余写)', async () => {
    const saveFile = vi.fn(async () => true);
    const s = makeAutoSaveScheduler(saveFile, 100);
    s.flush(); // 从未 schedule
    await vi.advanceTimersByTimeAsync(200);
    expect(saveFile).not.toHaveBeenCalled();
  });

  it('flush 等待「定时器已触发但仍在途」的保存(关窗不丢最后编辑,数据安全 P1)', async () => {
    let resolveSave!: () => void;
    const savePromise = new Promise<void>((r) => {
      resolveSave = r;
    });
    let started = false;
    const saveFile = vi.fn(() => {
      started = true;
      return savePromise;
    });
    const s = makeAutoSaveScheduler(saveFile, 100);
    s.schedule();
    await vi.advanceTimersByTimeAsync(110); // timer fire → runSave 开始,timer=null
    expect(started).toBe(true);
    expect(saveFile).toHaveBeenCalledTimes(1);

    // 此刻保存仍在途;flush() 必须 await 它,而不是 no-op 立即 resolve。
    let flushResolved = false;
    const flushP = s.flush().then(() => {
      flushResolved = true;
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(flushResolved).toBe(false); // 仍在等在途写盘

    resolveSave();
    await flushP;
    expect(flushResolved).toBe(true);
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
