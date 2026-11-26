// @vitest-environment jsdom
// BDD: plugin-settings-section —— 插件自定义 category 的设置项进「插件设置」页签,按插件分节(见同目录 README)。
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { plugins } = vi.hoisted(() => ({
  plugins: {
    list: [
      { id: 'acme.one', manifest: { id: 'acme.one', name: 'Acme One', version: '1.0.0' }, status: 'enabled' },
      { id: 'acme.two', manifest: { id: 'acme.two', name: 'Acme Two', version: '1.0.0' }, status: 'enabled' },
    ] as unknown[],
  },
}));
vi.mock('../../plugins/PluginManager', async () => {
  const { asSubscribableManager } = await import('../plugins-tab-content/fake-user-plugin-manager');
  const mgr = { listAll: () => plugins.list, markRenderFailed: vi.fn() };
  return { getUserPluginManager: () => asSubscribableManager(mgr), setUserPluginManager: vi.fn() };
});

import { setLocale } from '@/i18n/translate';
import { createScopedApp } from '../../plugins/scoped-app';
import { createTestCoApp } from '../../plugins/test-utils';
import type { CoApp } from '../../plugins/types';
import type { SettingItemSpec } from '../../plugins/registries/SettingItemRegistry';
import { SettingTabRegistry } from '../../plugins/registries/SettingTabRegistry';
import PluginSettingsTabPlugin from '../../core-plugins/PluginSettingsTabPlugin';
import { PluginSettingsTabContent } from '../../plugins/settings/CategoryTabContent';
import { PLUGIN_SETTINGS_TAB_ID } from '../../plugins/settings/plugin-setting-sections';
import { SettingsPanel, groupSearchResults } from '../../plugins/settings/SettingsPanel';
import { useSettingsStore } from '../../plugins/settings/store';

function item(id: string, category: string, extra: Partial<SettingItemSpec> = {}): SettingItemSpec {
  return { id, category, title: `Title ${id}`, type: 'boolean', default: false, ...extra };
}

let host: CoApp;
const pluginApp = (id: string) => createScopedApp(host, id, null, 'tok');

beforeEach(() => {
  setLocale('en');
  host = createTestCoApp();
  useSettingsStore.setState({ activeTabId: null });
});
afterEach(() => cleanup());

async function bootTabPlugin(): Promise<PluginSettingsTabPlugin> {
  const p = new PluginSettingsTabPlugin(createScopedApp(host, 'core.plugin-settings', null), {
    id: 'core.plugin-settings',
    name: 'PluginSettingsTab',
    version: '1.0.0',
  });
  await p._activate();
  return p;
}

describe('「插件设置」页签按需出现', () => {
  it('只有内置 category 的项时不出现;插件注册自定义 category 后出现;全部注销后消失', async () => {
    host.settingItems.register(item('editor.x', 'editor'));
    const p = await bootTabPlugin();
    expect(host.settingTabs.get(PLUGIN_SETTINGS_TAB_ID)).toBeUndefined();

    const d1 = pluginApp('acme.one').settingItems.register(item('acme.one.a', 'acme'));
    const d2 = pluginApp('acme.two').settingItems.register(item('acme.two.a', 'two'));
    const tab = host.settingTabs.get(PLUGIN_SETTINGS_TAB_ID);
    expect(tab?.titleKey).toBe('settings.plugin_settings.tab_title');

    d1.dispose();
    expect(host.settingTabs.get(PLUGIN_SETTINGS_TAB_ID)).toBe(tab);
    d2.dispose();
    expect(host.settingTabs.get(PLUGIN_SETTINGS_TAB_ID)).toBeUndefined();

    pluginApp('acme.one').settingItems.register(item('acme.one.b', 'acme'));
    expect(host.settingTabs.get(PLUGIN_SETTINGS_TAB_ID)).toBeDefined();
    await p._deactivate();
    expect(host.settingTabs.get(PLUGIN_SETTINGS_TAB_ID)).toBeUndefined();
  });

  it('插件把设置项放进内置 category → 仍留在内置页签,不触发「插件设置」', async () => {
    await bootTabPlugin();
    pluginApp('acme.one').settingItems.register(item('acme.one.g', 'general'));
    expect(host.settingTabs.get(PLUGIN_SETTINGS_TAB_ID)).toBeUndefined();
  });
});

