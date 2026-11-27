// 磁盘上 NFD 编码的文件名(如韩文;macOS git 默认 core.precomposeunicode 输出 NFC)照常有 git 颜色与字母:
// 资源管理器行、编辑器 tab、搜索结果文件行。
// BDD: src/__tests__/explorer-git-decorations/ · src/__tests__/editor-search-git-decorations/
import { execFileSync } from 'node:child_process';
import { readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { test, expect } from './fixtures/with-workspace';
import { EDITOR_TABS } from './helpers/editor';
import { expandTreeItem, explorerTreeItem, openTreeItem } from './helpers/explorer';

const NFD = '한'; // 한(初声 + 中声 + 终声)
const NFC = NFD.normalize('NFC');
const FILE = `${NFD}.ts`;

const row = (window: Page) => explorerTreeItem(window, new RegExp(`^${FILE.replace('.', '\\.')}$`));

test('NFD 文件名:资源管理器 / tab / 搜索结果都有 git 修改色与 M', async ({ window, workspaceRoot }) => {
  test.setTimeout(90_000);
  try {
    const cdp = await window.context().newCDPSession(window);
    await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: false });
  } catch {
    // 不支持该 CDP 域:不影响本用例
  }
  writeFileSync(path.join(workspaceRoot, 'src', FILE), 'export const k = 1;\n');
  // 前提:磁盘上确实是 NFD(APFS 保留创建时的形式)
  expect(readdirSync(path.join(workspaceRoot, 'src'))).toContain(FILE);
  const git = (...args: string[]) =>
    execFileSync('git', ['-c', 'user.email=e2e@example.invalid', '-c', 'user.name=e2e', '-c', 'commit.gpgsign=false', ...args], {
      cwd: workspaceRoot,
      stdio: 'ignore',
    });
  git('init', '-q');
  git('add', '.');
  git('commit', '-q', '-m', 'init');

  await expect(explorerTreeItem(window, /^README\.md$/)).toBeVisible({ timeout: 10_000 });
  await expandTreeItem(window, /^src$/);
  await expect(row(window)).toBeVisible({ timeout: 10_000 });
  writeFileSync(path.join(workspaceRoot, 'src', FILE), 'export const k = 2;\n');

  // 资源管理器行
  await expect(row(window).locator('span.truncate')).toHaveClass(/\btext-git-modified\b/, { timeout: 10_000 });
  await expect(row(window)).toContainText(/M$/);

  // 编辑器 tab
  await openTreeItem(window, new RegExp(`^${FILE.replace('.', '\\.')}$`));
  const tab = window
    .getByRole('tablist', { name: EDITOR_TABS })
    .locator('div.wm-tab-nav-item')
    .filter({ hasText: NFD })
    .first();
  await expect(tab.locator('[data-git-title]')).toHaveClass(/\btext-git-modified\b/, { timeout: 10_000 });
  await expect(tab.locator('[data-git-letter]')).toHaveText('M');

  // 搜索结果文件行
  await window.evaluate(() => globalThis.__continuoTest!.executeCommand('workbench.action.findInFiles'));
  const panel = window.getByTestId('search-panel');
  await panel.getByRole('textbox', { name: /^(搜索|Search|검색)$/ }).fill('export const k');
  const fileRow = panel
    .locator('[role=treeitem][aria-level="1"]')
    .filter({ has: window.locator('[data-git-title]') })
    .first();
  await expect(fileRow).toBeVisible({ timeout: 10_000 });
  expect((await fileRow.getAttribute('title'))?.normalize('NFC')).toMatch(new RegExp(`^src/${NFC}\\.ts`));
  await expect(fileRow.locator('[data-git-title]')).toHaveClass(/\btext-git-modified\b/);
  await expect(fileRow.locator('[data-git-letter]')).toHaveText('M');
});
