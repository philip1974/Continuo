// @vitest-environment jsdom
// 可维护性 M1:terminal.new(命令面板)与 Dock header 新建终端入口曾复制同一段创建流程,
// 抽到 createUserTerminal 单一来源。本规范直接锁定该 helper 的行为契约(两消费方共用),
// 后续改终端创建契约只需改一处 + 看这一份测试。
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  create: vi.fn(),
  getState: vi.fn(() => ({ root: null as string | null })),
  waitHydrated: vi.fn(() => Promise.resolve()),
  notifyError: vi.fn(),
  notifyInfo: vi.fn(),
  runCommand: vi.fn(),
  setPendingFocus: vi.fn(),
  preloadChunk: vi.fn(),
}));

vi.mock('@/lib/co-api', () => ({
  coApi: { terminal: { create: mocks.create } },
}));
vi.mock('@/lib/terminal-chunk-warmup', () => ({
  preloadTerminalPanelChunk: mocks.preloadChunk,
}));
vi.mock('@/notifications/notify', () => ({
  notify: { error: mocks.notifyError, info: mocks.notifyInfo },
}));
vi.mock('@/lib/run-contributed-action', () => ({
  runRegisteredCommand: mocks.runCommand,
}));
vi.mock('@/stores/workspace.store', () => ({
  useWorkspaceStore: { getState: mocks.getState },
  waitForWorkspaceRootRestored: mocks.waitHydrated,
}));
vi.mock('@/shell/dock/DockReconciler', () => ({
  setPendingFocus: mocks.setPendingFocus,
}));

import { createUserTerminal } from '@/shell/dock/create-user-terminal';
import { t } from '@/i18n';

beforeEach(() => {
  Object.values(mocks).forEach((m) => m.mockReset?.());
  mocks.getState.mockReturnValue({ root: null });
  mocks.waitHydrated.mockResolvedValue(undefined);
});

