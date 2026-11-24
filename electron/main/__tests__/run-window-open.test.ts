// 主进程菜单 / Dock 菜单 / open-file / second-instance / 冷启动多目录开新窗口时,分配 windowSeq 要读写
// explorer.json;磁盘满(ENOSPC)/ 无权限(EACCES)会 reject。此前入口全是 `void openXxx()`:用户无任何提示,
// 且产生 unhandled rejection。runWindowOpen 统一兜住:吞掉异常并以本地化文案提示用户。
import { describe, expect, it, vi } from 'vitest';
import { runWindowOpen, type WindowOpenFailureUi } from '../lib/run-window-open';

const CATALOG: Record<string, string> = {
  'menu.file.window_open_failed': '无法打开新窗口',
  'errors.FS_DENIED': '拒绝访问',
  'errors.FS_IO': '文件 I/O 错误',
  'errors.NO_WINDOW_SEQ': '找不到窗口序号',
};

function setup() {
  const showError = vi.fn();
  const ui: WindowOpenFailureUi = {
    t: () => (key) => CATALOG[key] ?? key,
    showError,
  };
  return { ui, showError };
}

function errnoError(code: string, message: string): Error {
  return Object.assign(new Error(message), { code });
}

describe('runWindowOpen', () => {
  it('成功时返回 fn 的结果,不提示', async () => {
    const { ui, showError } = setup();
    await expect(runWindowOpen(async () => 42, ui)).resolves.toBe(42);
    expect(showError).not.toHaveBeenCalled();
  });

  it('EACCES:不抛,以本地化标题 + 「拒绝访问」提示', async () => {
    const { ui, showError } = setup();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const err = errnoError('EACCES', "EACCES: permission denied, open '/u/explorer.json'");
    await expect(runWindowOpen(() => Promise.reject(err), ui)).resolves.toBeUndefined();
    expect(showError).toHaveBeenCalledTimes(1);
    const [message, detail] = showError.mock.calls[0]!;
    expect(message).toBe('无法打开新窗口');
    expect(detail).toContain('拒绝访问');
    warn.mockRestore();
  });

  it('ENOSPC:归为文件 I/O 错误,并附原始错误文本(区分磁盘满)', async () => {
    const { ui, showError } = setup();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const err = errnoError('ENOSPC', 'ENOSPC: no space left on device, write');
    await runWindowOpen(() => Promise.reject(err), ui);
    const [, detail] = showError.mock.calls[0]!;
    expect(detail).toContain('文件 I/O 错误');
    expect(detail).toContain('ENOSPC: no space left on device');
    warn.mockRestore();
  });

  it('带已收录业务错误码的异常按 errors.<CODE> 本地化', async () => {
    const { ui, showError } = setup();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await runWindowOpen(() => Promise.reject(errnoError('NO_WINDOW_SEQ', 'no seq')), ui);
    expect(showError.mock.calls[0]![1]).toContain('找不到窗口序号');
    warn.mockRestore();
  });

  it('fn 同步抛出 / 抛非 Error 值也不外泄', async () => {
    const { ui, showError } = setup();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await expect(
      runWindowOpen(() => {
        throw null;
      }, ui),
    ).resolves.toBeUndefined();
    expect(showError).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it('提示本身抛错也不外泄', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const ui: WindowOpenFailureUi = {
      t: () => (key) => key,
      showError: () => {
        throw new Error('dialog gone');
      },
    };
    await expect(
      runWindowOpen(() => Promise.reject(new Error('x')), ui),
    ).resolves.toBeUndefined();
    warn.mockRestore();
  });
});
