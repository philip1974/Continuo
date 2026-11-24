// @vitest-environment jsdom
// Splash 只遮住布局恢复期:DockShell 报 onLayoutReady 即移除,不再额外强制最短展示时长
// (此前 SPLASH_MIN_MS=600:布局 80ms 就绪也要再被全屏遮罩挡 ~500ms 才可交互)。
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { act, cleanup, render } from '@testing-library/react';
import type { ReactNode } from 'react';

const hoisted = vi.hoisted(() => ({
  layoutReady: null as null | (() => void),
  Null: () => null,
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
vi.mock('@/panels/Editor/useExternalFileSync', () => ({ useExternalFileSync: () => {} }));
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

beforeEach(() => {
  vi.useFakeTimers();
  hoisted.layoutReady = null;
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('Splash 生命周期', () => {
  it('布局未就绪时显示 Splash;onLayoutReady 后立即移除,不等最短展示时长', () => {
    const { container } = render(<App />);
    expect(container.ownerDocument.querySelector('[data-testid=splash]')).not.toBeNull();

    act(() => {
      vi.advanceTimersByTime(80);
      hoisted.layoutReady?.();
    });
    expect(container.ownerDocument.querySelector('[data-testid=splash]')).toBeNull();
  });
});
