// @vitest-environment jsdom
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render } from '@testing-library/react';
import { Fragment, createElement } from 'react';
import { bootCorePlugins, shutdownCorePlugins } from '../../core-plugins';
import { coApp } from '../../plugins/co-app';
import { _resetLmApiForTest, captureLmApi } from '../../lib/co-api';
import { notify } from '../../notifications/notify';
import { __resetSelectDirectoryLockForTest } from '../../lib/select-directory-single-flight';

beforeEach(async () => {
  // 确保起始干净
  await shutdownCorePlugins();
});

afterEach(async () => {
  await shutdownCorePlugins();
});

describe('bootCorePlugins', () => {
  it('注册 editor / terminal / debug / output / settings 五个 panel 类型', () => {
    bootCorePlugins();
    const types = coApp.panels.getAll().map((p) => p.type).sort();
    expect(types).toEqual(['debug', 'editor', 'output', 'settings', 'terminal']);
  });

  it('每个 panel 含 title 与 factory', () => {
    bootCorePlugins();
    const all = coApp.panels.getAll();
    for (const p of all) {
      expect(p.title.length).toBeGreaterThan(0);
      expect(typeof p.factory).toBe('function');
    }
  });

  it('factory 调用返回非 null React 元素', () => {
    bootCorePlugins();
    const editor = coApp.panels.getAll().find((p) => p.type === 'editor')!;
    const node = editor.factory({} as never);
    expect(node).toBeTruthy();
  });
});

describe('shutdownCorePlugins', () => {
  it('全部反序 _deactivate,registry 清空', async () => {
    bootCorePlugins();
    expect(coApp.panels.getAll().length).toBe(5);
    await shutdownCorePlugins();
    expect(coApp.panels.getAll().length).toBe(0);
  });

  it('shutdown 二次调用幂等', async () => {
    bootCorePlugins();
    await shutdownCorePlugins();
    await expect(shutdownCorePlugins()).resolves.toBeUndefined();
  });
});

describe('设置 tab 的 render 在多次调用间保持同一组件类型', () => {
  // SettingsPanel 在渲染期调 tab.render();若每次返回新的组件类型,父组件一重渲 tab 内容就卸载重挂,
  // 本地状态(如录制中的快捷键)丢失。
  it.each([
    'core.keybindings',
    'core.plugins',
    'core.general',
    'core.editor',
    'core.explorer',
    'core.terminal',
  ])('%s', (id) => {
    bootCorePlugins();
    const tab = coApp.settingTabs.getAll().find((t) => t.id === id)!;
    const a = tab.render() as { type: unknown };
    const b = tab.render() as { type: unknown };
    expect(a.type).toBe(b.type);
  });
});

// perf(#7):Settings 外壳已 lazy,tab 内容组件也不得被内置插件静态导入(否则打进 main-app 启动包)。
describe('设置 tab 内容懒加载', () => {
  it('core-plugins 不静态导入 CategoryTabContent / PluginsTabContent', () => {
    const dir = join(process.cwd(), 'src/core-plugins');
    for (const f of readdirSync(dir).filter((n) => n.endsWith('.ts'))) {
      const src = readFileSync(join(dir, f), 'utf-8');
      expect(src, f).not.toMatch(
        /^import[^;]*from\s+'@\/plugins\/settings\/(CategoryTabContent|PluginsTabContent)'/m,
      );
    }
  });

  it('首次渲染经 Suspense 加载后显示分类设置项', async () => {
    bootCorePlugins();
    const tab = coApp.settingTabs.getAll().find((t) => t.id === 'core.general')!;
    const view = render(createElement(Fragment, null, tab.render()));
    expect((await view.findAllByText(/theme|主题/i)).length).toBeGreaterThan(0);
    view.unmount();
  });
});

describe('PluginsTabPlugin(v3.5)', () => {
  it('boot 后注册 core.plugins 设置 tab', () => {
    bootCorePlugins();
    const tabs = coApp.settingTabs.getAll().map((t) => t.id);
    expect(tabs).toContain('core.plugins');
  });

  it('shutdown 后 tab 移除', async () => {
    bootCorePlugins();
    await shutdownCorePlugins();
    const tabs = coApp.settingTabs.getAll().map((t) => t.id);
    expect(tabs).not.toContain('core.plugins');
  });
});

// 与 Explorer「打开文件夹」(useSelectWorkspaceFolder)一致:selectDirectory 返回 {ok:false} → 失败 toast;
// 用户取消({ok:true,data:null})仍静默。
describe('WindowPlugin · 在新窗口打开文件夹', () => {
  function install(selectResult: unknown) {
    const create = vi.fn().mockResolvedValue({ ok: true, data: undefined });
    Object.defineProperty(window, 'api', {
      value: {
        fs: { selectDirectory: vi.fn().mockResolvedValue(selectResult) },
        window: { create },
      },
      writable: true,
      configurable: true,
    });
    captureLmApi();
    return create;
  }

  beforeEach(() => {
    _resetLmApiForTest();
    __resetSelectDirectoryLockForTest();
  });

  afterEach(() => {
    delete (window as { api?: unknown }).api;
    _resetLmApiForTest();
    vi.restoreAllMocks();
  });

  async function run() {
    bootCorePlugins();
    const cmd = coApp.commands.getAll().find((c) => c.id === 'window.openFolderInNew')!;
    await cmd.fn();
  }

  it('selectDirectory {ok:false} → notify.error 附 code,不建窗', async () => {
    const errSpy = vi.spyOn(notify, 'error').mockImplementation(() => undefined as never);
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const create = install({ ok: false, code: 'EXCEPTION', message: 'dialog failed' });
    await run();
    expect(errSpy).toHaveBeenCalledTimes(1);
    expect(errSpy.mock.calls[0]![1]).toMatchObject({ code: 'EXCEPTION' });
    expect(create).not.toHaveBeenCalled();
  });

  it('用户取消(data=null)→ 静默,不 toast 不建窗', async () => {
    const errSpy = vi.spyOn(notify, 'error').mockImplementation(() => undefined as never);
    const create = install({ ok: true, data: null });
    await run();
    expect(errSpy).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
  });
});
