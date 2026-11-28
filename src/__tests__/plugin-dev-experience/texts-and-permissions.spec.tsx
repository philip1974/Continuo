// @vitest-environment jsdom
// BDD: plugin-dev-experience(见同目录 README)—— 可读原因(三语、带位置、字段级)、无效插件通知一次、
// 「manifest 未声明」与「用户拒绝」两类权限错误、入口 Blob 带稳定 sourceURL。
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { state } = vi.hoisted(() => ({ state: { invalid: [] as unknown[] } }));
vi.mock('../../plugins/PluginManager', async () => {
  const { asSubscribableManager } = await import('../plugins-tab-content/fake-user-plugin-manager');
  const mgr = { listAll: () => [], listInvalid: () => state.invalid };
  return { getUserPluginManager: () => asSubscribableManager(mgr), setUserPluginManager: vi.fn() };
});

import { setLocale } from '@/i18n/translate';
import { notify } from '../../notifications/notify';
import { localizePluginError } from '../../plugins/plugin-error-text';
import { PluginFailureNotifier } from '../../plugins/PluginFailureNotifier';
import { notifyUserPluginListChanged } from '../plugins-tab-content/fake-user-plugin-manager';
import { createScopedApp } from '../../plugins/scoped-app';
import { createTestCoApp } from '../../plugins/test-utils';
import { InMemoryPermissionStore } from '../../plugins/testing/in-memory-stores';
import { PermissionError } from '../../plugins/permissions';
import { localizeThrown } from '../../lib/localize-error';
import { parseManifest } from '../../../electron/shared/plugin-manifest';
import { _resetLmApiForTest, captureLmApi } from '../../lib/co-api';
import { createWindowApiHost } from '../../lib/plugins-host';

beforeEach(() => setLocale('en'));
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  setLocale('zh');
});

describe('可读原因(插件行 / 通知共用)', () => {
  it.each([
    [
      { code: 'IMPORT_SYNTAX_ERROR', message: "Unexpected token '='", location: 'main.js:3:9' },
      "Syntax error in the plugin entry: Unexpected token '=' (main.js:3:9)",
      "插件入口有语法错误：Unexpected token '='（main.js:3:9）",
    ],
    [
      { code: 'IMPORT_UNBUNDLED', message: 'raw', params: { specifier: './util.js', kind: 'relative' } },
      'The entry imports “./util.js”, but a plugin must be bundled into a single ESM file (relative imports are not supported — see the SDK README)',
      '入口导入了「./util.js」，但插件须打包成单个 ESM 文件（不支持相对路径导入，见 SDK README）',
    ],
    [
      { code: 'EXCEPTION', message: 'onload boom', location: 'main.js:3:9' },
      'Activation failed: onload boom (main.js:3:9)',
      '激活失败：onload boom（main.js:3:9）',
    ],
    [
      { code: 'INCOMPATIBLE_VERSION', message: 'raw', params: { required: '9.0.0', current: '1.0.0' } },
      'Requires Continuo 9.0.0 or later (current: 1.0.0)',
      '需要 Continuo 9.0.0 或更高版本（当前：1.0.0）',
    ],
    [
      { code: 'PLUGIN_DIR_NAME_MISMATCH', message: 'raw', params: { dir: 'wrongname', declaredId: 'com.real' } },
      'Folder name “wrongname” does not match the manifest id “com.real” — rename the folder to plugins/com.real/',
      '文件夹名「wrongname」与 manifest 的 id「com.real」不一致——请把文件夹改名为 plugins/com.real/',
    ],
    [
      { code: 'PLUGIN_MAIN_UNAVAILABLE', message: 'raw', params: { main: 'dist/main.js', reason: 'unreachable' } },
      'Entry file “dist/main.js” is unavailable: it does not exist or points outside the plugin folder (not built yet?)',
      '入口文件「dist/main.js」不可用：不存在或指向插件文件夹之外（尚未构建？）',
    ],
  ])('%o → en / zh', (error, en, zh) => {
    expect(localizePluginError(error)).toBe(en);
    setLocale('zh');
    expect(localizePluginError(error)).toBe(zh);
  });

  it('manifest 字段级问题逐条本地化(en 不泄漏中文 id 规则,zh 不显示英文 zod 文案)', () => {
    const parsed = parseManifest(JSON.stringify({ id: 'Bad ID', version: 'x' }));
    expect(parsed.ok).toBe(false);
    const error = { code: 'SCHEMA_ERROR', message: parsed.ok ? '' : parsed.message, issues: parsed.ok ? [] : parsed.issues };
    const en = localizePluginError(error);
    expect(en).toBe(
      'manifest.json is invalid: id: only lowercase letters, digits, “.”, “_” and “-”; must not start with “.” or “_” or end with “.”; name: required; version: must be a version like 1.2.3',
    );
    expect(en).not.toMatch(/[一-鿿]/);
    setLocale('zh');
    const zh = localizePluginError(error);
    expect(zh).toContain('name：必填');
    expect(zh).toContain('version：须是 1.2.3 形式的版本号');
    expect(zh).not.toContain('Invalid');
  });
});

