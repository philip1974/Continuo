// @vitest-environment jsdom
// 性能(冷启动关键路径):MainApp 向 main 推 window→root 映射只需 root 已恢复,不等编辑器 tab 读盘。
// R46 契约不变:root 恢复前不推首帧 null。
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { act, cleanup, render } from '@testing-library/react';
import type { ReactNode } from 'react';

const hoisted = vi.hoisted(() => ({
  Null: () => null,
  notifyRoot: vi.fn(async () => ({ ok: true })),
}));

vi.mock('../../shell/dock/DockShell', () => ({ DockShell: hoisted.Null }));
vi.mock('../../shell/dock/TerminalSessionsSync', () => ({ TerminalSessionsSync: hoisted.Null }));
vi.mock('../../shell/ExplorerSidebar', () => ({ ExplorerSidebar: hoisted.Null }));
vi.mock('../../shell/IconSidebar', () => ({ IconSidebar: hoisted.Null }));
vi.mock('../../shell/StatusBar', () => ({ StatusBar: hoisted.Null }));
vi.mock('../../shell/TitleBar', () => ({ TitleBar: hoisted.Null }));
vi.mock('../../shell/AgentAuthPrompt', () => ({ AgentAuthPrompt: hoisted.Null }));
vi.mock('@/plugins/command-palette/CommandPalette', () => ({ CommandPalette: hoisted.Null }));
vi.mock('@/plugins/command-palette/useCommandPaletteHotkey', () => ({
  useCommandPaletteHotkey: () => {},
}));
vi.mock('@/plugins/command-palette/useCommandHotkeys', () => ({ useCommandHotkeys: () => {} }));
vi.mock('@/panels/Editor/useExternalFileSync', () => ({ useExternalFileSync: () => {} }));
vi.mock('@/panels/Editor/useExternalSyncRootWatch', () => ({ useExternalSyncRootWatch: () => {} }));
vi.mock('@/plugins/quick-open/QuickOpenModal', () => ({ QuickOpenModal: hoisted.Null }));
vi.mock('@/plugins/quick-open/useQuickOpenHotkey', () => ({ useQuickOpenHotkey: () => {} }));
vi.mock('@/plugins/permissions/PermissionPrompt', () => ({ PermissionPrompt: hoisted.Null }));
vi.mock('@/plugins/co-app', () => ({ coApp: { commands: {}, settingItems: { get: () => undefined } } }));
vi.mock('@/lib/co-api', () => ({ coApi: { window: { notifyRoot: hoisted.notifyRoot, onMenuCommand: () => () => {} } } }));
vi.mock('@/lib/popout-mode', () => ({ isPopoutWindow: () => false }));
vi.mock('@/plugins/settings/LanguageFromSettings', () => ({ LanguageFromSettings: hoisted.Null }));
vi.mock('@/notifications/ToastViewport', () => ({ ToastViewport: hoisted.Null }));
vi.mock('@/notifications/NotificationsProvider', () => ({
  NotificationsProvider: ({ children }: { children: ReactNode }) => children,
}));

import { App } from '../../shell/App';
import { useWorkspaceStore } from '@/stores/workspace.store';

beforeEach(() => {
  hoisted.notifyRoot.mockClear();
  useWorkspaceStore.setState({
    root: null,
    recentRoots: [],
    rootRestored: false,
  });
});
afterEach(() => {
  cleanup();
});

describe('MainApp notifyRoot 门控 = root 已恢复', () => {
  it('root 恢复前不推送;rootRestored 后(tab 读盘在途)即推恢复出的 root', async () => {
    render(<App />);
    await act(async () => {
      await Promise.resolve();
    });
    expect(hoisted.notifyRoot).not.toHaveBeenCalled();

    await act(async () => {
      // 模拟 initExplorerPersistence:hydrateStores 设 root → markRootRestored → (tab 读盘在途)
      useWorkspaceStore.getState().setRoot('/w');
      useWorkspaceStore.getState().markRootRestored();
      await Promise.resolve();
    });
    await vi.waitFor(() => expect(hoisted.notifyRoot).toHaveBeenCalledWith('/w'));
  });
});
