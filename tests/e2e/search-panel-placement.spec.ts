// 搜索面板落点(BDD: src/__tests__/workspace-search/ 1a):只有一个编辑器组时 ⇧⌘F 打开的搜索面板放在编辑器左侧的独立 dock 组
//(VSCode 侧栏位置),点结果后结果列表仍可见;用户把它拖进编辑器组后重启,布局照旧、再按 ⇧⌘F 不被挪回。
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { launchContinuo } from './helpers/launch';
import { seedExplorerJson } from './helpers/seed-explorer';
import { closeDiscardingUnsaved } from './helpers/close-app';
import { waitForTestHooks } from './helpers/app-ready';
import { openWorkspaceFile } from './helpers/editor';
import { SETTINGS } from './helpers/settings';

const SEARCH_PANEL = '[data-testid=search-panel]';
const QUERY = /^(搜索|Search|검색)$/;
const SEARCH_TAB = /^(搜索|Search|검색)$/;
const resultsTree = (main: Page) => main.getByRole('tree', { name: /^(搜索结果|Search results|검색 결과)$/ });
let userData = '';
let workspace = '';
const apps: ElectronApplication[] = [];

test.beforeEach(() => {
  userData = mkdtempSync(path.join(tmpdir(), 'ui151-place-'));
  workspace = mkdtempSync(path.join(tmpdir(), 'ui151-place-ws-'));
  writeFileSync(path.join(workspace, 'a.ts'), 'export const a = 1;\n');
  writeFileSync(path.join(workspace, 'b.ts'), 'const needle = 2;\n');
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
  await expect(main.getByRole('button', { name: SETTINGS })).toBeVisible({ timeout: 15_000 });
  await waitForTestHooks(main);
  return { app, main };
}

const groupOf = (main: Page, inner: string) => main.locator('.dv-groupview').filter({ has: main.locator(inner) });

test('单组:⇧⌘F 搜索放在编辑器左侧的独立组;点结果后文件在编辑器组打开,结果列表仍可见', async () => {
  test.setTimeout(90_000);
  const { main } = await launch();
  await openWorkspaceFile(main, ['a.ts']);
  await main.keyboard.press('ControlOrMeta+Shift+KeyF');
  const input = main.getByRole('textbox', { name: QUERY });
  await expect(input).toBeFocused({ timeout: 10_000 });
  // 两个组、同时可见,搜索在左
  await expect(main.locator('.dv-groupview')).toHaveCount(2);
  const searchBox = (await groupOf(main, SEARCH_PANEL).boundingBox())!;
  const editorBox = (await groupOf(main, '[data-editor-panel-root]').boundingBox())!;
  expect(searchBox.x + searchBox.width).toBeLessThanOrEqual(editorBox.x + 1);
  expect(searchBox.width).toBeGreaterThan(200);
  expect(searchBox.width).toBeLessThan(editorBox.width);

  await input.fill('needle');
  const tree = resultsTree(main);
  await expect(tree.getByRole('treeitem')).toHaveCount(2, { timeout: 10_000 });
  await tree.getByRole('treeitem').nth(1).click();
  await expect
    .poll(() => main.evaluate(() => globalThis.__continuoTest!.getEditorActiveTabId()), { timeout: 10_000 })
    .toMatch(/b\.ts$/);
  await expect(main.locator('[data-editor-panel-root] .cm-content')).toContainText('const needle');
  await expect(tree).toBeVisible();
  await expect(main.locator(SEARCH_PANEL)).toBeVisible();
});

test('用户把搜索拖进编辑器组 → 重启后仍在编辑器组,再按 ⇧⌘F 只聚焦不挪回左侧', async () => {
  test.setTimeout(120_000);
  let { app, main } = await launch();
  await openWorkspaceFile(main, ['a.ts']);
  await main.keyboard.press('ControlOrMeta+Shift+KeyF');
  await expect(main.getByRole('textbox', { name: QUERY })).toBeFocused({ timeout: 10_000 });
  await expect(main.locator('.dv-groupview')).toHaveCount(2);
  // 搜索 tab 拖进编辑器组中央(叠放)
  const target = groupOf(main, '[data-editor-panel-root]').locator('.dv-content-container');
  const box = (await target.boundingBox())!;
  await main
    .locator('.dv-tab')
    .filter({ hasText: SEARCH_TAB })
    .dragTo(target, { targetPosition: { x: box.width / 2, y: box.height / 2 } });
  await expect(main.locator('.dv-groupview')).toHaveCount(1, { timeout: 10_000 });
  await main.waitForTimeout(800); // 布局自动保存去抖(300ms)落盘
  await closeDiscardingUnsaved(app);
  apps.splice(apps.indexOf(app), 1);

  ({ app, main } = await launch());
  await expect(main.locator('.dv-tab').filter({ hasText: SEARCH_TAB })).toHaveCount(1, { timeout: 10_000 });
  await expect(main.locator('.dv-groupview')).toHaveCount(1);
  await main.locator('body').click({ position: { x: 1, y: 1 } }).catch(() => {});
  await main.keyboard.press('ControlOrMeta+Shift+KeyF');
  await expect(main.getByRole('textbox', { name: QUERY })).toBeFocused({ timeout: 10_000 });
  await expect(main.locator('.dv-groupview')).toHaveCount(1);
});
