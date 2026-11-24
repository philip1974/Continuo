// @vitest-environment jsdom
// 外部文件同步(useExternalFileSync)的宿主是常驻的 MainApp,而不是懒加载的 EditorPanel:
// 打开文件后到 Editor chunk 挂载之前若文件被外部修改,订阅尚不存在 → 该 dir-changed 永久漏掉,
// tab 一直显示陈旧内容(e2e save-shortcut「外部修改」在启动遮罩去掉后暴露)。
import { describe, it, expect, afterEach, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import type { ReactNode } from 'react';

const hoisted = vi.hoisted(() => ({
  layoutReady: null as null | (() => void),
  Null: () => null,
  externalSync: vi.fn(),
  rootWatch: vi.fn(),
}));

vi.mock('@/panels/Editor/useExternalFileSync', () => ({
  useExternalFileSync: hoisted.externalSync,
}));
vi.mock('@/panels/Editor/useExternalSyncRootWatch', () => ({
  useExternalSyncRootWatch: hoisted.rootWatch,
}));

vi.mock('../../shell/dock/DockShell', () => ({
  DockShell: ({ onLayoutReady }: { onLayoutReady: () => void }) => {
    hoisted.layoutReady = onLayoutReady;
    return null;
  },
}));
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
vi.mock('@/plugins/quick-open/QuickOpenModal', () => ({ QuickOpenModal: hoisted.Null }));
vi.mock('@/plugins/quick-open/useQuickOpenHotkey', () => ({ useQuickOpenHotkey: () => {} }));
vi.mock('@/plugins/permissions/PermissionPrompt', () => ({ PermissionPrompt: hoisted.Null }));
vi.mock('@/plugins/co-app', () => ({ coApp: { commands: {}, settingItems: { get: () => undefined } } }));
vi.mock('@/lib/co-api', () => ({ coApi: { window: { notifyRoot: vi.fn() } } }));
vi.mock('@/lib/popout-mode', () => ({ isPopoutWindow: () => false }));
vi.mock('../../shell/notify-root-when-hydrated', () => ({
  notifyRootWhenHydrated: () => Promise.resolve(),
}));
vi.mock('@/plugins/settings/LanguageFromSettings', () => ({ LanguageFromSettings: hoisted.Null }));
vi.mock('@/notifications/ToastViewport', () => ({ ToastViewport: hoisted.Null }));
vi.mock('@/notifications/NotificationsProvider', () => ({
  NotificationsProvider: ({ children }: { children: ReactNode }) => children,
}));

import { App } from '../../shell/App';

afterEach(() => cleanup());

describe('外部文件同步的宿主', () => {
  it('MainApp 挂载即订阅外部文件同步,不依赖 Dock 布局 / EditorPanel 挂载', () => {
    render(<App />);
    // DockShell 被 mock 成不渲染任何面板:EditorPanel 不存在时同步也已生效。
    expect(hoisted.externalSync).toHaveBeenCalled();
    // 同步所需的 root watcher 同样由 MainApp 持有,不依赖 ExplorerSidebar(此处 mock 为不渲染)挂载文件树。
    expect(hoisted.rootWatch).toHaveBeenCalled();
  });
});
