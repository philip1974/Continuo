// 插件贡献渲染抛错只影响它自己,主窗不白屏(BDD: src/__tests__/plugin-render-isolation/、plugin-failure-notify/、
// dock-plugin-panel-placeholder/)。真实第三方插件(userData/plugins/<id>)经 PluginManager 激活。
import { expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { closeDiscardingUnsaved } from './helpers/close-app';
import { launchContinuo } from './helpers/launch';
import { openSettingsTab, PLUGINS_TAB, GENERAL_TAB } from './helpers/settings';
import { waitForTestHooks } from './helpers/app-ready';

const PLUGIN_ID = 'acme.bad';
const RENDER_ERROR = /^(插件「Acme Bad」渲染出错|Plugin “Acme Bad” failed to render|플러그인 'Acme Bad' 렌더링 오류)$/;
/** 块级错误(面板 / 设置页)含按钮文字,按子串匹配。 */
const RENDER_ERROR_BLOCK = /(插件「Acme Bad」渲染出错|Plugin “Acme Bad” failed to render|플러그인 'Acme Bad' 렌더링 오류)/;
const FAILURE_TOAST = /(Acme Bad)/;
const DISABLE_PLUGIN = /^(禁用插件|Disable Plugin|플러그인 비활성화)$/;
const DISABLED_PLACEHOLDER = /(插件「Acme Bad」已禁用|Plugin “Acme Bad” is disabled|'Acme Bad'이\(가\) 비활성화)/;
const ENABLE = /^(启用|Enable|활성)$/;
const RELOAD = /^(重载|Reload|다시 로드|새로 고침)$/;
const ENABLE_ROW = /^(启用|Enable|활성) — Acme Bad$/;
const BAD_TAB = /^Bad Tab$/;

// 第三方插件:状态栏项 / 面板 / 设置页都渲染一个会抛错的组件;命令打开面板。
const MAIN_JS = `
const { Plugin, React } = globalThis.co;
const h = React.createElement;
function Boom() { throw new Error('acme boom'); }
export default class AcmeBad extends Plugin {
  onload() {
    this.addStatusBarItem({ id: 'acme.bad.item', side: 'left', render: () => h(Boom) });
    this.registerPanel({ type: 'acme.bad.panel', title: 'Acme Panel', factory: () => h(Boom) });
    this.addSettingTab({ id: 'acme.bad.tab', title: 'Bad Tab', render: () => h(Boom) });
    this.addCommand({ id: 'acme.bad.open', title: 'Acme open', fn: () => this.app.dock.openPanel('acme.bad.panel') });
  }
}
`;

function readEnabledIds(ud: string): string[] {
  return JSON.parse(readFileSync(path.join(ud, 'plugins', '_enabled.json'), 'utf8')) as string[];
}

function seedPlugin(ud: string): void {
  const dir = path.join(ud, 'plugins', PLUGIN_ID);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ id: PLUGIN_ID, name: 'Acme Bad', version: '1.0.0' }));
  writeFileSync(path.join(dir, 'main.js'), MAIN_JS);
  writeFileSync(path.join(ud, 'plugins', '_enabled.json'), JSON.stringify([PLUGIN_ID]));
}

async function launch(ud: string): Promise<{ app: ElectronApplication; win: Page }> {
  const app = await launchContinuo(ud);
  const win = await app.firstWindow();
  await win.waitForLoadState('domcontentloaded');
  await waitForTestHooks(win);
  return { app, win };
}

let ud = '';
test.beforeEach(() => {
  ud = mkdtempSync(path.join(tmpdir(), 'continuo-pri-'));
  seedPlugin(ud);
});
test.afterEach(() => {
  rmSync(ud, { recursive: true, force: true });
});

test('状态栏项渲染抛错:主窗其余照常、该项为错误图标、弹一次失败通知;重启后仍可用', async () => {
  test.setTimeout(60_000);
  let { app, win } = await launch(ud);
  try {
    const footer = win.locator('footer');
    await expect(footer.getByTitle(RENDER_ERROR)).toBeVisible({ timeout: 15_000 });
    await expect(win.locator('aside').first()).toBeVisible();
    await expect(win.locator('[data-statusbar] button').first()).toBeVisible();
    await expect(win.getByText(FAILURE_TOAST).first()).toBeVisible();
    await closeDiscardingUnsaved(app);

    ({ app, win } = await launch(ud));
    await expect(win.locator('footer').getByTitle(RENDER_ERROR)).toBeVisible({ timeout: 15_000 });
    // 设置仍可打开(主窗可交互)
    await openSettingsTab(win, PLUGINS_TAB);
    await expect(win.locator(`[data-code="RENDER_FAILED"]`)).toBeVisible();
  } finally {
    await closeDiscardingUnsaved(app);
  }
});