describe('PluginSettingsTabContent 按插件分节', () => {
  it('节标题用插件 manifest name,无所有者的项用 category 原文;内置 category 的项不出现;注销后节消失', () => {
    host.settingItems.register(item('editor.x', 'editor'));
    const one = pluginApp('acme.one').settingItems.register(item('acme.one.a', 'acme'));
    pluginApp('acme.one').settingItems.register(item('acme.one.b', 'acme2', { group: 'g', groupKey: 'settings.group.appearance' }));
    pluginApp('acme.two').settingItems.register(item('acme.two.a', 'two'));
    pluginApp('ghost.plugin').settingItems.register(item('ghost.a', 'ghost'));
    host.settingItems.register(item('misc.a', 'misc'));

    const { container } = render(<PluginSettingsTabContent registry={host.settingItems} />);
    const headings = Array.from(container.querySelectorAll('h3')).map((h) => h.textContent);
    expect(headings).toEqual(['Acme One', 'Acme Two', 'ghost.plugin', 'misc']);
    // 同一插件的多个 category 合在一节,节内仍按 group 分组
    expect(container.querySelector('h4')?.textContent).toBe('Appearance');
    expect(container.textContent).toContain('Title acme.one.a');
    expect(container.textContent).not.toContain('Title editor.x');

    act(() => one.dispose());
    expect(container.textContent).not.toContain('Title acme.one.a');
    expect(container.textContent).toContain('Title acme.one.b');
  });
});

describe('搜索结果分组标题用可读名', () => {
  it('内置 category → 页签名;插件 category → 插件名;无所有者 → category 原文', () => {
    pluginApp('acme.one').settingItems.register(item('acme.one.a', 'acme'));
    pluginApp('acme.one').settingItems.register(item('acme.one.b', 'acme2'));
    host.settingItems.register(item('editor.x', 'editor'));
    host.settingItems.register(item('misc.a', 'misc'));
    const names = new Map([['acme.one', 'Acme One']]);
    const buckets = groupSearchResults(host.settingItems.getAll(), (id) => names.get(id));
    expect(buckets.map((b) => b.label)).toEqual(['Acme One', 'Editor', 'misc']);
    expect(buckets[0]!.items.map((s) => s.id)).toEqual(['acme.one.a', 'acme.one.b']);
  });

  it('SettingsPanel 搜索插件设置项时分组标题显示插件名', () => {
    pluginApp('acme.one').settingItems.register(item('acme.one.a', 'acme'));
    const tabs = new SettingTabRegistry();
    tabs.register({ id: 'general', title: 'General', render: () => 'g' });
    const { container } = render(<SettingsPanel registry={tabs} itemRegistry={host.settingItems} />);
    fireEvent.change(container.querySelector('input')!, { target: { value: 'acme.one' } });
    expect(container.querySelector('h3')?.textContent).toBe('Acme One');
  });
});

describe('热重载后焦点交回页签按钮', () => {
  function setup() {
    const tabs = new SettingTabRegistry();
    tabs.register({ id: 'general', title: 'General', render: () => 'g', priority: 1 });
    const spec = { id: 'acme.tab', title: 'Acme Tab', render: () => 'acme content', priority: 100 };
    let d = tabs.register(spec);
    const utils = render(<SettingsPanel registry={tabs} itemRegistry={host.settingItems} />);
    const btn = (id: string) => utils.container.querySelector<HTMLButtonElement>(`[data-setting-tab="${id}"]`);
    fireEvent.click(btn('acme.tab')!);
    act(() => btn('acme.tab')!.focus());
    return {
      ...utils,
      btn,
      unregister: () => act(() => d.dispose()),
      reregister: () => act(() => void (d = tabs.register({ ...spec }))),
    };
  }

  it('页签按钮卸载 → 焦点回落导航当前项;页签重新出现 → 焦点交回该页签按钮', async () => {
    const { btn, unregister, reregister } = setup();
    unregister();
    await waitFor(() => expect(document.activeElement).toBe(btn('general')));
    reregister();
    await waitFor(() => expect(document.activeElement).toBe(btn('acme.tab')));
    expect(btn('acme.tab')!.getAttribute('aria-current')).toBe('page');
  });

  it('焦点已被移到别处 → 不抢', async () => {
    const { btn, container, unregister, reregister } = setup();
    const input = container.querySelector('input')!;
    act(() => input.focus());
    unregister();
    reregister();
    await new Promise((r) => setTimeout(r, 0));
    expect(document.activeElement).toBe(input);
    expect(btn('acme.tab')).not.toBeNull();
  });

  it('回落后用户把焦点移走 → 页签重新出现时不再抢回', async () => {
    const { btn, container, unregister, reregister } = setup();
    unregister();
    await waitFor(() => expect(document.activeElement).toBe(btn('general')));
    const input = container.querySelector('input')!;
    act(() => input.focus());
    reregister();
    await new Promise((r) => setTimeout(r, 0));
    expect(document.activeElement).toBe(input);
  });
});
