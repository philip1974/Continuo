// 重启后组内 MRU:恢复布局后不点 tab 就新建面板再关掉 → 回到恢复时的活动面板,而不是组里最后一个 tab(VSCode:关闭活动编辑器
// 后激活最近使用的)。BDD: src/__tests__/dock-terminal-vscode-focus/ 第 3 条(组内)。
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { launchContinuo } from './helpers/launch';
import { seedExplorerJson } from './helpers/seed-explorer';
import { closeDiscardingUnsaved } from './helpers/close-app';
import { waitForTestHooks } from './helpers/app-ready';
import { openWorkspaceFile } from './helpers/editor';
import { CLOSE_SETTINGS, SETTINGS } from './helpers/settings';

const SEARCH_PANEL = '[data-testid=search-panel]';
let userData = '';
let workspace = '';
const apps: ElectronApplication[] = [];

test.beforeEach(() => {
  userData = mkdtempSync(path.join(tmpdir(), 'ui52u-mru-'));
  workspace = mkdtempSync(path.join(tmpdir(), 'ui52u-mru-ws-'));
  writeFileSync(path.join(workspace, 'a.ts'), 'export const a = 1;\n');
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

test('编辑器(活动)与搜索同组:重启后不点 tab,新建设置面板再关掉 → 回到编辑器', async () => {
  test.setTimeout(90_000);
  let { app, main } = await launch();
  await openWorkspaceFile(main, ['a.ts']);
  await main.keyboard.press('ControlOrMeta+Shift+KeyF');
  await expect(main.locator(SEARCH_PANEL)).toBeVisible({ timeout: 10_000 });
  // 搜索新建在编辑器左侧的独立组(workspace-search 1a)→ 把它的 tab 拖进编辑器组中央,成为组里最后一个 tab;切回编辑器作为活动面板
  const target = main
    .locator('.dv-groupview')
    .filter({ has: main.locator('[data-editor-panel-root]') })
    .locator('.dv-content-container');
  const box = (await target.boundingBox())!;
  await main
    .locator('.dv-tab')
    .filter({ hasText: /^(搜索|Search|검색)$/ })
    .dragTo(target, { targetPosition: { x: box.width / 2, y: box.height / 2 } });
  await expect(main.locator('.dv-groupview')).toHaveCount(1, { timeout: 10_000 });
  await main.evaluate(() => globalThis.__continuoTest!.focusPanel('editor'));
  await expect(main.locator(SEARCH_PANEL)).toBeHidden();
  await expect(main.locator('main .cm-content')).toBeVisible();
  await main.waitForTimeout(800); // 布局自动保存去抖(300ms)落盘
  await closeDiscardingUnsaved(app);
  apps.splice(apps.indexOf(app), 1);

  ({ app, main } = await launch());
  await expect(main.locator('main .cm-content')).toBeVisible({ timeout: 10_000 });
  await expect(main.locator(SEARCH_PANEL)).toBeHidden();
  await main.getByRole('button', { name: SETTINGS }).click();
  const close = main.getByRole('button', { name: CLOSE_SETTINGS });
  await expect(close).toBeVisible({ timeout: 10_000 });
  await close.click();
  await expect(close).toHaveCount(0, { timeout: 10_000 });
  await expect(main.locator('main .cm-content')).toBeVisible();
  await expect(main.locator(SEARCH_PANEL)).toBeHidden();
});
