// a11y(A147):openRecentRootOrNotify —— 点最近目录前 listDir 校验,失效则 notify.error 不切 root。
import { describe, it, expect, vi, beforeEach } from 'vitest';

const listDir = vi.fn();
vi.mock('@/lib/co-api', () => ({
  coApi: { fs: { listDir: (...a: unknown[]) => listDir(...a) } },
}));
const notifyError = vi.fn();
vi.mock('@/notifications/notify', () => ({
  notify: { error: (...a: unknown[]) => notifyError(...a) },
}));
vi.mock('@/lib/localize-error', () => ({
  localizeErrorByCode: (_code: string, msg: string) => msg,
}));

import { openRecentRootOrNotify } from '../../panels/Explorer/open-recent-root';

beforeEach(() => {
  listDir.mockReset();
  notifyError.mockReset();
});

describe('openRecentRootOrNotify (A147)', () => {
  it('listDir ok → setRoot(path),不 notify', async () => {
    listDir.mockResolvedValue({ ok: true, data: [] });
    const setRoot = vi.fn();
    await openRecentRootOrNotify('/proj', setRoot);
    expect(setRoot).toHaveBeenCalledWith('/proj');
    expect(notifyError).not.toHaveBeenCalled();
  });

  it('listDir {ok:false} → notify.error 不 setRoot', async () => {
    listDir.mockResolvedValue({ ok: false, code: 'FS_NOT_FOUND', message: 'gone' });
    const setRoot = vi.fn();
    await openRecentRootOrNotify('/stale', setRoot);
    expect(setRoot).not.toHaveBeenCalled();
    expect(notifyError).toHaveBeenCalledTimes(1);
    expect(String(notifyError.mock.calls[0]![0])).toContain('gone');
  });

  it('listDir reject → notify.error 不 setRoot(不抛)', async () => {
    listDir.mockRejectedValue(Object.assign(new Error('ipc down'), { code: 'EIO' }));
    const setRoot = vi.fn();
    await expect(openRecentRootOrNotify('/x', setRoot)).resolves.toBeUndefined();
    expect(setRoot).not.toHaveBeenCalled();
    expect(notifyError).toHaveBeenCalledTimes(1);
    expect(String(notifyError.mock.calls[0]![0])).toContain('ipc down');
  });

  // race(R19,R18 同族):连点最近目录 A→B,A 的 listDir 迟到成功不得乱序覆盖后选的 B(latest 守卫)。
  it('R19 连点 A→B,A 探测迟到 resolve → 只 setRoot(B)', async () => {
    let resolveA!: (v: unknown) => void;
    let resolveB!: (v: unknown) => void;
    listDir.mockImplementation((p: string) =>
      p === '/A'
        ? new Promise((res) => {
            resolveA = res;
          })
        : new Promise((res) => {
            resolveB = res;
          }),
    );
    const setRoot = vi.fn();

    const pA = openRecentRootOrNotify('/A', setRoot); // 先发起
    const pB = openRecentRootOrNotify('/B', setRoot); // 后发起 = 最新

    resolveB({ ok: true, data: [] }); // B 先 resolve → setRoot(B)
    await pB;
    resolveA({ ok: true, data: [] }); // A 后 resolve(过期)→ 不 setRoot
    await pA;

    expect(setRoot).toHaveBeenCalledTimes(1);
    expect(setRoot).toHaveBeenCalledWith('/B');
  });
});
