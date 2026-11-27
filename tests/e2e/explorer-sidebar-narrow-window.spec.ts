// 极窄窗口(BDD: src/__tests__/explorer-sidebar/ 窄窗口让位):资源管理器 + 搜索组 + 编辑组在 400×800 时,侧栏缩到最小宽
// dock 仍放不下 → 侧栏收起,所有 dock 组(含最右组的「⋯」按钮)都在窗口内;单组时 400 宽仍保留最小宽侧栏。
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { ElectronApplication, Page } from '@playwright/test';
import { test, expect } from './fixtures/with-workspace';
import { waitForTestHooks } from './helpers/app-ready';
import { launchContinuo } from './helpers/launch';
import { seedExplorerJson } from './helpers/seed-explorer';
import { closeDiscardingUnsaved } from './helpers/close-app';

const QUERY = /^(搜索|Search|검색)$/;
const sidebar = (window: Page) => window.locator('aside[data-workbench-part="sidebar"]');
const groupsRightEdge = (window: Page) =>
  window.evaluate(() => Math.max(...[...document.querySelectorAll('.dv-groupview')].map((g) => g.getBoundingClientRect().right)));

test('400×800:单组保留最小宽侧栏;再加搜索组放不下 → 侧栏收起,所有组都在窗口内', async ({ window, electronApp }) => {
  await waitForTestHooks(window);
  await window.locator('text=README.md').first().dblclick();
  await expect(window.locator('.dv-groupview')).toHaveCount(1, { timeout: 10_000 });
  await electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setSize(400, 800));
  await expect.poll(() => window.evaluate(() => globalThis.innerWidth)).toBe(400);
  await expect(sidebar(window)).toBeVisible();
  await expect.poll(() => groupsRightEdge(window)).toBeLessThanOrEqual(400.5);

  await window.keyboard.press('ControlOrMeta+Shift+KeyF');
  await expect(window.getByRole('textbox', { name: QUERY })).toBeVisible({ timeout: 10_000 });
  await expect(window.locator('.dv-groupview')).toHaveCount(2);
  await expect(sidebar(window)).toBeHidden({ timeout: 5_000 });
  await expect.poll(() => groupsRightEdge(window)).toBeLessThanOrEqual(400.5);
  // 最右组的头部动作按钮在窗口内
  const actions = await window.evaluate(() =>
    [...document.querySelectorAll('.dv-groupview')].map((g) => {
      const btn = g.querySelector('.dv-right-actions-container button');
      return btn ? btn.getBoundingClientRect().right : 0;
    }),
  );
  for (const right of actions) expect(right).toBeLessThanOrEqual(400.5);

  // 用户在窄窗口里再打开侧栏:不被立刻收回
  await window.keyboard.press('ControlOrMeta+KeyB');
  await expect(sidebar(window)).toBeVisible();
  await window.waitForTimeout(300);
  await expect(sidebar(window)).toBeVisible();
});

// 第五十三轮审计 3:1000 宽 ⌘\ 拆 4 组 → 缩到 600 自动收起 → ⌘B 打开 → 重启:侧栏仍显示,explorer.json 不被改写成 sidebarOpen:false
//(此前启动时 dock 布局未恢复,网格最小宽 0 被记成「放得下」基准,恢复 4 组后误判成「放得下 → 放不下」把侧栏收起并落盘)。
test.describe('窄窗口里重新打开的侧栏,重启后保持', () => {
  let userData = '';
  let workspace = '';
  const apps: ElectronApplication[] = [];

  test.beforeEach(() => {
    userData = mkdtempSync(path.join(tmpdir(), 'ui157-sb-'));
    workspace = mkdtempSync(path.join(tmpdir(), 'ui157-sb-ws-'));
    writeFileSync(path.join(workspace, 'README.md'), '# x\n');
    seedExplorerJson(userData, { root: workspace });
  });

  test.afterEach(async () => {
    for (const app of apps.splice(0)) await closeDiscardingUnsaved(app).catch(() => undefined);
    rmSync(userData, { recursive: true, force: true });
    rmSync(workspace, { recursive: true, force: true });
  });

  async function launch(): Promise<{ app: ElectronApplication; window: Page }> {
    const app = await launchContinuo(userData);
    apps.push(app);
    const window = await app.firstWindow();
    await window.waitForLoadState('domcontentloaded');
    await waitForTestHooks(window);
    return { app, window };
  }

  /** explorer.json 各窗口段的 layoutUi.sidebarOpen。 */
  const persistedSidebarOpen = (): unknown[] => {
    const data = JSON.parse(readFileSync(path.join(userData, 'explorer.json'), 'utf8')) as {
      windows?: { layoutUi?: { sidebarOpen?: unknown } }[];
    };
    return (data.windows ?? []).map((w) => w.layoutUi?.sidebarOpen);
  };

  test('拆 4 组 → 缩窄自动收起 → ⌘B 打开 → 重启:侧栏仍显示,持久化仍是 true', async () => {
    test.setTimeout(120_000);
    let { app, window } = await launch();
    await electronApp(app).setSize(1000, 800);
    await expect.poll(() => window.evaluate(() => globalThis.innerWidth)).toBe(1000);
    await window.locator('text=README.md').first().dblclick();
    const cm = window.locator('[data-editor-panel-root] .cm-content').first();
    await expect(cm).toBeVisible({ timeout: 15_000 });
    for (let i = 0; i < 3; i++) {
      await window.locator('[data-editor-panel-root] .cm-content').last().click();
      await window.keyboard.press('ControlOrMeta+Backslash');
      await expect(window.locator('[data-editor-panel-root]')).toHaveCount(i + 2, { timeout: 10_000 });
    }
    await expect(sidebar(window)).toBeVisible();
    await electronApp(app).setSize(600, 800);
    await expect.poll(() => window.evaluate(() => globalThis.innerWidth)).toBe(600);
    await expect(sidebar(window)).toBeHidden({ timeout: 5_000 });
    await window.keyboard.press('ControlOrMeta+KeyB');
    await expect(sidebar(window)).toBeVisible();
    await expect.poll(persistedSidebarOpen, { timeout: 10_000 }).toEqual([true]);
    await closeDiscardingUnsaved(app);
    apps.splice(apps.indexOf(app), 1);

    ({ app, window } = await launch());
    await expect.poll(() => window.evaluate(() => globalThis.innerWidth)).toBe(600);
    await expect(window.locator('[data-editor-panel-root]')).toHaveCount(4, { timeout: 15_000 });
    await expect(sidebar(window)).toBeVisible();
    await window.waitForTimeout(1500); // 布局恢复 / popout 落定 / 自动保存去抖之后仍显示
    await expect(sidebar(window)).toBeVisible();
    await closeDiscardingUnsaved(app);
    apps.splice(apps.indexOf(app), 1);
    expect(persistedSidebarOpen()).toEqual([true]);
  });
});

/** 主窗 BrowserWindow 操作(e2e 改窗口尺寸)。 */
function electronApp(app: ElectronApplication) {
  return {
    setSize: (w: number, h: number) =>
      app.evaluate(({ BrowserWindow }, [width, height]) => BrowserWindow.getAllWindows()[0]!.setSize(width!, height!), [w, h]),
  };
}
