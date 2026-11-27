// 工作区里有读不了的目录 / 移到废纸篓失败 / 文件名含 `\`(src/__tests__/workspace-scan-unreadable、explorer-trash-failure、
// posix-backslash-filename):
//   - 有 chmod 000 子目录与超过 1024 字节的深路径时,⇧⌘F 与 ⌘P 仍给出其余结果,并提示「已跳过 N 个无法读取的目录」
//   - 只读目录里删除文件 → toast 显示本地化原因(拒绝访问),不含 EACCES 原始串,不弹永久删除框
//   - 文件名 `a\b.txt`(macOS / Linux 合法)→ tab 与标题栏显示完整名字
// 工作区夹具建在 CONTINUO_E2E_FIXTURE_ROOT(缺省系统临时目录)下;权限在用例结束前恢复。root / Windows 跳过。
import { chmodSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { test as base, expect } from './fixtures/with-workspace';
import { waitForTestHooks } from './helpers/app-ready';
import { openQuickOpen } from './helpers/palette';
import { explorerTreeItem, openTreeItem } from './helpers/explorer';
import { editorTab } from './helpers/editor';

const test = base.extend({
  // Playwright 要求 fixture 首参是解构形式(无依赖时为空解构)
  // eslint-disable-next-line no-empty-pattern
  workspaceRoot: async ({}, use) => {
    const base = process.env['CONTINUO_E2E_FIXTURE_ROOT'] ?? tmpdir();
    mkdirSync(base, { recursive: true });
    const root = mkdtempSync(path.join(base, 'ws-'));
    mkdirSync(path.join(root, 'src'));
    writeFileSync(path.join(root, 'README.md'), '# needle\n');
    writeFileSync(path.join(root, 'src/a.ts'), 'export const needle = 1;\n');
    await use(root);
    rmSync(root, { recursive: true, force: true });
  },
});

test.skip(process.platform === 'win32' || process.getuid?.() === 0, 'needs POSIX permissions / path semantics');

const SKIPPED = /(已跳过 \d+ 个无法读取的目录|Skipped \d+ folders? that could not be read|읽을 수 없는 폴더 \d+개를 건너뛰었습니다)/;

/** chmod 000 目录 + 绝对路径超过 1024 字节的深层目录(先短名建、再把父目录改长名)。返回恢复函数。 */
function addUnreadable(root: string): () => void {
  const locked = path.join(root, 'locked');
  mkdirSync(locked);
  writeFileSync(path.join(locked, 'hidden-needle.ts'), 'needle\n');
  chmodSync(locked, 0o000);
  let deep = path.join(root, 's');
  for (const c of ['a', 'b', 'c', 'd']) deep = path.join(deep, c.repeat(200));
  mkdirSync(deep, { recursive: true });
  writeFileSync(path.join(deep, 'deep.ts'), 'needle\n');
  const longTop = path.join(root, 'L'.repeat(240));
  renameSync(path.join(root, 's'), longTop);
  return () => {
    chmodSync(locked, 0o755);
    renameSync(longTop, path.join(root, 's'));
  };
}

async function openSearch(window: Page) {
  await waitForTestHooks(window);
  await window.locator('body').click({ position: { x: 1, y: 1 } }).catch(() => {});
  await window.keyboard.press('ControlOrMeta+Shift+KeyF');
  const input = window.getByRole('textbox', { name: /^(搜索|Search|검색)$/ });
  await expect(input).toBeFocused({ timeout: 10_000 });
  return input;
}

test('⇧⌘F:有不可读目录与超长路径 → 仍出结果,并提示跳过的目录数', async ({ window, workspaceRoot }) => {
  const restore = addUnreadable(workspaceRoot);
  try {
    const input = await openSearch(window);
    await input.fill('needle');
    const status = window.locator('[data-testid=search-panel] [role=status]');
    await expect(status).toContainText(SKIPPED, { timeout: 15_000 });
    await expect(status).not.toContainText(/失败|failed|실패/i);
    const tree = window.getByRole('tree', { name: /^(搜索结果|Search results|검색 결과)$/ });
    await expect(tree.getByRole('treeitem', { name: /a\.ts/ }).first()).toBeVisible();
    await expect(tree.getByRole('treeitem', { name: /README\.md/ }).first()).toBeVisible();
  } finally {
    restore();
  }
});

test('⌘P:有不可读目录与超长路径 → 仍列出文件,并提示跳过的目录数', async ({ window, workspaceRoot }) => {
  const restore = addUnreadable(workspaceRoot);
  try {
    await openQuickOpen(window);
    const modal = window.locator('.wm-modal-content');
    await expect(modal.locator('li', { hasText: 'a.ts' })).toBeVisible({ timeout: 15_000 });
    await expect(modal.locator('li', { hasText: 'README.md' })).toBeVisible();
    await expect(modal.locator('[role=status]')).toContainText(SKIPPED);
    await expect(modal).not.toContainText(/扫描工作区文件失败|Failed to scan workspace files/);
  } finally {
    restore();
  }
});

test('只读目录里删除文件 → toast 显示本地化原因,不含 EACCES 原始串,不弹永久删除框', async ({
  window,
  workspaceRoot,
}) => {
  const ro = path.join(workspaceRoot, 'ro');
  mkdirSync(ro);
  writeFileSync(path.join(ro, 'a.txt'), 'x');
  chmodSync(ro, 0o555);
  try {
    await waitForTestHooks(window);
    await window.evaluate(() => globalThis.__continuoTest!.setSettingValue('explorer.confirmDelete', false));
    const dir = explorerTreeItem(window, /^ro$/);
    await expect(dir).toBeVisible({ timeout: 10_000 });
    await dir.click();
    const file = window.locator(`[role=treeitem][title="${path.join(ro, 'a.txt')}"]`);
    await expect(file).toBeVisible({ timeout: 5_000 });
    await file.click();
    await file.press('Delete');
    const toast = window.locator('.toast[data-level="error"]');
    await expect(toast).toContainText(/[「“']a\.txt[」”'].*(拒绝访问|Access denied|액세스 거부)/, { timeout: 10_000 });
    await expect(toast).not.toContainText(/EACCES|permission denied|rename/);
    await expect(toast).not.toContainText(ro);
    await expect(window.getByRole('alertdialog')).toHaveCount(0);
  } finally {
    chmodSync(ro, 0o755);
  }
});

test('文件名含 `\\` → tab 与标题栏显示完整名字', async ({ window, workspaceRoot }) => {
  const name = 'a\\b.txt';
  writeFileSync(path.join(workspaceRoot, name), 'hello\n');
  await openTreeItem(window, /^a\\b\.txt$/);
  await expect(editorTab(window, name)).toHaveText(new RegExp(`^${name.replace(/[.\\]/g, '\\$&')}`), {
    timeout: 10_000,
  });
  await expect(window.locator('header').first()).toContainText(name);
});
