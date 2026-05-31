import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createScopedApp } from '@/plugins/scoped-app';
import { InMemoryPermissionStore } from '@/plugins/permissions';
import type { CoApp } from '@/plugins/types';
import { coApi } from '@/lib/co-api';

const pluginFsRawWithCheckPath = coApi.pluginFsRaw as typeof coApi.pluginFsRaw & {
  checkPath: ReturnType<typeof vi.fn>;
};

vi.mock('@/lib/co-api', () => ({
  coApi: {
    pluginFsRaw: {
      checkPath: vi.fn(async () => true),
    },
  },
}));

function makeCoApp(): CoApp {
  return {
    version: '0.2.3',
    panels: {} as CoApp['panels'],
    commands: {} as CoApp['commands'],
    statusBar: {} as CoApp['statusBar'],
    ribbon: {} as CoApp['ribbon'],
    events: {} as CoApp['events'],
    dataStore: {} as CoApp['dataStore'],
    settingTabs: {} as CoApp['settingTabs'],
    settingItems: {} as CoApp['settingItems'],
    explorerDecorators: {} as CoApp['explorerDecorators'],
    editorActions: {} as CoApp['editorActions'],
    explorerContextMenu: {} as CoApp['explorerContextMenu'],
    mcp: {} as CoApp['mcp'],
    workspace: {} as CoApp['workspace'],
    editor: {
      openFile: vi.fn(async () => ({ ok: true, lineApplied: false })),
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(pluginFsRawWithCheckPath.checkPath).mockResolvedValue(true);
});

describe('createScopedApp editor permission gate', () => {
  it('T1 returns PERMISSION_DENIED without fs permission', async () => {
    const app = makeCoApp();
    const scoped = createScopedApp(
      app,
      'plugin.a',
      new InMemoryPermissionStore(),
      'token-a',
    );

    const result = await scoped.editor.openFile('/work/a.ts');

    expect(result).toEqual({
      ok: false,
      code: 'PERMISSION_DENIED',
      message: "plugin plugin.a lacks 'fs' permission",
    });
    expect(app.editor.openFile).not.toHaveBeenCalled();
  });

  it('T2 forwards after fs grant and path scope approval', async () => {
    const app = makeCoApp();
    const store = new InMemoryPermissionStore();
    await store.grant('plugin.a', ['fs']);
    const scoped = createScopedApp(app, 'plugin.a', store, 'token-a');

    const result = await scoped.editor.openFile('/work/a.ts', { line: 4 });

    expect(pluginFsRawWithCheckPath.checkPath).toHaveBeenCalledWith(
      'token-a',
      '/work/a.ts',
    );
    expect(app.editor.openFile).toHaveBeenCalledWith('/work/a.ts', { line: 4 });
    expect(result).toEqual({ ok: true, lineApplied: false });
  });

  it('T3 returns PERMISSION_DENIED when path is outside granted scope', async () => {
    vi.mocked(pluginFsRawWithCheckPath.checkPath).mockResolvedValue(false);
    const app = makeCoApp();
    const store = new InMemoryPermissionStore();
    await store.grant('plugin.a', ['fs']);
    const scoped = createScopedApp(app, 'plugin.a', store, 'token-a');

    const result = await scoped.editor.openFile('/outside/a.ts');

    expect(result).toEqual({
      ok: false,
      code: 'PERMISSION_DENIED',
      message: "path '/outside/a.ts' out of granted scope",
    });
    expect(app.editor.openFile).not.toHaveBeenCalled();
  });
});