test('面板渲染抛错只在该面板显示错误块;「禁用插件」后变为「已禁用」占位 + 启用按钮', async () => {
  test.setTimeout(60_000);
  const { app, win } = await launch(ud);
  try {
    await expect(win.locator('footer').getByTitle(RENDER_ERROR)).toBeVisible({ timeout: 15_000 });
    await win.evaluate(() => globalThis.__continuoTest!.executeCommand('acme.bad.open'));
    const alert = win.getByRole('alert').filter({ hasText: RENDER_ERROR_BLOCK });
    await expect(alert).toBeVisible();
    await alert.getByRole('button', { name: DISABLE_PLUGIN }).click();
    await expect(win.getByText(DISABLED_PLACEHOLDER)).toBeVisible();
    const enable = win
      .locator('.dv-content-container')
      .filter({ hasText: DISABLED_PLACEHOLDER })
      .getByRole('button', { name: ENABLE });
    await expect(enable).toBeVisible();
    // 焦点落到替换出的占位「启用」按钮,不掉到 body(对齐 VSCode)。
    await expect(enable).toBeFocused();
    // 禁用后状态栏错误图标随贡献注销消失
    await expect(win.locator('footer').getByTitle(RENDER_ERROR)).toHaveCount(0);
  } finally {
    await closeDiscardingUnsaved(app);
  }
});

test('设置页渲染抛错只在内容区显示错误块,导航照常可切走', async () => {
  test.setTimeout(60_000);
  const { app, win } = await launch(ud);
  try {
    await expect(win.locator('footer').getByTitle(RENDER_ERROR)).toBeVisible({ timeout: 15_000 });
    await openSettingsTab(win, BAD_TAB);
    await expect(win.getByRole('alert').filter({ hasText: RENDER_ERROR_BLOCK })).toBeVisible();
    await win.getByRole('button', { name: GENERAL_TAB }).click();
    await expect(win.getByRole('alert').filter({ hasText: RENDER_ERROR_BLOCK })).toHaveCount(0);
  } finally {
    await closeDiscardingUnsaved(app);
  }
});

test('启用后立即渲染出错:启用状态已持久化;错误块「重载」后仍启用(不变成已禁用),重启后仍启用', async () => {
  test.setTimeout(90_000);
  writeFileSync(path.join(ud, 'plugins', '_enabled.json'), JSON.stringify([]));
  let { app, win } = await launch(ud);
  try {
    await openSettingsTab(win, PLUGINS_TAB);
    await win.getByRole('button', { name: ENABLE_ROW }).click();
    // 启用即渲染状态栏项并出错
    await expect(win.locator('footer').getByTitle(RENDER_ERROR)).toBeVisible({ timeout: 15_000 });
    await expect.poll(() => readEnabledIds(ud)).toContain(PLUGIN_ID);

    await win.evaluate(() => globalThis.__continuoTest!.executeCommand('acme.bad.open'));
    const alert = win.getByRole('alert').filter({ hasText: RENDER_ERROR_BLOCK });
    await expect(alert).toBeVisible();
    await alert.getByRole('button', { name: RELOAD }).click();
    // 重载 = 重启插件:仍启用(仍渲染出错),不是「已禁用」占位
    await expect(win.getByRole('alert').filter({ hasText: RENDER_ERROR_BLOCK })).toBeVisible();
    await expect(win.getByText(DISABLED_PLACEHOLDER)).toHaveCount(0);
    await expect(win.locator('footer').getByTitle(RENDER_ERROR)).toBeVisible();
    expect(readEnabledIds(ud)).toContain(PLUGIN_ID);
    // 焦点不掉到 body
    expect(await win.evaluate(() => document.activeElement !== document.body && document.activeElement !== null)).toBe(true);
    await closeDiscardingUnsaved(app);

    ({ app, win } = await launch(ud));
    await expect(win.locator('footer').getByTitle(RENDER_ERROR)).toBeVisible({ timeout: 15_000 });
  } finally {
    await closeDiscardingUnsaved(app);
  }
});
