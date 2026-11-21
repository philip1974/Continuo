import { describe, expect, it, vi } from 'vitest';
import { createScopedApp } from '../../plugins/scoped-app';
import type { CoApp } from '../../plugins/types';

function makeCoApp(): CoApp {
  return {
    version: '0.2.4-test',
    dock: {
      openPanel: vi.fn(),
    },
    notifications: {
      show: vi.fn(),
    },
    dataStore: {
      read: vi.fn(),
      write: vi.fn(),
    },
    workspace: {
      getRoot: vi.fn(),
    },
    editor: {
      openFile: vi.fn(async () => ({ ok: true, lineApplied: false })),
    },
    commands: {},
    panels: {},
    statusBar: {},
    ribbon: {},
    events: {},
    settingTabs: {},
    settingItems: {},
    explorerDecorators: {},
    editorActions: {},
    explorerContextMenu: {},
    mcp: {
      register: vi.fn(),
    },
  } as unknown as CoApp;
}

describe('app.notifications scoped namespace', () => {
  it('T9 exposes a scoped wrapper with a different identity from raw notifications', () => {
    const app = makeCoApp();
    const scoped = createScopedApp(app, 'sdk-notifications.scoped', null, 'token');

    expect(scoped.notifications).not.toBe(app.notifications);
    expect(typeof scoped.notifications.show).toBe('function');
  });

  it('T10 forwards show options to the raw notifications namespace', () => {
    const app = makeCoApp();
    const scoped = createScopedApp(app, 'sdk-notifications.scoped', null, 'token');
    const opts = {
      kind: 'error' as const,
      message: 'X failed',
      code: 'X_FAIL',
    };

    scoped.notifications.show(opts);

    expect(app.notifications.show).toHaveBeenCalledWith(opts);
  });
});
