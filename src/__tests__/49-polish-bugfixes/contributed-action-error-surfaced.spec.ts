// 第二十一轮 P1-AX:贡献式 action(插件/命令)回调抛错必须弹 error toast,不再静默吞。
// 见 README "第二十一轮"。被测:src/lib/run-contributed-action.ts(IconSidebar /
// EditorHeader / CommandPalette / Explorer ContextMenu 共用的统一入口)。

import { describe, it, expect, vi, beforeEach } from 'vitest';

const errorSpy = vi.fn();
vi.mock('@/notifications/notify', () => ({
  notify: { error: (...a: unknown[]) => errorSpy(...a) },
}));

import { runContributedAction } from '@/lib/run-contributed-action';

beforeEach(() => {
  errorSpy.mockReset();
});

describe('runContributedAction', () => {
  it('同步 throw(Error)→ 弹 error toast,含 label + message', () => {
    runContributedAction('Format Document', () => {
      throw new Error('boom');
    });
    expect(errorSpy).toHaveBeenCalledOnce();
    expect(String(errorSpy.mock.calls[0]?.[0])).toContain('Format Document');
    expect(String(errorSpy.mock.calls[0]?.[0])).toContain('boom');
  });

  it('async reject → 弹 error toast(等微任务)', async () => {
    runContributedAction('Run Lint', () => Promise.reject(new Error('lint died')));
    expect(errorSpy).not.toHaveBeenCalled(); // reject 还没结算
    await Promise.resolve();
    await Promise.resolve();
    expect(errorSpy).toHaveBeenCalledOnce();
    expect(String(errorSpy.mock.calls[0]?.[0])).toContain('Run Lint');
    expect(String(errorSpy.mock.calls[0]?.[0])).toContain('lint died');
  });

  it('同步成功 → 不弹', () => {
    runContributedAction('OK', () => undefined);
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('async resolve → 不弹', async () => {
    runContributedAction('OK async', () => Promise.resolve(42));
    await Promise.resolve();
    await Promise.resolve();
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('抛非 Error(字符串)→ String() 兜底进 message', () => {
    runContributedAction('Weird', () => {
      throw 'just a string';
    });
    expect(errorSpy).toHaveBeenCalledOnce();
    expect(String(errorSpy.mock.calls[0]?.[0])).toContain('just a string');
  });
});