describe('createUserTerminal — 共用创建流程', () => {
  it('先 await root 恢复(rootRestored),再读 root 当 cwd/workspaceRoot 调 create', async () => {
    mocks.getState.mockReturnValue({ root: '/repo' });
    mocks.create.mockResolvedValue({ ok: true, data: { id: 'term-1' } });

    const id = await createUserTerminal();

    expect(mocks.waitHydrated).toHaveBeenCalled();
    expect(mocks.create).toHaveBeenCalledWith({
      originHint: 'user',
      cwd: '/repo',
      workspaceRoot: '/repo',
      env: { COLORFGBG: '0;15' }, // 测试环境 <html> 无 .dark → 浅色
    });
    expect(id).toBe('term-1');
    expect(mocks.setPendingFocus).toHaveBeenCalledWith('term-1');
  });

  // Explorer「在终端中打开」同走本流程:cwd 设到所选目录(归属仍是 workspace root)。所有新建入口按当前主题带
  // COLORFGBG(P10k 等 prompt 框架据此判断背景亮度;此前只有 Explorer 入口带)。
  it('传入 cwd → create 用该 cwd,workspaceRoot 仍取 workspace root;COLORFGBG 跟随 <html>.dark', async () => {
    mocks.getState.mockReturnValue({ root: '/repo' });
    mocks.create.mockResolvedValue({ ok: true, data: { id: 'term-2' } });
    document.documentElement.classList.add('dark');
    try {
      await createUserTerminal({ cwd: '/repo/sub' });
    } finally {
      document.documentElement.classList.remove('dark');
    }

    expect(mocks.create).toHaveBeenCalledWith({
      originHint: 'user',
      cwd: '/repo/sub',
      workspaceRoot: '/repo',
      env: { COLORFGBG: '15;0' },
    });
    expect(mocks.setPendingFocus).toHaveBeenCalledWith('term-2');
  });

  it('Phase-5 · 调 IPC create 前先 fire 预取 Terminal chunk(与 create 并行抢跑)', async () => {
    mocks.create.mockResolvedValue({ ok: true, data: { id: 'term-1' } });

    await createUserTerminal();

    expect(mocks.preloadChunk).toHaveBeenCalledOnce();
    // 预取必须在 create 之前发起(才能与 create 往返/PTY spawn 并行)
    expect(mocks.preloadChunk.mock.invocationCallOrder[0]!).toBeLessThan(
      mocks.create.mock.invocationCallOrder[0]!,
    );
  });

  it('root 为 null → create 不带 cwd/workspaceRoot(仅 originHint)', async () => {
    mocks.getState.mockReturnValue({ root: null });
    mocks.create.mockResolvedValue({ ok: true, data: { id: 'term-2' } });

    await createUserTerminal();

    expect(mocks.create).toHaveBeenCalledWith({ originHint: 'user', env: { COLORFGBG: '0;15' } });
  });

  // 无工作区(未传 cwd)不是错误:直接调起「打开文件夹」命令并**等它完成**(保留用户意图,VSCode 心智:缺前置条件时给出
  // 下一步,完成后接着做原来的事)。选定文件夹 → 立即在新 root 新建终端,不留「请先打开文件夹」提示;取消 → 不建终端,
  // info 提示「请先打开一个文件夹」。notify 无撤销(dismiss)能力 → 不先弹提示,只在取消时提示。Continuo 刻意不回退主目录。
  it('无工作区 → 调起打开文件夹;取消对话框 → 不建终端,info 提示先打开文件夹,返 null 不 focus', async () => {
    mocks.create.mockResolvedValue({ ok: false, code: 'TERMINAL_CWD_UNRESOLVED' });
    let resolveDialog: () => void = () => {};
    mocks.runCommand.mockReturnValue(new Promise<void>((r) => (resolveDialog = r)));

    const pending = createUserTerminal();
    await vi.waitFor(() => expect(mocks.runCommand).toHaveBeenCalledOnce());
    expect(mocks.runCommand.mock.calls[0]?.[1]).toBe('workbench.action.files.openFolder');
    // 对话框打开期间不先弹提示(选定后无法撤掉,会一直挂着)
    expect(mocks.notifyInfo).not.toHaveBeenCalled();
    resolveDialog(); // 用户取消:root 仍为 null
    const id = await pending;

    expect(id).toBeNull();
    expect(mocks.create).toHaveBeenCalledOnce();
    expect(mocks.notifyError).not.toHaveBeenCalled();
    expect(mocks.notifyInfo).toHaveBeenCalledOnce();
    expect(mocks.notifyInfo.mock.calls[0]?.[0]).toBe(t('errors.terminal.cwd_unresolved'));
    expect(mocks.setPendingFocus).not.toHaveBeenCalled();
  });

  it('无工作区 → 对话框选定文件夹后立即在新 root 新建终端并聚焦,不弹「请先打开文件夹」', async () => {
    mocks.create
      .mockResolvedValueOnce({ ok: false, code: 'TERMINAL_CWD_UNRESOLVED' })
      .mockResolvedValueOnce({ ok: true, data: { id: 'term-9' } });
    mocks.runCommand.mockImplementation(async () => {
      mocks.getState.mockReturnValue({ root: '/picked' });
    });

    const id = await createUserTerminal();

    expect(id).toBe('term-9');
    expect(mocks.create).toHaveBeenCalledTimes(2);
    expect(mocks.create.mock.calls[1]?.[0]).toMatchObject({ cwd: '/picked', workspaceRoot: '/picked' });
    expect(mocks.setPendingFocus).toHaveBeenCalledWith('term-9');
    expect(mocks.notifyInfo).not.toHaveBeenCalled();
    expect(mocks.notifyError).not.toHaveBeenCalled();
    expect(mocks.runCommand).toHaveBeenCalledOnce();
  });

  // 对话框打开期间再按 ⌘T(或 ⌘O 已弹出目录选择器时按 ⌘T):VSCode 的原生对话框是模态,这次按键根本到不了工作台。
  // 对齐:目录选择器已在途 → 本次静默放弃(不弹「请先打开一个文件夹」、不再调起对话框);选定后只由第一次新建 1 个终端。
  it('目录选择器已打开时再次新建 → 静默返回 null,不提示、不重复调起;第一次选定后只建 1 个终端', async () => {
    const lock = await import('@/lib/select-directory-single-flight');
    lock.__resetSelectDirectoryLockForTest();
    mocks.create
      .mockResolvedValueOnce({ ok: false, code: 'TERMINAL_CWD_UNRESOLVED' })
      .mockResolvedValueOnce({ ok: false, code: 'TERMINAL_CWD_UNRESOLVED' })
      .mockResolvedValueOnce({ ok: true, data: { id: 'term-1' } });
    let finishDialog: () => void = () => {};
    // 打开文件夹命令:持目录选择器单飞锁直到用户选定
    mocks.runCommand.mockImplementation(() => {
      if (!lock.trySelectDirectoryLock()) return Promise.resolve();
      return new Promise<void>((resolve) => {
        finishDialog = () => {
          mocks.getState.mockReturnValue({ root: '/picked' });
          lock.releaseSelectDirectoryLock();
          resolve();
        };
      });
    });

    const first = createUserTerminal();
    await vi.waitFor(() => expect(mocks.runCommand).toHaveBeenCalledOnce());
    const second = await createUserTerminal(); // 对话框仍开着

    expect(second).toBeNull();
    expect(mocks.notifyInfo).not.toHaveBeenCalled();
    expect(mocks.notifyError).not.toHaveBeenCalled();
    expect(mocks.runCommand).toHaveBeenCalledOnce();

    finishDialog();
    expect(await first).toBe('term-1');
    expect(mocks.create).toHaveBeenCalledTimes(3);
    expect(mocks.setPendingFocus).toHaveBeenCalledOnce();
    expect(mocks.notifyInfo).not.toHaveBeenCalled();
  });

  it('三语文案统一为「先打开一个文件夹」(与资源管理器「打开文件夹」用语一致)', async () => {
    const { en } = await import('../../../electron/shared/i18n-locales/en');
    const { zh } = await import('../../../electron/shared/i18n-locales/zh');
    const { ko } = await import('../../../electron/shared/i18n-locales/ko');
    expect(zh['errors.terminal.cwd_unresolved']).toContain('文件夹');
    expect(en['errors.terminal.cwd_unresolved']).toMatch(/folder/i);
    expect(ko['errors.terminal.cwd_unresolved']).toContain('폴더');
    for (const d of [en, zh, ko]) expect(d['errors.terminal.cwd_unresolved']).not.toMatch(/workspace|工作区|워크스페이스/i);
  });

  // 传了 cwd(root 被外部删除 / Explorer「在终端中打开」已删目录)时 main 同返 CWD_UNRESOLVED:不能提示「请先打开工作区」。
  it('传入 cwd 时 CWD_UNRESOLVED → 提示目录不存在(带路径),不提示先打开 workspace', async () => {
    mocks.create.mockResolvedValue({ ok: false, code: 'TERMINAL_CWD_UNRESOLVED' });

    expect(await createUserTerminal({ cwd: '/gone/dir' })).toBeNull();
    const msg = String(mocks.notifyError.mock.calls[0]?.[0]);
    expect(msg).toContain('/gone/dir');
    expect(msg).not.toContain('workspace');
    expect(mocks.runCommand).not.toHaveBeenCalled();
  });

  it('通用失败 → notify.error 带 code + 返 null', async () => {
    mocks.create.mockResolvedValue({ ok: false, code: 'OTHER' });

    const id = await createUserTerminal();

    expect(id).toBeNull();
    expect(mocks.notifyError).toHaveBeenCalledWith(
      expect.stringContaining('OTHER'),
      expect.objectContaining({ code: 'OTHER' }),
    );
  });

  // 终审 P1:退出清理开始后 main 以 TERMINAL_CREATE_CANCELLED 拒绝新建(退出闸)。IPC 以 {ok:false} 返回该码;
  // 窗口已隐藏,这不是用户可处理的失败 → 与 reject 路径一致静默,不弹错误。
  it('{ok:false, TERMINAL_CREATE_CANCELLED}(退出闸拒绝)→ 静默返 null,不 notify', async () => {
    mocks.create.mockResolvedValue({ ok: false, code: 'TERMINAL_CREATE_CANCELLED' });

    const id = await createUserTerminal();

    expect(id).toBeNull();
    expect(mocks.notifyError).not.toHaveBeenCalled();
    expect(mocks.setPendingFocus).not.toHaveBeenCalled();
  });

  // a11y(A116,A50/A115 同族):coApi.terminal.create promise reject(IPC 异常)须被捕获,
  // notify.error + 返 null,不让异常经调用点 void 蒸发(用户点新建终端无反馈)。
  it('create promise reject(IPC 异常)→ notify.error + 返 null,不 focus', async () => {
    mocks.create.mockRejectedValue(new Error('ipc down'));

    const id = await createUserTerminal();

    expect(id).toBeNull();
    expect(mocks.notifyError).toHaveBeenCalledOnce();
    expect(mocks.setPendingFocus).not.toHaveBeenCalled();
  });

  it('成功但无 id → 返 null,不 focus', async () => {
    mocks.create.mockResolvedValue({ ok: true, data: {} });

    const id = await createUserTerminal();

    expect(id).toBeNull();
    expect(mocks.setPendingFocus).not.toHaveBeenCalled();
  });
});
