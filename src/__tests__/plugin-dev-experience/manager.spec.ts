// @vitest-environment jsdom
// BDD: plugin-dev-experience(见同目录 README)—— renderer PluginManager:无效插件行、运行中新放入 / 修好即登记、
// 入口加载失败的分类与位置。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/co-api', () => ({
  coApi: {
    pluginFsRaw: {
      _registerPlugin: vi.fn().mockResolvedValue({ token: 't', generation: 1 }),
      _unregisterPlugin: vi.fn().mockResolvedValue(undefined),
    },
  },
}));

import { Plugin } from '../../plugins/Plugin';
import { PluginManager, type ManagerHost, type PluginDirInfo } from '../../plugins/PluginManager';
import { loadPluginModule } from '../../plugins/loader';
import { createTestCoApp } from '../../plugins/test-utils';
import { InMemoryPermissionStore } from '../../plugins/testing/in-memory-stores';
import { PermissionError } from '../../plugins/permissions';
import { _resetOutputChannelsForTest, hasOutputChannel, pluginOutputChannelId } from '../../plugins/output/output-channels';
import { localizePluginError } from '../../plugins/plugin-error-text';
import { localizeThrown } from '@/lib/localize-error';
import { setLocale } from '@/i18n/translate';
import { pluginIdFromStack, pluginLocationFromStack, pluginSourceUrl, withPluginSourceUrl } from '../../plugins/plugin-source-url';

const app = createTestCoApp('1.0.0');

class Loaded extends Plugin {
  static ids: string[] = [];
  onload() {
    Loaded.ids.push(this.manifest.id);
  }
}

interface State {
  dirs: PluginDirInfo[];
  enabled: Set<string>;
}

function dir(id: string, manifest: Record<string, unknown> | string = {}, extra: Partial<PluginDirInfo> = {}): PluginDirInfo {
  return {
    id,
    manifestText: typeof manifest === 'string' ? manifest : JSON.stringify({ id, name: id, version: '0.1.0', ...manifest }),
    moduleUrl: `mod://${id}`,
    ...extra,
  };
}

function host(state: State, over: Partial<ManagerHost> = {}): ManagerHost {
  return {
    listPluginDirs: () => state.dirs,
    readEnabledIds: () => state.enabled,
    mutateEnabledId: (id, enabled) => {
      if (enabled) state.enabled.add(id);
      else state.enabled.delete(id);
    },
    importModule: async () => ({ default: Loaded }),
    ...over,
  };
}

