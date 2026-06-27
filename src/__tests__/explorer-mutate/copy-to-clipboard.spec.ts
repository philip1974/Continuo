// a11y(A48):copyToClipboardOrNotify —— 写剪贴板失败须给可见+可播报反馈(notify.error),不静默。
import { describe, it, expect, vi, beforeEach } from 'vitest';

const writeText = vi.fn();
vi.mock('@/plugins/sandbox-sweep', () => ({
  getCachedClipboard: () => ({ writeText }),
}));
const notifyError = vi.fn();
vi.mock('@/notifications/notify', () => ({
  notify: { error: (...a: unknown[]) => notifyError(...a) },
}));

import { copyToClipboardOrNotify } from '../../panels/Explorer/copy-to-clipboard';

beforeEach(() => {
  writeText.mockReset();
  notifyError.mockReset();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

describe('copyToClipboardOrNotify (A48)', () => {
  it('写成功 → 不打扰(无 notify)', async () => {
    writeText.mockResolvedValue(undefined);
    await copyToClipboardOrNotify('/a/b', '复制失败');
    expect(writeText).toHaveBeenCalledWith('/a/b');
    expect(notifyError).not.toHaveBeenCalled();
  });

  it('写失败(reject)→ notify.error(本地化失败文案)', async () => {
    writeText.mockRejectedValue(new Error('denied'));
    await copyToClipboardOrNotify('/a/b', '复制路径到剪贴板失败');
    expect(notifyError).toHaveBeenCalledTimes(1);
    expect(notifyError).toHaveBeenCalledWith('复制路径到剪贴板失败');
  });
});
