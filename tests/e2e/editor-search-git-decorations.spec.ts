// 编辑器 tab 标题 / 搜索结果文件名按 git 状态着色(VSCode workbench.editor.decorations.* / search.decorations.*):临时 git
// 仓库里改文件 → tab 着修改色 + M;新文件 → 未跟踪色 + U;侧栏隐藏时 tab 仍随文件变化更新;搜索结果文件行着色 + 字母;
// 关掉设置后消失;拖出到子窗(popout)的编辑器 tab 同样着色并随之更新。
// BDD: src/__tests__/editor-search-git-decorations/
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import type { Locator, Page } from '@playwright/test';
import { test, expect } from './fixtures/with-workspace';
import { DOCK_POPOUT, EDITOR_TABS } from './helpers/editor';
import { expandTreeItem, explorerTreeItem, openTreeItem } from './helpers/explorer';
import { waitForTestHooks } from './helpers/app-ready';

function initRepo(root: string): void {
  const git = (...args: string[]) =>
    execFileSync('git', ['-c', 'user.email=e2e@example.invalid', '-c', 'user.name=e2e', '-c', 'commit.gpgsign=false', ...args], {
      cwd: root,
      stdio: 'ignore',
    });
  git('init', '-q');
  git('add', '.');
  git('commit', '-q', '-m', 'init');
}

async function realFocus(window: Page): Promise<void> {
  // 真实焦点语义(窗口获焦刷新不被模拟焦点干扰;刷新也由 fs 变化触发)
  try {
    const cdp = await window.context().newCDPSession(window);
    await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: false });
  } catch {
    // 不支持该 CDP 域:不影响本用例
  }
}

const tabOf = (page: Page, name: string): Locator =>
  page
    .getByRole('tablist', { name: EDITOR_TABS })
    .locator('div.wm-tab-nav-item')
    .filter({ hasText: new RegExp(`^${name.replace(/\./g, '\\.')}`) })
    .first();
const tabTitle = (page: Page, name: string) => tabOf(page, name).locator('[data-git-title]');
const tabLetter = (page: Page, name: string) => tabOf(page, name).locator('[data-git-letter]');

test('tab 与搜索结果按 git 状态着色;侧栏隐藏时 tab 仍更新;关掉设置后消失', async ({ window, workspaceRoot }) => {
  test.setTimeout(90_000);
  await realFocus(window);
  initRepo(workspaceRoot);
  await expect(explorerTreeItem(window, /^README\.md$/)).toBeVisible({ timeout: 10_000 });
  await expandTreeItem(window, /^src$/);

  await openTreeItem(window, /^a\.ts$/);
  await openTreeItem(window, /^README\.md$/);
  await expect(tabOf(window, 'a.ts')).toBeVisible();
  await expect(tabTitle(window, 'a.ts')).toHaveCount(0);

  // 改文件 → 修改色 + M(非激活 tab 也着色)
  writeFileSync(path.join(workspaceRoot, 'src/a.ts'), 'export const a = 3;\n');
  await expect(tabTitle(window, 'a.ts')).toHaveClass(/\btext-git-modified\b/, { timeout: 10_000 });
  await expect(tabLetter(window, 'a.ts')).toHaveText('M');
  await expect
    .poll(() => tabTitle(window, 'a.ts').evaluate((el) => getComputedStyle(el).color))
    .toBe('rgb(226, 192, 141)');
  // 悬浮提示带状态;可访问名称不带
  await expect(tabOf(window, 'a.ts')).toHaveAttribute('title', /· (已修改|Modified|수정됨)$/);
  await expect(window.getByRole('tab', { name: /^a\.ts$/ })).toBeVisible();

  // 新文件 → 未跟踪色 + U
  writeFileSync(path.join(workspaceRoot, 'src/new.ts'), 'export const n = 1;\n');
  await expect(explorerTreeItem(window, /^new\.ts$/)).toBeVisible({ timeout: 10_000 });
  await openTreeItem(window, /^new\.ts$/);
  await expect(tabTitle(window, 'new.ts')).toHaveClass(/\btext-git-untracked\b/, { timeout: 10_000 });
  await expect(tabLetter(window, 'new.ts')).toHaveText('U');

  // 侧栏隐藏:tab 仍随文件变化更新
  await waitForTestHooks(window);
  await window.evaluate(() => globalThis.__continuoTest!.executeCommand('explorer.toggleSidebar'));
  await expect(explorerTreeItem(window, /^README\.md$/)).toBeHidden({ timeout: 5_000 });
  await expect(tabTitle(window, 'README.md')).toHaveCount(0);
  writeFileSync(path.join(workspaceRoot, 'README.md'), '# changed\n');
  await expect(tabTitle(window, 'README.md')).toHaveClass(/\btext-git-modified\b/, { timeout: 10_000 });

  // 搜索结果文件行:名称着色 + 字母
  await window.evaluate(() => globalThis.__continuoTest!.executeCommand('workbench.action.findInFiles'));
  const panel = window.getByTestId('search-panel');
  await panel.getByRole('textbox', { name: /^(搜索|Search|검색)$/ }).fill('export const');
  // 文件行 title = 相对路径[ · 状态]
  const fileRow = (rel: string) => panel.locator(`[role=treeitem][aria-level="1"][title^="${rel}"]`);
  await expect(fileRow('src/a.ts')).toBeVisible({ timeout: 10_000 });
  await expect(fileRow('src/a.ts').locator('[data-git-title]')).toHaveClass(/\btext-git-modified\b/, { timeout: 10_000 });
  await expect(fileRow('src/a.ts').locator('[data-git-letter]')).toHaveText('M');
  await expect(fileRow('src/new.ts').locator('[data-git-title]')).toHaveClass(/\btext-git-untracked\b/);
  await expect(fileRow('src/new.ts').locator('[data-git-letter]')).toHaveText('U');
  await expect(fileRow('src/b.ts').locator('[data-git-title]')).toHaveCount(0);

  // 关掉设置 → 装饰消失(即时生效)
  await window.evaluate(() => {
    const t = globalThis.__continuoTest!;
    t.setSettingValue('workbench.editor.decorations.colors', false);
    t.setSettingValue('workbench.editor.decorations.badges', false);
    t.setSettingValue('search.decorations.colors', false);
    t.setSettingValue('search.decorations.badges', false);
  });
  await expect(tabTitle(window, 'a.ts')).toHaveCount(0, { timeout: 5_000 });
  await expect(tabLetter(window, 'a.ts')).toHaveCount(0);
  await expect(fileRow('src/a.ts').locator('[data-git-title]')).toHaveCount(0);
  await expect(fileRow('src/a.ts').locator('[data-git-letter]')).toHaveCount(0);
});

