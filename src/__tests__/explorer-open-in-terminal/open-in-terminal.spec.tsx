// @vitest-environment jsdom
// Explorer 右键「在终端中打开」:终端面板是 per-session id(`terminal-<sessionId>`),只由 DockReconciler 依
// live session 建出。入口此前在 create 成功后调通用 openOrFocusPanel('terminal', ...) —— getPanel('terminal')
// 恒为空 → addPanel 出 id='terminal'、无 params.sessionId 的坏面板(TerminalPanelView 自动关闭);布局恢复期间
// 还会被排队重放。契约:该入口不调 openOrFocusPanel,改与 Cmd+T 相同用 setPendingFocus 请求 Reconciler 聚焦。
// 该入口与 Cmd+T / header 新建同走 createUserTerminal(单一创建流程:等 root 恢复、预热 chunk、CANCELLED 静默、
// 失败本地化提示),只额外指定 cwd 与 COLORFGBG。
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';

const h = vi.hoisted(() => ({
  create: vi.fn(),
  openOrFocusPanel: vi.fn(),
  setPendingFocus: vi.fn(),
  notifyError: vi.fn(),
  contextActions: { current: null as Record<string, unknown> | null },
}));

vi.mock('@headless-tree/react', () => ({
  useTree: () => ({
    getItems: () => [],
    getState: () => ({ selectedItems: [], expandedItems: [], dnd: null }),
    getContainerProps: () => ({}),
    getItemInstance: () => ({ invalidateChildrenIds: vi.fn(), startRenaming: vi.fn() }),
    rebuildTree: vi.fn(),
    expandAll: vi.fn(),
    collapseAll: vi.fn(),
  }),
}));
vi.mock('@tanstack/react-virtual', () => ({
  useVirtualizer: () => ({ getTotalSize: () => 0, getVirtualItems: () => [] }),
}));
vi.mock('@/lib/co-api', () => ({
  coApi: {
    fs: {
      listDir: vi.fn(async () => ({ ok: true, data: [] })),
      watchDir: vi.fn(async () => ({ ok: true })),
      unwatchDir: vi.fn(async () => ({ ok: true })),
      onDirChanged: vi.fn(() => vi.fn()),
      onWatchLost: vi.fn(() => vi.fn()),
    },
    terminal: { create: h.create },
  },
}));
vi.mock('@/panels/Editor/useEditorFile', () => ({
  useEditorFile: () => ({ openFileByPath: vi.fn() }),
}));
vi.mock('@/plugins/settings/values-store', () => ({
  useSettingValue: (_key: string, fallback: unknown) => fallback,
}));
vi.mock('@/theme', () => ({ useTheme: () => ({ resolved: 'dark' }) }));
vi.mock('@/notifications/notify', () => ({ notify: { error: h.notifyError } }));
vi.mock('@/shell/dock/dock-api-ref', async (orig) => ({
  ...((await orig()) as Record<string, unknown>),
  openOrFocusPanel: h.openOrFocusPanel,
}));
vi.mock('@/shell/dock/DockReconciler', async (orig) => ({
  ...((await orig()) as Record<string, unknown>),
  setPendingFocus: h.setPendingFocus,
}));
vi.mock('../../panels/Explorer/ContextMenu', () => ({
  ContextMenu: ({
    children,
    actions,
  }: {
    children?: React.ReactNode;
    actions: Record<string, unknown>;
  }) => {
    h.contextActions.current = actions;
    return children ?? null;
  },
}));

import { FolderTree } from '../../panels/Explorer/FolderTree';
import { useWorkspaceStore } from '../../stores/workspace.store';

function openInTerminal(dir: string): void {
  render(React.createElement(FolderTree, { root: '/repo' }));
  const fn = h.contextActions.current?.onOpenInTerminal as ((d: string) => void) | undefined;
  expect(fn).toBeTypeOf('function');
  fn!(dir);
}

beforeEach(() => {
  // 创建流程先等 workspace root 恢复(rootRestored);这里设为已恢复,Explorer 的 root 即 store 的 root。
  useWorkspaceStore.setState({ root: '/repo', rootRestored: true });
  h.create.mockReset();
  h.openOrFocusPanel.mockReset();
  h.setPendingFocus.mockReset();
  h.notifyError.mockReset();
  h.contextActions.current = null;
});

afterEach(() => cleanup());

describe('Explorer 在终端中打开', () => {
  it('create 成功 → setPendingFocus(新 session id),不调通用 openOrFocusPanel', async () => {
    h.create.mockResolvedValue({ ok: true, data: { id: 't-1' } });
    openInTerminal('/repo/sub');
    await vi.waitFor(() => expect(h.setPendingFocus).toHaveBeenCalledWith('t-1'));
    expect(h.create).toHaveBeenCalledWith(
      expect.objectContaining({ cwd: '/repo/sub', workspaceRoot: '/repo' }),
    );
    expect(h.openOrFocusPanel).not.toHaveBeenCalled();
  });

  it('退出闸 CANCELLED → 静默(与其它新建终端入口一致),不提示、不聚焦', async () => {
    h.create.mockResolvedValue({ ok: false, code: 'TERMINAL_CREATE_CANCELLED', message: 'x' });
    openInTerminal('/repo/sub');
    await vi.waitFor(() => expect(h.create).toHaveBeenCalled());
    await Promise.resolve();
    expect(h.notifyError).not.toHaveBeenCalled();
    expect(h.setPendingFocus).not.toHaveBeenCalled();
  });

  it('create 失败 → 错误提示,不请求聚焦', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    h.create.mockResolvedValue({ ok: false, code: 'TERMINAL_CREATE_FAILED', message: 'x' });
    openInTerminal('/repo/sub');
    await vi.waitFor(() => expect(h.notifyError).toHaveBeenCalledTimes(1));
    expect(h.setPendingFocus).not.toHaveBeenCalled();
    expect(h.openOrFocusPanel).not.toHaveBeenCalled();
  });
});
