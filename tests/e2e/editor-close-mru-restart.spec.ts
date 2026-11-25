// 重启后关闭活动编辑器 tab → 回到重启前最近使用的 tab(VSCode focusRecentEditorAfterClose + 组 MRU 随工作区状态持久化)。
// BDD: src/__tests__/editor-close-mru/ 第 5 条
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { launchContinuo } from './helpers/launch';
import { seedExplorerJson } from './helpers/seed-explorer';
import { closeDiscardingUnsaved } from './helpers/close-app';
import { waitForTestHooks } from './helpers/app-ready';
import { EDITOR_TABS, editorTab, openWorkspaceFile } from './helpers/editor';
import { SETTINGS } from './helpers/settings';

let userData = '';
let workspace = '';
const apps: ElectronApplication[] = [];

test.beforeEach(() => {
  userData = mkdtempSync(path.join(tmpdir(), 'ui55u-mru-'));
  workspace = mkdtempSync(path.join(tmpdir(), 'ui55u-mru-ws-'));
  for (const name of ['a.ts', 'b.ts', 'c.ts']) writeFileSync(path.join(workspace, name), `export const x = '${name}';\n`);
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

const activeTab = (main: Page) =>
  main.getByRole('tablist', { name: EDITOR_TABS }).getByRole('tab', { selected: true });

test('a → b → c,切回 a 再切到 c;重启后关 c → 回到 a(重启前最近使用),不是相邻的 b', async () => {
  test.setTimeout(90_000);
  let { app, main } = await launch();
  await openWorkspaceFile(main, ['a.ts']);
  await openWorkspaceFile(main, ['b.ts']);
  await openWorkspaceFile(main, ['c.ts']);
  await editorTab(main, /^a\.ts/).click();
  await expect(activeTab(main)).toContainText('a.ts');
  await editorTab(main, /^c\.ts/).click();
  await expect(activeTab(main)).toContainText('c.ts');
  await main.waitForTimeout(800); // 会话自动保存去抖落盘
  await closeDiscardingUnsaved(app);
  apps.splice(apps.indexOf(app), 1);

  ({ app, main } = await launch());
  await expect(main.getByRole('tablist', { name: EDITOR_TABS }).getByRole('tab')).toHaveCount(3, { timeout: 10_000 });
  await expect(activeTab(main)).toContainText('c.ts');
  await main.getByRole('button', { name: /^(关闭 c\.ts|Close c\.ts|c\.ts 닫기)$/ }).click();
  await expect(main.getByRole('tablist', { name: EDITOR_TABS }).getByRole('tab')).toHaveCount(2, { timeout: 5_000 });
  await expect(activeTab(main)).toContainText('a.ts');
});
