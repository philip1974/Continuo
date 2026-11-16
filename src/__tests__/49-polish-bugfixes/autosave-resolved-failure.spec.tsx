// @vitest-environment jsdom
// 打磨 P2-BK:saveFile 对普通磁盘错误(EACCES/ENOSPC → main safeHandle 返回 {ok:false})是
// **resolve** 而非 reject。scheduler 此前只在 reject 时走失败路径 → {ok:false} 被当成功,
// onError 不触发、用户无提示。被测:auto-save.ts makeAutoSaveScheduler + useAutoSave 通知文案。
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, cleanup, act } from '@testing-library/react';
import { makeAutoSaveScheduler } from '@/panels/Editor/auto-save';
import { useAutoSave } from '@/panels/Editor/useAutoSave';
import { useEditorStore } from '@/stores/editor.store';
import { notify } from '@/notifications/notify';
import { t } from '@/i18n';
import { isAutoSaveFailed, setAutoSaveFailed } from '@/panels/Editor/autosave-failures';

const fail = { ok: false as const, code: 'FS_DENIED', message: 'writeFile failed: /a.md' };

describe('makeAutoSaveScheduler — resolve 的 {ok:false} 也是失败', () => {
  it('resolve {ok:false} → onError 被调用,参数即该失败结果', async () => {
    const onError = vi.fn();
    const s = makeAutoSaveScheduler(vi.fn().mockResolvedValue(fail), 0, onError);
    s.schedule();
    await s.flush();
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0]?.[0]).toEqual(fail);
  });

  it('连续 resolve {ok:false} → 去重只通知一次;{ok:true} 后重置', async () => {
    const onError = vi.fn();
    const save = vi
      .fn()
      .mockResolvedValueOnce(fail)
      .mockResolvedValueOnce(fail)
      .mockResolvedValueOnce({ ok: true, data: undefined })
      .mockResolvedValueOnce(fail);
    const s = makeAutoSaveScheduler(save, 0, onError);
    for (let i = 0; i < 4; i++) {
      s.schedule();
      await s.flush();
    }
    expect(onError).toHaveBeenCalledTimes(2);
  });

  it('resolve {ok:true} / 非结果值 → 不触发 onError', async () => {
    const onError = vi.fn();
    const save = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, data: undefined })
      .mockResolvedValueOnce(undefined);
    const s = makeAutoSaveScheduler(save, 0, onError);
    for (let i = 0; i < 2; i++) {
      s.schedule();
      await s.flush();
    }
    expect(onError).not.toHaveBeenCalled();
  });
});

function Probe({ saveTab }: { saveTab: (id: string) => Promise<unknown> }) {
  useAutoSave(saveTab, { enabled: true, delayMs: 50 });
  return null;
}

describe('useAutoSave — {ok:false} 失败经 code 本地化提示', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    useEditorStore.setState({
      tabs: [
        { id: '/a.md', filePath: '/a.md', content: 'edited', originalContent: 'orig', dirty: true },
      ],
      activeTabId: '/a.md',
    });
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    cleanup();
  });

  it('FS_DENIED → warn toast 用 errors.FS_DENIED 文案,不露 raw message', async () => {
    const warn = vi.spyOn(notify, 'warn').mockImplementation(() => undefined as never);
    render(<Probe saveTab={async () => fail} />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(80);
    });
    expect(warn).toHaveBeenCalledTimes(1);
    const text = String(warn.mock.calls[0]?.[0]);
    expect(text).toContain(t('errors.FS_DENIED'));
    expect(text).not.toContain('writeFile failed');
  });

  // 复审(dirty-close-confirm):失败态按 tab 记录,关窗计数据此把失败的脏 .md 计入确认;成功后清除。
  it('{ok:false} → 记为该 tab 的 autosave 失败态;之后成功 → 清除', async () => {
    vi.spyOn(notify, 'warn').mockImplementation(() => undefined as never);
    setAutoSaveFailed('/a.md', false);
    let result: unknown = fail;
    render(<Probe saveTab={async () => result} />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(80);
    });
    expect(isAutoSaveFailed('/a.md')).toBe(true);

    result = { ok: true, data: undefined };
    act(() => useEditorStore.getState().updateContent('/a.md', 'edited2'));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(80);
    });
    expect(isAutoSaveFailed('/a.md')).toBe(false);
  });
});
