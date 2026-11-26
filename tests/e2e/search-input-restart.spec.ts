// 搜索输入跨重启恢复(VSCode SearchView 视图状态):查询词与「区分大小写」重启后恢复,不自动重搜,结果为空;
// Enter 后照常搜索。BDD: src/__tests__/workspace-search/ 第 8 条
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { launchContinuo } from './helpers/launch';
import { seedExplorerJson } from './helpers/seed-explorer';
import { closeDiscardingUnsaved } from './helpers/close-app';
import { waitForTestHooks } from './helpers/app-ready';
import { SETTINGS } from './helpers/settings';

const QUERY = /^(搜索|Search|검색)$/;
const MATCH_CASE = /^(区分大小写|Match Case|대\/소문자 구분)$/;
const STATUS = '[data-testid=search-panel] [role=status]';
const ONE_RESULT = /(1 个文件中有 1 个结果|1 result in 1 file|파일 1개에서 결과 1개)/;
const resultsTree = (window: Page) => window.getByRole('tree', { name: /^(搜索结果|Search results|검색 결과)$/ });

let userData = '';
let workspace = '';
const apps: ElectronApplication[] = [];

test.beforeEach(() => {
  userData = mkdtempSync(path.join(tmpdir(), 'ui95b-srch-'));
  workspace = mkdtempSync(path.join(tmpdir(), 'ui95b-srch-ws-'));
  // 区分大小写下只有 a.ts 命中(b.ts 是大写)
  writeFileSync(path.join(workspace, 'a.ts'), 'const s = "foo bar";\n');
  writeFileSync(path.join(workspace, 'b.ts'), 'const s = "FOO BAR";\n');
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

async function openSearch(window: Page) {
  await window.locator('body').click({ position: { x: 1, y: 1 } }).catch(() => {});
  await window.keyboard.press('ControlOrMeta+Shift+KeyF');
  const input = window.getByRole('textbox', { name: QUERY });
  await expect(input).toBeFocused({ timeout: 10_000 });
  return input;
}

test('输入「foo bar」并打开区分大小写 → 重启后输入与选项恢复、不自动重搜;Enter 后照常搜索', async () => {
  test.setTimeout(90_000);
  let { app, main } = await launch();
  let input = await openSearch(main);
  await input.fill('foo bar');
  await main.locator('[data-testid=search-panel]').getByRole('button', { name: MATCH_CASE }).click();
  await expect(main.locator(STATUS)).toHaveText(ONE_RESULT, { timeout: 10_000 });
  await main.waitForTimeout(800); // 窗口段去抖落盘
  await closeDiscardingUnsaved(app);
  apps.splice(apps.indexOf(app), 1);

  ({ app, main } = await launch());
  input = await openSearch(main);
  await expect(input).toHaveValue('foo bar');
  const caseToggle = main.locator('[data-testid=search-panel]').getByRole('button', { name: MATCH_CASE });
  await expect(caseToggle).toHaveAttribute('aria-pressed', 'true');
  // 不自动重搜:超过去抖时间后结果仍为空、状态行无计数
  await main.waitForTimeout(1000);
  await expect(resultsTree(main).getByRole('treeitem')).toHaveCount(0);
  await expect(main.locator(STATUS)).not.toHaveText(ONE_RESULT);

  await input.press('Enter');
  await expect(main.locator(STATUS)).toHaveText(ONE_RESULT, { timeout: 10_000 });
  await expect(resultsTree(main).getByRole('treeitem').first()).toContainText('a.ts');
});
