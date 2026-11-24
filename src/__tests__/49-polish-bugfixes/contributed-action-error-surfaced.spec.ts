// 第二十一轮 P1-AX:贡献式 action(插件/命令)回调抛错必须弹 error toast,不再静默吞。
// 见 README "第二十一轮"。被测:src/lib/run-contributed-action.ts(IconSidebar /
// EditorHeader / CommandPalette / Explorer ContextMenu 共用的统一入口)。

import { describe, it, expect, vi, beforeEach } from 'vitest';

const errorSpy = vi.fn();
vi.mock('@/notifications/notify', () => ({
  notify: { error: (...a: unknown[]) => errorSpy(...a) },
}));

import { runContributedAction, runRegisteredCommand } from '@/lib/run-contributed-action';
import { setLocale } from '@/i18n';
import { PermissionError } from '@/plugins/permissions';

beforeEach(() => {
  errorSpy.mockReset();
  setLocale('en');
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

  it('reject(null) / throw undefined → 仍弹 toast,不在 catch 里二次抛 TypeError', async () => {
    runContributedAction('Null', () => Promise.reject(null));
    await Promise.resolve();
    await Promise.resolve();
    expect(errorSpy).toHaveBeenCalledOnce();
    expect(String(errorSpy.mock.calls[0]?.[0])).toContain('Null: null');
    errorSpy.mockReset();
    expect(() =>
      runContributedAction('Undef', () => {
        throw undefined;
      }),
    ).not.toThrow();
    expect(String(errorSpy.mock.calls[0]?.[0])).toContain('Undef: undefined');
  });

  it('抛非 Error(字符串)→ String() 兜底进 message', () => {
    runContributedAction('Weird', () => {
      throw 'just a string';
    });
    expect(errorSpy).toHaveBeenCalledOnce();
    expect(String(errorSpy.mock.calls[0]?.[0])).toContain('just a string');
  });

  // i18n(I11):抛带 catalog code 的 Error → 按 code 本地化(zh/ko 不看 main raw 英文)。
  it('抛带 catalog code 的 Error(FS_DENIED)→ toast 显本地化文案', () => {
    setLocale('en');
    runContributedAction('Do Thing', () => {
      throw Object.assign(new Error('access denied'), { code: 'FS_DENIED' });
    });
    expect(errorSpy).toHaveBeenCalledOnce();
    // en catalog errors.FS_DENIED = 'Access denied'
    expect(String(errorSpy.mock.calls[0]?.[0])).toContain('Access denied');
  });

  // i18n(I11):PermissionError 默认 message 改英文 → en/ko 不再看到中文「权限 X 未授权」。
  it('抛 PermissionError → toast 英文,不泄漏中文', () => {
    runContributedAction('Plugin Cmd', () => {
      throw new PermissionError('fs');
    });
    expect(errorSpy).toHaveBeenCalledOnce();
    const msg = String(errorSpy.mock.calls[0]?.[0]);
    expect(msg).toContain('Permission denied: fs');
    expect(msg).not.toContain('未授权'); // 不泄漏中文
  });
});

describe('runRegisteredCommand(按 id 从 live registry 重查再执行,race R51)', () => {
  it('已注销的 id → 静默忽略,不调用、不弹 toast', () => {
    const registry = { get: vi.fn(() => undefined) };
    runRegisteredCommand(registry, 'gone.cmd', 'Gone');
    expect(registry.get).toHaveBeenCalledWith('gone.cmd');
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('执行的是 live 查到的 fn;抛错 → toast 带 label', () => {
    const fn = vi.fn(() => {
      throw new Error('boom');
    });
    runRegisteredCommand({ get: () => ({ fn }) }, 'x.cmd', 'Do X');
    expect(fn).toHaveBeenCalledOnce();
    expect(String(errorSpy.mock.calls[0]?.[0])).toContain('Do X: boom');
  });
});
