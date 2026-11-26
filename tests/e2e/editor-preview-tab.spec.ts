// 预览编辑器(VSCode workbench.editor.enablePreview,默认开):资源管理器单击以预览方式打开(斜体标题),再单击别的文件原位替换;
// 编辑 / 双击 tab / 双击文件后常驻;设置关闭后单击也常驻;重启后预览 tab 仍是预览。BDD: src/__tests__/editor-preview-tab/
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { launchContinuo } from './helpers/launch';
import { seedExplorerJson } from './helpers/seed-explorer';
import { closeDiscardingUnsaved } from './helpers/close-app';
import { waitForTestHooks } from './helpers/app-ready';
import { EDITOR_TABS, editorTab } from './helpers/editor';
import { EXPLORER_SHOW, explorerTreeItem } from './helpers/explorer';
import { CLOSE_SETTINGS, EDITOR_TAB, SETTINGS, SETTINGS_NAV } from './helpers/settings';

const ENABLE_PREVIEW = /^(启用预览编辑器|Enable preview editors|미리 보기 편집기 사용)$/;

let userData = '';
let workspace = '';
const apps: ElectronApplication[] = [];

test.beforeEach(() => {
  userData = mkdtempSync(path.join(tmpdir(), 'ui103a-pv-'));
  workspace = mkdtempSync(path.join(tmpdir(), 'ui103a-pv-ws-'));
  for (const name of ['a.ts', 'b.ts', 'c.md']) writeFileSync(path.join(workspace, name), `// ${name}\n`);
  seedExplorerJson(userData, { root: workspace });
});

test.afterEach(async () => {
  for (const app of apps.splice(0)) await closeDiscardingUnsaved(app).catch(() => undefined);
  rmSync(userData, { recursive: true, force: true });
  rmSync(workspace, { recursive: true, force: true });
});

async function launch(): Promise<{ app: ElectronApplication; main: Page }> {
  const app = await launchContinuo(userData);
  apps.push(app);
  const main = await app.firstWindow();
  await main.waitForLoadState('domcontentloaded');
  const cdp = await main.context().newCDPSession(main);
  await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: false });
  await expect(main.getByRole('button', { name: SETTINGS })).toBeVisible({ timeout: 15_000 });
  await waitForTestHooks(main);
  return { app, main };
}

const tabs = (main: Page) => main.getByRole('tablist', { name: EDITOR_TABS }).getByRole('tab');
const fileRow = (main: Page, name: string) => explorerTreeItem(main, new RegExp(`^${name.replace('.', '\\.')}$`));
/** tab 标题是否斜体(预览 tab)。 */
const isItalic = (main: Page, name: string) =>
  editorTab(main, name).evaluate((el) => el.querySelector('[data-preview="true"]') !== null && getComputedStyle(el.querySelector('[data-preview="true"]')!).fontStyle === 'italic');

async function clickFile(main: Page, name: string): Promise<void> {
  const row = fileRow(main, name);
  await expect(row).toBeVisible({ timeout: 10_000 });
  await row.click();
  await expect(tabs(main).filter({ hasText: name })).toHaveCount(1, { timeout: 10_000 });
}

test('单击打开为预览(斜体),再单击别的文件原位替换;Markdown 同样适用', async () => {
  const { main } = await launch();
  await clickFile(main, 'a.ts');
  await expect(tabs(main)).toHaveCount(1);
  expect(await isItalic(main, 'a.ts')).toBe(true);
  // 读屏名称就是文件名,不带后缀
  await expect(main.getByRole('tab', { name: 'a.ts', exact: true })).toHaveCount(1);
  await clickFile(main, 'b.ts');
  await expect(tabs(main)).toHaveCount(1);
  await expect(tabs(main).first()).toContainText('b.ts');
  await clickFile(main, 'c.md');
  await expect(tabs(main)).toHaveCount(1);
  expect(await isItalic(main, 'c.md')).toBe(true);
});

test('编辑后转常驻:斜体消失,再单击别的文件新增 tab', async () => {
  const { main } = await launch();
  await clickFile(main, 'a.ts');
  const content = main.locator('.cm-content').first();
  await expect(content).toBeVisible({ timeout: 10_000 });
  await content.click();
  await main.keyboard.type('x');
  await expect.poll(() => isItalic(main, 'a.ts')).toBe(false);
  await clickFile(main, 'b.ts');
  await expect(tabs(main)).toHaveCount(2);
  expect(await isItalic(main, 'b.ts')).toBe(true);
});

test('双击 tab 固定;资源管理器双击文件常驻', async () => {
  const { main } = await launch();
  await clickFile(main, 'a.ts');
  await editorTab(main, 'a.ts').dblclick();
  await expect.poll(() => isItalic(main, 'a.ts')).toBe(false);
  await clickFile(main, 'b.ts');
  await expect(tabs(main)).toHaveCount(2);
  // 双击预览中的 b.ts 文件 → 常驻;再单击 c.md 新增
  await fileRow(main, 'b.ts').dblclick();
  await expect.poll(() => isItalic(main, 'b.ts')).toBe(false);
  await clickFile(main, 'c.md');
  await expect(tabs(main)).toHaveCount(3);
});

test('设置关闭(编辑器设置页)→ 单击也常驻,已有预览 tab 转常驻', async () => {
  const { main } = await launch();
  await clickFile(main, 'a.ts');
  expect(await isItalic(main, 'a.ts')).toBe(true);
  await main.getByRole('button', { name: SETTINGS }).click();
  const nav = main.getByRole('navigation', { name: SETTINGS_NAV });
  await expect(nav).toBeVisible({ timeout: 10_000 });
  await nav.getByRole('button', { name: EDITOR_TAB }).click();
  const toggle = main.getByRole('switch', { name: ENABLE_PREVIEW });
  await expect(toggle).toHaveAttribute('aria-checked', 'true');
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-checked', 'false');
  await expect.poll(() => main.evaluate(() => globalThis.__continuoTest!.getSettingValue('workbench.editor.enablePreview'))).toBe(false);
  await main.getByRole('button', { name: CLOSE_SETTINGS }).click();
  await main.getByRole('button', { name: EXPLORER_SHOW }).click(); // 设置页打开时侧栏收起
  await clickFile(main, 'b.ts');
  await expect(tabs(main)).toHaveCount(2);
  expect(await isItalic(main, 'a.ts')).toBe(false);
  expect(await isItalic(main, 'b.ts')).toBe(false);
});

test('重启后预览 tab 仍是预览(常驻 tab 仍常驻),再单击别的文件替换它', async () => {
  test.setTimeout(90_000);
  let { app, main } = await launch();
  await fileRow(main, 'a.ts').dblclick();
  await expect(tabs(main)).toHaveCount(1, { timeout: 10_000 });
  await clickFile(main, 'b.ts');
  await expect(tabs(main)).toHaveCount(2);
  await main.waitForTimeout(800); // 会话自动保存去抖落盘
  await closeDiscardingUnsaved(app);
  apps.splice(apps.indexOf(app), 1);

  ({ app, main } = await launch());
  await expect(tabs(main)).toHaveCount(2, { timeout: 10_000 });
  await expect.poll(() => isItalic(main, 'b.ts')).toBe(true);
  expect(await isItalic(main, 'a.ts')).toBe(false);
  await clickFile(main, 'c.md');
  await expect(tabs(main)).toHaveCount(2);
  await expect(tabs(main).filter({ hasText: 'b.ts' })).toHaveCount(0);
});
