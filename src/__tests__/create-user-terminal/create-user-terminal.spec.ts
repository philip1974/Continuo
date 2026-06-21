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
  setPendingFocus: vi.fn(),
}));

vi.mock('@/lib/co-api', () => ({
  coApi: { terminal: { create: mocks.create } },
}));
vi.mock('@/notifications/notify', () => ({
  notify: { error: mocks.notifyError },
}));
vi.mock('@/stores/workspace.store', () => ({
  useWorkspaceStore: { getState: mocks.getState },
  waitForWorkspaceHydrated: mocks.waitHydrated,
}));
vi.mock('@/shell/dock/DockReconciler', () => ({
  setPendingFocus: mocks.setPendingFocus,
}));

import { createUserTerminal } from '@/shell/dock/create-user-terminal';

beforeEach(() => {
  Object.values(mocks).forEach((m) => m.mockReset?.());
  mocks.getState.mockReturnValue({ root: null });
  mocks.waitHydrated.mockResolvedValue(undefined);
});

describe('createUserTerminal — 共用创建流程', () => {
  it('先 await hydrate,再读 root 当 cwd/workspaceRoot 调 create', async () => {
    mocks.getState.mockReturnValue({ root: '/repo' });
    mocks.create.mockResolvedValue({ ok: true, data: { id: 'term-1' } });

    const id = await createUserTerminal();

    expect(mocks.waitHydrated).toHaveBeenCalled();
    expect(mocks.create).toHaveBeenCalledWith({
      originHint: 'user',
      cwd: '/repo',
      workspaceRoot: '/repo',
    });
    expect(id).toBe('term-1');
    expect(mocks.setPendingFocus).toHaveBeenCalledWith('term-1');
  });

  it('root 为 null → create 不带 cwd/workspaceRoot(仅 originHint)', async () => {
    mocks.getState.mockReturnValue({ root: null });
    mocks.create.mockResolvedValue({ ok: true, data: { id: 'term-2' } });

    await createUserTerminal();

    expect(mocks.create).toHaveBeenCalledWith({ originHint: 'user' });
  });

  it('CWD_UNRESOLVED 失败 → notify.error workspace 引导 + 返 null,不 focus', async () => {
    mocks.create.mockResolvedValue({ ok: false, code: 'TERMINAL_CWD_UNRESOLVED' });

    const id = await createUserTerminal();

    expect(id).toBeNull();
    expect(mocks.notifyError).toHaveBeenCalledOnce();
    expect(mocks.notifyError.mock.calls[0]?.[0]).toContain('workspace');
    expect(mocks.setPendingFocus).not.toHaveBeenCalled();
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

  it('成功但无 id → 返 null,不 focus', async () => {
    mocks.create.mockResolvedValue({ ok: true, data: {} });

    const id = await createUserTerminal();

    expect(id).toBeNull();
    expect(mocks.setPendingFocus).not.toHaveBeenCalled();
  });
});
