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
      openFile: vi.fn(async () => ({ ok: true as const, lineApplied: false })),
    },
    dock: {} as CoApp['dock'],
    notifications: {} as CoApp['notifications'],
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

  // 边界(E182,E180 同族):openFile path 类型/长度前置闸(发 checkPath IPC 前)。畸形/超长 path →
  // INVALID_PATH,不调 checkPath / rawEditor.openFile(挡 structured-clone 前置放大)。
  it('E182 超长 / 非字符串 / 空 path → INVALID_PATH,不调 checkPath / rawEditor', async () => {
    const app = makeCoApp();
    const store = new InMemoryPermissionStore();
    await store.grant('plugin.a', ['fs']);
    const scoped = createScopedApp(app, 'plugin.a', store, 'token-a');

    const longPath = '/' + 'x'.repeat(8192 + 1);
    for (const bad of [longPath, '', 42 as unknown as string]) {
      const result = await scoped.editor.openFile(bad);
      expect(result).toMatchObject({ ok: false, code: 'INVALID_PATH' });
    }
    expect(pluginFsRawWithCheckPath.checkPath).not.toHaveBeenCalled();
    expect(app.editor.openFile).not.toHaveBeenCalled();
  });

  it('E182 上限内合规 path → 正常走 checkPath + 转发(回归)', async () => {
    vi.mocked(pluginFsRawWithCheckPath.checkPath).mockResolvedValue(true);
    const app = makeCoApp();
    const store = new InMemoryPermissionStore();
    await store.grant('plugin.a', ['fs']);
    const scoped = createScopedApp(app, 'plugin.a', store, 'token-a');
    const result = await scoped.editor.openFile('/work/ok.ts');
    expect(result).toMatchObject({ ok: true });
    expect(app.editor.openFile).toHaveBeenCalledWith('/work/ok.ts', undefined);
  });
});
