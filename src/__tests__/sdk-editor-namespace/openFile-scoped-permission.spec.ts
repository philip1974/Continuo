import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createScopedApp } from '@/plugins/scoped-app';
import { InMemoryPermissionStore } from '@/plugins/permissions';
import type { CoApp } from '@/plugins/types';
import { coApi } from '@/lib/co-api';

const pluginFsRawWithRead = coApi.pluginFsRaw as typeof coApi.pluginFsRaw & {
  readForEditor: ReturnType<typeof vi.fn>;
};

vi.mock('@/lib/co-api', () => ({
  coApi: {
    pluginFsRaw: {
      readForEditor: vi.fn(),
    },
  },
}));

const verified = (canonicalPath: string, content = 'verified content') => ({
  ok: true as const,
  canonicalPath,
  content,
});

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
      openVerifiedFile: vi.fn(async () => ({ ok: true as const, lineApplied: false })),
    },
    dock: {} as CoApp['dock'],
    notifications: {} as CoApp['notifications'],
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(pluginFsRawWithRead.readForEditor).mockImplementation(async (_t: string, p: string) => verified(p));
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
    expect(app.editor.openVerifiedFile).not.toHaveBeenCalled();
  });

  // 安全(L1):不再 checkPath 后让宿主按原路径另读;主进程持锁校验 + 读取,宿主用已校验内容在 canonicalPath 开标签。
  it('T2 forwards after fs grant and path scope approval', async () => {
    const app = makeCoApp();
    const store = new InMemoryPermissionStore();
    await store.grant('plugin.a', ['fs']);
    const scoped = createScopedApp(app, 'plugin.a', store, 'token-a');

    const result = await scoped.editor.openFile('/work/a.ts', { line: 4 });

    expect(pluginFsRawWithRead.readForEditor).toHaveBeenCalledWith(
      'token-a',
      '/work/a.ts',
    );
    expect(app.editor.openVerifiedFile).toHaveBeenCalledWith('/work/a.ts', 'verified content', { line: 4 });
    expect(app.editor.openFile).not.toHaveBeenCalled();
    expect(result).toEqual({ ok: true, lineApplied: false });
  });

  it('T3 returns PERMISSION_DENIED when path is outside granted scope', async () => {
    vi.mocked(pluginFsRawWithRead.readForEditor).mockResolvedValue({
      ok: false,
      code: 'SCOPE_ERROR',
      message: 'path out of granted scope',
    });
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
    expect(app.editor.openVerifiedFile).not.toHaveBeenCalled();
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
    expect(pluginFsRawWithRead.readForEditor).not.toHaveBeenCalled();
    expect(app.editor.openFile).not.toHaveBeenCalled();
    expect(app.editor.openVerifiedFile).not.toHaveBeenCalled();
  });

  it('E182 上限内合规 path → 正常走主进程校验读取 + 转发(回归)', async () => {
    const app = makeCoApp();
    const store = new InMemoryPermissionStore();
    await store.grant('plugin.a', ['fs']);
    const scoped = createScopedApp(app, 'plugin.a', store, 'token-a');
    const result = await scoped.editor.openFile('/work/ok.ts');
    expect(result).toMatchObject({ ok: true });
    expect(app.editor.openVerifiedFile).toHaveBeenCalledWith('/work/ok.ts', 'verified content', undefined);
  });
  // 安全(L1):主进程持锁读取的失败码映射到既有 SDK 失败分类;canonicalPath 与插件给的路径不同时按 canonical 开。
  it('L1 主进程读取失败 → 既有失败分类(FS_NOT_FILE 原样,FS_NOT_UTF8 等归 EXCEPTION),不开标签', async () => {
    const app = makeCoApp();
    const store = new InMemoryPermissionStore();
    await store.grant('plugin.a', ['fs']);
    const scoped = createScopedApp(app, 'plugin.a', store, 'token-a');
    vi.mocked(pluginFsRawWithRead.readForEditor).mockResolvedValueOnce({ ok: false, code: 'FS_NOT_FILE', message: 'm1' });
    expect(await scoped.editor.openFile('/work/dir')).toEqual({ ok: false, code: 'FS_NOT_FILE', message: 'm1' });
    vi.mocked(pluginFsRawWithRead.readForEditor).mockResolvedValueOnce({ ok: false, code: 'FS_NOT_UTF8', message: 'm2' });
    expect(await scoped.editor.openFile('/work/bin')).toEqual({ ok: false, code: 'EXCEPTION', message: 'm2' });
    expect(app.editor.openVerifiedFile).not.toHaveBeenCalled();
  });

  it('L1 经链接打开 → 按主进程返回的 canonicalPath 开标签', async () => {
    const app = makeCoApp();
    const store = new InMemoryPermissionStore();
    await store.grant('plugin.a', ['fs']);
    const scoped = createScopedApp(app, 'plugin.a', store, 'token-a');
    vi.mocked(pluginFsRawWithRead.readForEditor).mockResolvedValueOnce(verified('/real/a.ts', 'x'));
    await scoped.editor.openFile('/work/alias.ts');
    expect(app.editor.openVerifiedFile).toHaveBeenCalledWith('/real/a.ts', 'x', undefined);
  });
});
