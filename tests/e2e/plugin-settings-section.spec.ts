// 插件自定义 category 的设置项进「插件设置」页签、按插件名分节;热重载后焦点交回插件页签按钮
//(BDD: src/__tests__/plugin-settings-section/)。真实第三方插件(userData/plugins/<id>)经 PluginManager 激活。
import { expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { closeDiscardingUnsaved } from './helpers/close-app';
import { launchContinuo } from './helpers/launch';
import { openSettings, openSettingsTab, settingsSearch, SETTINGS_NAV } from './helpers/settings';
import { waitForTestHooks } from './helpers/app-ready';

const PLUGIN_ID = 'acme.pset';
const PLUGIN_SETTINGS_TAB = /^(插件设置|Plugin Settings|플러그인 설정)$/;
const ACME_TAB = /^Acme Tab$/;

const mainJs = (version: string): string => `
const { Plugin, React } = globalThis.co;
export default class AcmePset extends Plugin {
  onload() {
    this.addSettingItem({ id: 'acme.pset.flag', category: 'acme', title: 'Acme flag', type: 'boolean', default: false });
    this.addSettingTab({ id: 'acme.pset.tab', title: 'Acme Tab', render: () => React.createElement('p', null, 'acme ${version}') });
  }
}
`;

let ud = '';
test.beforeEach(() => {
  ud = mkdtempSync(path.join(tmpdir(), 'continuo-pset-'));
  const dir = path.join(ud, 'plugins', PLUGIN_ID);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ id: PLUGIN_ID, name: 'Acme Settings', version: '1.0.0' }));
  writeFileSync(path.join(dir, 'main.js'), mainJs('v1'));
  writeFileSync(path.join(ud, 'plugins', '_enabled.json'), JSON.stringify([PLUGIN_ID]));
});
test.afterEach(() => {
  rmSync(ud, { recursive: true, force: true });
});

async function launch(): Promise<{ app: ElectronApplication; win: Page }> {
  const app = await launchContinuo(ud);
  const win = await app.firstWindow();
  await win.waitForLoadState('domcontentloaded');
  await waitForTestHooks(win);
  return { app, win };
}

test('自定义 category 的设置项出现在「插件设置」页签,节标题为插件名;搜索分组同名', async () => {
  test.setTimeout(60_000);
  const { app, win } = await launch();
  try {
    await openSettings(win);
    const nav = win.getByRole('navigation', { name: SETTINGS_NAV });
    await nav.getByRole('button', { name: PLUGIN_SETTINGS_TAB }).click({ timeout: 15_000 });
    await expect(win.getByRole('heading', { name: 'Acme Settings', exact: true })).toBeVisible();
    await expect(win.getByText('Acme flag', { exact: true })).toBeVisible();

    await settingsSearch(win).fill('Acme flag');
    await expect(win.getByRole('heading', { name: 'Acme Settings', exact: true })).toBeVisible();
    await expect(win.getByRole('heading', { name: 'acme', exact: true })).toHaveCount(0);
  } finally {
    await closeDiscardingUnsaved(app);
  }
});

test('热重载插件时焦点停在它的设置页签按钮上 → 重载后焦点交回该按钮', async () => {
  test.setTimeout(60_000);
  const { app, win } = await launch();
  try {
    await openSettingsTab(win, ACME_TAB);
    await expect(win.getByText('acme v1', { exact: true })).toBeVisible({ timeout: 15_000 });
    const tabButton = win.getByRole('navigation', { name: SETTINGS_NAV }).getByRole('button', { name: ACME_TAB });
    await tabButton.focus();

    writeFileSync(path.join(ud, 'plugins', PLUGIN_ID, 'main.js'), mainJs('v2'));
    await expect(win.getByText('acme v2', { exact: true })).toBeVisible({ timeout: 15_000 });
    await expect(tabButton).toBeFocused();
  } finally {
    await closeDiscardingUnsaved(app);
  }
});