beforeEach(() => {
  Loaded.ids = [];
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

describe('无效插件行(准入失败的目录不再静默消失)', () => {
  it('manifest 字段错误 / 版本过高 / 目录名不一致 / 入口不可用 → listInvalid 各一行,带结构化原因', async () => {
    const state: State = {
      dirs: [
        dir('ok'),
        dir('bad', { version: 'x', permissions: ['fs', 'bogus'] }),
        dir('newer', { minLMVersion: '9.0.0' }),
        dir('wrongname', {}, { skip: { code: 'PLUGIN_DIR_NAME_MISMATCH', params: { dir: 'wrongname', declaredId: 'com.real' } } }),
        dir('nodist', {}, { skip: { code: 'PLUGIN_MAIN_UNAVAILABLE', params: { main: 'dist/main.js', reason: 'unreachable' } } }),
        dir('json', '{ nope'),
      ],
      enabled: new Set(),
    };
    const mgr = new PluginManager(app, host(state));
    await mgr.init();
    expect(mgr.listAll().map((p) => p.id)).toEqual(['ok']);
    const rows = mgr.listInvalid();
    expect(rows.map((r) => [r.dir, r.error.code])).toEqual([
      ['bad', 'SCHEMA_ERROR'],
      ['newer', 'INCOMPATIBLE_VERSION'],
      ['wrongname', 'PLUGIN_DIR_NAME_MISMATCH'],
      ['nodist', 'PLUGIN_MAIN_UNAVAILABLE'],
      ['json', 'INVALID_JSON'],
    ]);
    // 字段级:复用 parseManifest 的 path,并带可本地化的 code
    expect(rows[0]!.error.issues?.map((i) => [i.path, i.code])).toEqual([
      ['version', 'semver'],
      ['permissions.1', 'enum'],
    ]);
    expect(rows[1]!.error.params).toEqual({ required: '9.0.0', current: '1.0.0' });
    expect(rows[0]).toMatchObject({ id: 'bad', name: 'bad', version: 'x' });
    expect(mgr.listInvalid()).toBe(rows); // 无变化 → 同一引用
  });

  it('manifest 不是合法 JSON / 字段错误时,main 按默认值判出的「入口不可用」不盖过 manifest 错误', async () => {
    const skip = { code: 'PLUGIN_MAIN_UNAVAILABLE', params: { main: 'main.js', reason: 'unreachable' } } as const;
    const state: State = {
      dirs: [
        dir('json', '{ "id": "json", "main": "dist/index.js", ', { skip }),
        dir('schema', { version: 'x', main: 'dist/index.js' }, { skip }),
        dir('newer', { minLMVersion: '9.0.0' }, { skip }),
      ],
      enabled: new Set(),
    };
    const mgr = new PluginManager(app, host(state));
    await mgr.init();
    expect(mgr.listInvalid().map((r) => [r.dir, r.error.code])).toEqual([
      ['json', 'INVALID_JSON'],
      ['schema', 'SCHEMA_ERROR'],
      ['newer', 'PLUGIN_MAIN_UNAVAILABLE'], // manifest 合法:main 判定照旧优先于版本
    ]);
  });

  it('运行中修好 manifest → 文件变化广播(未登记 id)重新扫描:登记为插件、无效行消失,无需重载窗口', async () => {
    const state: State = { dirs: [dir('p', { version: 'x' })], enabled: new Set(['p']) };
    const mgr = new PluginManager(app, host(state));
    await mgr.init();
    expect(mgr.listInvalid().map((r) => r.dir)).toEqual(['p']);
    const notified = vi.fn();
    mgr.subscribe(notified);

    state.dirs = [dir('p')];
    await mgr.handleDirChanged('p');

    expect(mgr.listAll().map((p) => [p.id, p.status])).toEqual([['p', 'enabled']]);
    expect(Loaded.ids).toEqual(['p']); // 盘上已启用 → 激活
    expect(mgr.listInvalid()).toEqual([]);
    expect(notified).toHaveBeenCalled();
  });

  it('运行中新放入的插件(未启用)→ 登记为禁用;删掉无效目录 → 无效行消失', async () => {
    const state: State = { dirs: [dir('junk', '{')], enabled: new Set() };
    const mgr = new PluginManager(app, host(state));
    await mgr.init();
    state.dirs = [dir('late')];
    await mgr.handleDirChanged('late');
    expect(mgr.listAll().map((p) => [p.id, p.status])).toEqual([['late', 'disabled']]);
    expect(mgr.listInvalid()).toEqual([]);
    expect(Loaded.ids).toEqual([]);
  });

  it('删除无效插件目录(监视器广播)→ 无效行消失,宿主为它建的默认输出通道一并移除;修好登记的保留通道', async () => {
    _resetOutputChannelsForTest();
    const state: State = { dirs: [dir('bad', { version: 'x' }), dir('fixme', { version: 'x' })], enabled: new Set() };
    const mgr = new PluginManager(app, host(state));
    await mgr.init();
    expect(mgr.listInvalid().map((r) => r.dir)).toEqual(['bad', 'fixme']);
    expect(hasOutputChannel(pluginOutputChannelId('bad'))).toBe(true);
    const notified = vi.fn();
    mgr.subscribe(notified);

    state.dirs = [dir('fixme', { version: 'x' })];
    await mgr.handleDirChanged('bad');
    expect(mgr.listInvalid().map((r) => r.dir)).toEqual(['fixme']);
    expect(notified).toHaveBeenCalled();
    expect(hasOutputChannel(pluginOutputChannelId('bad'))).toBe(false);

    state.dirs = [dir('fixme')];
    await mgr.handleDirChanged('fixme');
    expect(mgr.listInvalid()).toEqual([]);
    expect(mgr.listAll().map((p) => p.id)).toEqual(['fixme']);
    expect(hasOutputChannel(pluginOutputChannelId('fixme'))).toBe(true); // 登记成插件:沿用同一默认通道
  });

  it('已登记插件同 id 的另一无效目录被删(广播落在已登记 id 上)→ 无效行同样刷新', async () => {
    const state: State = {
      dirs: [dir('p'), dir('p-copy', { id: 'p', version: 'x' })],
      enabled: new Set(['p']),
    };
    const mgr = new PluginManager(app, host(state));
    await mgr.init();
    expect(mgr.listInvalid().map((r) => r.dir)).toEqual(['p-copy']);
    state.dirs = [dir('p')];
    await mgr.handleDirChanged('p');
    expect(mgr.listInvalid()).toEqual([]);
  });

  it('已登记插件的 manifest 变成非法 JSON → 插件行 failed(INVALID_JSON),不报「已不存在」;修好后按启用意图重新激活', async () => {
    const state: State = { dirs: [dir('p')], enabled: new Set(['p']) };
    const mgr = new PluginManager(app, host(state));
    await mgr.init();
    state.dirs = [dir('p', '{ broken')];
    await mgr.handleDirChanged('p');
    expect(mgr.listAll()[0]).toMatchObject({ status: 'failed', error: { code: 'INVALID_JSON' } });
    expect(mgr.listInvalid()).toEqual([]); // 失败显示在插件自己的行上,不重复成无效行

    state.dirs = [dir('p', { version: '0.2.0' })];
    await mgr.handleDirChanged('p');
    expect(mgr.listAll()[0]).toMatchObject({ status: 'enabled' });
  });

  it('入口不可用(main 被删)→ 已登记插件转 failed,原因带 main 名', async () => {
    const state: State = { dirs: [dir('p')], enabled: new Set(['p']) };
    const mgr = new PluginManager(app, host(state));
    await mgr.init();
    state.dirs = [dir('p', {}, { skip: { code: 'PLUGIN_MAIN_UNAVAILABLE', params: { main: 'main.js', reason: 'unreachable' } } })];
    await mgr.handleDirChanged('p');
    expect(mgr.listAll()[0]).toMatchObject({
      status: 'failed',
      error: { code: 'PLUGIN_MAIN_UNAVAILABLE', params: { main: 'main.js', reason: 'unreachable' } },
    });
  });

  it('监视器先以 prompt:false 登记(需授权 → 等待别处授权)后,本窗口发起的安装照常激活并弹授权', async () => {
    const state: State = { dirs: [], enabled: new Set() };
    const store = new InMemoryPermissionStore();
    const promptFn = vi.fn(async (_id: string, perms: readonly string[]) => perms as never);
    const mgr = new PluginManager(app, host(state, { permissionStore: store, promptFn }));
    await mgr.init();
    state.dirs = [dir('x', { permissions: ['shell'] })];
    state.enabled.add('x');
    await mgr.handleDirChanged('x'); // 监视器广播先到
    expect(mgr.listAll()[0]).toMatchObject({ status: 'disabled', awaitingGrantElsewhere: true });
    expect(promptFn).not.toHaveBeenCalled();

    await mgr.adoptInstalled('x'); // 本窗口的安装流程
    expect(promptFn).toHaveBeenCalledTimes(1);
    expect(mgr.listAll()[0]).toMatchObject({ status: 'enabled' });
    expect(Loaded.ids).toEqual(['x']);
  });
});

describe('入口加载失败:分类 + 位置', () => {
  const manifest = { id: 'com.x', name: 'X', version: '1.0.0', main: './dist/main.js' };

  it('相对 / 裸 specifier 解析失败 → IMPORT_UNBUNDLED(须打包成单文件)', async () => {
    const fail = (msg: string) => () => Promise.reject(new TypeError(msg));
    const rel = await loadPluginModule({
      moduleUrl: 'u',
      manifest,
      importer: fail('Failed to resolve module specifier "./util.js". Invalid relative url or base scheme isn\'t hierarchical.'),
    });
    expect(rel).toMatchObject({ ok: false, code: 'IMPORT_UNBUNDLED', params: { specifier: './util.js', kind: 'relative' } });
    const bare = await loadPluginModule({
      moduleUrl: 'u',
      manifest,
      importer: fail('Failed to resolve module specifier "lodash". Relative references must start with either "/", "./", or "../".'),
    });
    expect(bare).toMatchObject({ ok: false, code: 'IMPORT_UNBUNDLED', params: { specifier: 'lodash', kind: 'bare' } });
  });

  it('SyntaxError → 经诊断补行列号(IMPORT_SYNTAX_ERROR);诊断不可用 → 仍是 IMPORT_FAILED', async () => {
    const err = new SyntaxError("Unexpected token '='");
    const diagnoseSyntax = vi.fn().mockResolvedValue({ line: 3, column: 9, message: "Unexpected token '='" });
    const r = await loadPluginModule({ moduleUrl: 'u', manifest, importer: () => Promise.reject(err), diagnoseSyntax });
    expect(diagnoseSyntax).toHaveBeenCalledWith('u');
    expect(r).toMatchObject({ ok: false, code: 'IMPORT_SYNTAX_ERROR', location: 'dist/main.js:3:9' });
    const r2 = await loadPluginModule({ moduleUrl: 'u', manifest, importer: () => Promise.reject(err) });
    expect(r2).toMatchObject({ ok: false, code: 'IMPORT_FAILED' });
  });

  it('诊断只有行号(拿不到可靠列号 / 消息)→ 位置只写到行,消息用 import 的报错', async () => {
    const err = new SyntaxError("Unexpected token '='");
    const diagnoseSyntax = vi.fn().mockResolvedValue({ line: 3, message: '' });
    const r = await loadPluginModule({ moduleUrl: 'u', manifest, importer: () => Promise.reject(err), diagnoseSyntax });
    expect(r).toMatchObject({ ok: false, code: 'IMPORT_SYNTAX_ERROR', location: 'dist/main.js:3', message: "Unexpected token '='" });
  });

  it('模块顶层抛错 → IMPORT_FAILED 带堆栈里本插件帧的位置', async () => {
    const err = new Error('top-level boom');
    err.stack = `Error: top-level boom\n    at continuo-plugin://com.x/dist/main.js:12:7`;
    const r = await loadPluginModule({ moduleUrl: 'u', manifest, importer: () => Promise.reject(err) });
    expect(r).toMatchObject({ ok: false, code: 'IMPORT_FAILED', location: 'dist/main.js:12:7' });
  });

  it('onload 抛错 → 插件行 error 带位置(sourceURL 帧)', async () => {
    class Throws extends Plugin {
      onload() {
        const e = new Error('onload boom');
        e.stack = `Error: onload boom\n    at helper (continuo-plugin://t/main.js:3:9)\n    at Throws.onload (continuo-plugin://t/main.js:8:5)\n    at Plugin._activate (file:///app/main-app.js:1:1)`;
        throw e;
      }
    }
    const state: State = { dirs: [dir('t')], enabled: new Set(['t']) };
    const mgr = new PluginManager(app, host(state, { importModule: async () => ({ default: Throws }) }));
    await mgr.init();
    expect(mgr.listAll()[0]).toMatchObject({ status: 'failed', error: { message: 'onload boom', location: 'main.js:3:9' } });
  });
});

describe('激活期抛出的权限错误:插件行 / 通知与命令路径同一本地化文案', () => {
  async function failWith(err: unknown) {
    class Throws extends Plugin {
      onload() {
        throw err;
      }
    }
    const state: State = { dirs: [dir('t')], enabled: new Set(['t']) };
    const mgr = new PluginManager(app, host(state, { importModule: async () => ({ default: Throws }) }));
    await mgr.init();
    const item = mgr.listAll()[0]!;
    expect(item.status).toBe('failed');
    return item.error!;
  }

  afterEach(() => setLocale('en'));

  it('onload 里调用未声明权限(PERMISSION_NOT_DECLARED)→ 保留 i18nKey / params,三语与 localizeThrown 一致,不回退整句英文', async () => {
    const thrown = PermissionError.notDeclared('fs');
    const error = await failWith(thrown);
    expect(error).toMatchObject({
      code: 'PERMISSION_NOT_DECLARED',
      i18nKey: 'plugin_permission.not_declared',
      params: { permission: 'fs' },
    });
    for (const locale of ['en', 'zh', 'ko'] as const) {
      setLocale(locale);
      expect(localizePluginError(error)).toBe(localizeThrown(thrown));
      expect(localizePluginError(error)).not.toContain('is not declared: add');
    }
    setLocale('zh');
    expect(localizePluginError(error)).toBe('插件未声明「fs」权限——请在 manifest.json 的 "permissions" 中加入 "fs"');
  });

  it('onload 里被用户拒绝的权限(PERMISSION_DENIED + key)→ 按 key 本地化,不把整句 message 当权限列表', async () => {
    const thrown = PermissionError.deniedByUser('fs');
    const error = await failWith(thrown);
    setLocale('zh');
    expect(localizePluginError(error)).toBe(localizeThrown(thrown));
    expect(localizePluginError(error)).not.toContain('所需权限已被拒绝');
  });

  it('不带 key / 权限列表的 PERMISSION_DENIED(吊销等)→ 「激活失败:原文」,不套「所需权限已被拒绝」', async () => {
    const error = await failWith(new PermissionError('fs', "plugin t has been deactivated; 'fs' revoked"));
    expect(localizePluginError(error)).toBe("Activation failed: plugin t has been deactivated; 'fs' revoked");
  });

  it('激活前权限门拒绝 → params.perms 列出被拒权限', async () => {
    const store = new InMemoryPermissionStore();
    const promptFn = vi.fn(async () => [] as never);
    const state: State = { dirs: [dir('g', { permissions: ['fs', 'network'] })], enabled: new Set(['g']) };
    const mgr = new PluginManager(app, host(state, { permissionStore: store, promptFn }));
    await mgr.init();
    const error = mgr.listAll()[0]!.error!;
    expect(error).toMatchObject({ code: 'PERMISSION_DENIED', params: { perms: 'fs, network' } });
    expect(localizePluginError(error)).toBe('Required permissions denied: fs, network');
  });
});

describe('稳定 sourceURL', () => {
  it('continuo-plugin://<id>/<main>:去 ./、统一 /、逐段编码;追加在末尾(行号不变)', () => {
    expect(pluginSourceUrl('com.x', './dist/main.js')).toBe('continuo-plugin://com.x/dist/main.js');
    expect(pluginSourceUrl('com.x', 'dist\\my main.js')).toBe('continuo-plugin://com.x/dist/my%20main.js');
    const src = 'a\nb';
    const out = withPluginSourceUrl(src, 'continuo-plugin://com.x/main.js');
    expect(out.startsWith('a\nb\n')).toBe(true);
    expect(out.trimEnd().endsWith('//# sourceURL=continuo-plugin://com.x/main.js')).toBe(true);
  });

  it('堆栈帧 → 插件 id / 位置(只认指定插件的帧)', () => {
    const stack = 'Error: x\n    at f (continuo-plugin://a.b/main.js:1:2)\n    at g (continuo-plugin://c.d/x/y.js:3:4)';
    expect(pluginIdFromStack(stack)).toBe('a.b');
    expect(pluginLocationFromStack(stack, 'c.d')).toBe('x/y.js:3:4');
    expect(pluginLocationFromStack(stack, 'nope')).toBeUndefined();
    expect(pluginIdFromStack('Error\n    at file:///app.js:1:1')).toBeNull();
  });
});