describe('无效插件通知一次', () => {
  const row = (message: string) => ({ dir: 'bad', name: 'Bad', error: { code: 'INVALID_JSON', message } });

  it('出现 → 通知一次(名称 + 原因);同一原因不重复;原因变了再通知;消失后再出现再通知', () => {
    const spy = vi.spyOn(notify, 'error').mockImplementation(() => {});
    state.invalid = [row('Unexpected end')];
    notifyUserPluginListChanged();
    render(<PluginFailureNotifier />);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith(
      'Plugin “Bad” could not be loaded: manifest.json is not valid JSON: Unexpected end. See Settings › Plugins.',
      { code: 'INVALID_JSON' },
    );
    act(() => {
      state.invalid = [row('Unexpected end')];
      notifyUserPluginListChanged();
    });
    expect(spy).toHaveBeenCalledTimes(1);
    act(() => {
      state.invalid = [row('Unexpected token')];
      notifyUserPluginListChanged();
    });
    expect(spy).toHaveBeenCalledTimes(2);
    act(() => {
      state.invalid = [];
      notifyUserPluginListChanged();
    });
    act(() => {
      state.invalid = [row('Unexpected token')];
      notifyUserPluginListChanged();
    });
    expect(spy).toHaveBeenCalledTimes(3);
  });
});

describe('权限错误:manifest 未声明 vs 用户拒绝', () => {
  const coApp = createTestCoApp('1.0.0');

  it('未声明 → PERMISSION_NOT_DECLARED,消息指明在 manifest.json 的 permissions 里加什么(三语本地化)', async () => {
    const store = new InMemoryPermissionStore();
    const app = createScopedApp(coApp, 'p', store, 'tok', ['network']);
    const err = await app.fs.readFile('/x').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PermissionError);
    expect(err).toMatchObject({ code: 'PERMISSION_NOT_DECLARED', permission: 'fs' });
    expect((err as Error).message).toBe('Permission "fs" is not declared: add "fs" to "permissions" in manifest.json');
    expect(localizeThrown(err)).toBe(
      'This plugin did not declare the “fs” permission — add “fs” to “permissions” in its manifest.json',
    );
    setLocale('zh');
    expect(localizeThrown(err)).toBe('插件未声明「fs」权限——请在 manifest.json 的 "permissions" 中加入 "fs"');
  });

  it('已声明但用户拒绝 → PERMISSION_DENIED(与未声明区分),本地化指向设置', async () => {
    const store = new InMemoryPermissionStore();
    await store.deny('p', ['fs']);
    const app = createScopedApp(coApp, 'p', store, 'tok', ['fs']);
    const err = await app.fs.readFile('/x').catch((e: unknown) => e);
    expect(err).toMatchObject({ code: 'PERMISSION_DENIED', permission: 'fs' });
    expect(localizeThrown(err)).toBe(
      'The “fs” permission was denied by the user; it can be granted in Settings › Plugins (Permissions)',
    );
  });

  it('没带参数的 PERMISSION_DENIED(停用吊销等)→ 仍显示原 message,不出现占位符', () => {
    const err = new PermissionError('fs', 'plugin p has been deactivated; \'fs\' revoked');
    expect(localizeThrown(err)).toBe("plugin p has been deactivated; 'fs' revoked");
  });
});

describe('入口 Blob 末尾追加稳定 sourceURL', () => {
  it('importModule 生成的 Blob 内容 = 源码 + //# sourceURL=continuo-plugin://<id>/<main>', async () => {
    _resetLmApiForTest();
    const blobs: Blob[] = [];
    Object.defineProperty(URL, 'createObjectURL', {
      value: vi.fn((b: Blob) => {
        blobs.push(b);
        return 'blob:x';
      }),
      writable: true,
      configurable: true,
    });
    Object.defineProperty(URL, 'revokeObjectURL', { value: vi.fn(), writable: true, configurable: true });
    const manifestText = JSON.stringify({ id: 'com.x', name: 'X', version: '1.0.0', main: './dist/main.js' });
    Object.defineProperty(window, 'api', {
      value: {
        plugins: {
          listDirs: vi.fn().mockResolvedValue({
            ok: true,
            data: [{ id: 'com.x', manifestText, manifestHash: 'a'.repeat(64), mainMtime: 1 }],
          }),
          readMainByDir: vi.fn().mockResolvedValue({ ok: true, data: 'export default 1;' }),
        },
      },
      writable: true,
      configurable: true,
    });
    captureLmApi();
    const host = createWindowApiHost();
    const [info] = await host.listPluginDirs();
    await host.importModule(info!.moduleUrl).catch(() => {}); // jsdom 不能 import blob:,只看生成的内容
    expect(blobs).toHaveLength(1);
    expect(await blobs[0]!.text()).toBe('export default 1;\n//# sourceURL=continuo-plugin://com.x/dist/main.js\n');
    delete (window as { api?: unknown }).api;
  });
});
