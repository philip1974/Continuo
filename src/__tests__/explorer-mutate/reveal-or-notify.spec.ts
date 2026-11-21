// a11y(A49):revealPathOrNotify —— reveal 失败须给可见+可播报反馈(notify.error),不静默。
import { describe, it, expect, vi, beforeEach } from 'vitest';

const reveal = vi.fn();
vi.mock('@/lib/co-api', () => ({
  coApi: { fs: { reveal: (...a: unknown[]) => reveal(...a) } },
}));
const notifyError = vi.fn();
vi.mock('@/notifications/notify', () => ({
  notify: { error: (...a: unknown[]) => notifyError(...a) },
}));
vi.mock('@/lib/localize-error', () => ({
  localizeErrorByCode: (_code: string, msg: string) => msg,
}));

import { revealPathOrNotify } from '../../panels/Explorer/reveal-or-notify';

beforeEach(() => {
  reveal.mockReset();
  notifyError.mockReset();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

describe('revealPathOrNotify (A49)', () => {
  it('ok=true → 不打扰(无 notify)', async () => {
    reveal.mockResolvedValue({ ok: true, data: undefined });
    await revealPathOrNotify('/a/b');
    expect(reveal).toHaveBeenCalledWith('/a/b');
    expect(notifyError).not.toHaveBeenCalled();
  });

  it('ok=false → notify.error(本地化消息)', async () => {
    reveal.mockResolvedValue({ ok: false, code: 'FS_NOT_FOUND', message: 'gone' });
    await revealPathOrNotify('/a/b');
    expect(notifyError).toHaveBeenCalledTimes(1);
    expect(String(notifyError.mock.calls[0]![0])).toContain('gone');
  });

  // a11y(A145,A141 同族):reveal reject(抛错而非返回 {ok:false})须 catch + notify,不 reject。
  it('reject → notify.error(不抛出)', async () => {
    reveal.mockRejectedValue(Object.assign(new Error('ipc down'), { code: 'EIO' }));
    await expect(revealPathOrNotify('/a/b')).resolves.toBeUndefined();
    expect(notifyError).toHaveBeenCalledTimes(1);
    expect(String(notifyError.mock.calls[0]![0])).toContain('ipc down');
  });
});
