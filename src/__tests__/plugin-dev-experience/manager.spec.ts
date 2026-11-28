// @vitest-environment jsdom
// BDD: plugin-dev-experience(见同目录 README)—— renderer PluginManager:无效插件行、运行中新放入 / 修好即登记、
// 入口加载失败的分类与位置。
import { beforeEach, describe, expect, it, vi } from 'vitest';

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
