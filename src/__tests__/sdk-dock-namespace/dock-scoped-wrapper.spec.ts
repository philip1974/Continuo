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

describe('app.dock scoped namespace', () => {
  it('T3 exposes a scoped wrapper with a different identity from raw dock', () => {
    const app = makeCoApp();
    const scoped = createScopedApp(app, 'sdk-dock.scoped', null, 'token');

    expect(scoped.dock).not.toBe(app.dock);
    expect(typeof scoped.dock.openPanel).toBe('function');
  });

  it('T3.5 forwards openPanel arguments to the raw dock namespace', () => {
    const app = makeCoApp();
    const scoped = createScopedApp(app, 'sdk-dock.scoped', null, 'token');

    scoped.dock.openPanel('git-changes-viewer');

    expect(app.dock.openPanel).toHaveBeenCalledWith('git-changes-viewer');
  });
});