test('拖出到子窗的编辑器 tab 着色,并随文件变化更新', async ({ electronApp, window, workspaceRoot }) => {
  test.setTimeout(90_000);
  await realFocus(window);
  initRepo(workspaceRoot);
  await expect(explorerTreeItem(window, /^README\.md$/)).toBeVisible({ timeout: 10_000 });
  await expandTreeItem(window, /^src$/);
  await openTreeItem(window, /^a\.ts$/);
  await openTreeItem(window, /^README\.md$/);
  writeFileSync(path.join(workspaceRoot, 'src/a.ts'), 'export const a = 4;\n');
  await expect(tabTitle(window, 'a.ts')).toHaveClass(/\btext-git-modified\b/, { timeout: 10_000 });

  const popoutBtn = window
    .locator('[data-editor-panel-root]')
    .first()
    .locator('xpath=ancestor::*[contains(@class,"dv-groupview")]')
    .getByRole('button', { name: DOCK_POPOUT });
  await popoutBtn.click();
  await expect.poll(() => electronApp.windows().length).toBeGreaterThan(1);
  const child = electronApp.windows().find((w) => w !== window)!;
  await expect(child.locator('[data-testid=popout-host]')).toBeVisible({ timeout: 10_000 });

  await expect(tabTitle(child, 'a.ts')).toHaveClass(/\btext-git-modified\b/, { timeout: 10_000 });
  await expect(tabLetter(child, 'a.ts')).toHaveText('M');
  await expect(tabTitle(child, 'README.md')).toHaveCount(0);
  writeFileSync(path.join(workspaceRoot, 'README.md'), '# popout\n');
  await expect(tabTitle(child, 'README.md')).toHaveClass(/\btext-git-modified\b/, { timeout: 10_000 });
});

// VSCode:tab 标题过长时截断,标题后的 git 字母始终可见(TabNavItem trailing 槽位,不随标题截断)。
test('长文件名 tab:标题截断,git 字母仍在 tab 边界内可见', async ({ window, workspaceRoot }) => {
  test.setTimeout(60_000);
  await realFocus(window);
  const long = 'a-very-very-long-file-name-that-will-be-truncated-in-the-tab.ts';
  writeFileSync(path.join(workspaceRoot, long), 'export const x = 1;\n');
  initRepo(workspaceRoot);
  writeFileSync(path.join(workspaceRoot, long), 'export const x = 2;\n');
  await openTreeItem(window, new RegExp(`^${long.replace(/[.-]/g, '\\$&')}$`));
  const tab = tabOf(window, long);
  await expect(tabLetter(window, long)).toHaveText('M', { timeout: 10_000 });
  await expect(tabLetter(window, long)).toBeVisible();
  // 标题确实被截断(否则本用例不成立)
  const label = tab.locator('.wm-tab-nav-item__label');
  expect(await label.evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(true);
  const tabBox = (await tab.boundingBox())!;
  const letterBox = (await tabLetter(window, long).boundingBox())!;
  expect(letterBox.width).toBeGreaterThan(0);
  expect(letterBox.x).toBeGreaterThanOrEqual(tabBox.x);
  expect(letterBox.x + letterBox.width).toBeLessThanOrEqual(tabBox.x + tabBox.width);
  // 字母不被标题裁剪:字母右缘在标题可见区域之外(标题的 overflow 裁不到它)
  const labelBox = (await label.boundingBox())!;
  expect(letterBox.x).toBeGreaterThanOrEqual(labelBox.x + labelBox.width - 0.5);
});
