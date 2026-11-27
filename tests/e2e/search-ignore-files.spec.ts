// 在文件中查找与 Quick Open 遵从 .gitignore / .ignore(VSCode search.useIgnoreFiles 默认开;BDD: src/__tests__/search-ignore-files/):
// 非 git 仓库同样读;搜索视图排除框旁「使用排除设置与忽略文件」关 → 忽略文件里的与构建产物目录照常搜。
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { test, expect } from './fixtures/with-workspace';
import { waitForTestHooks } from './helpers/app-ready';
import { openQuickOpen, quickOpenInput } from './helpers/palette';

const QUERY = /^(搜索|Search|검색)$/;
const DETAILS = /^(切换搜索详细信息|Toggle Search Details|검색 세부 정보 설정\/해제)$/;
const USE_EXCLUDES = /^(使用「排除设置」与「忽略文件」|Use Exclude Settings and Ignore Files|제외 설정 및 무시 파일 사용)$/;
const resultsTree = (window: Page) => window.getByRole('tree', { name: /^(搜索结果|Search results|검색 결과)$/ });

function seed(root: string): void {
  const write = (rel: string, text: string) => {
    mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    writeFileSync(path.join(root, rel), text);
  };
  write('.gitignore', 'logs/\n*.local\n');
  write('src/kept.ts', 'const needle = 1;\n');
  write('logs/today.txt', 'needle\n');
  write('config.local', 'needle\n');
  write('dist/bundle.js', 'needle\n');
  write('pkg/.gitignore', 'secret.ts\n');
  write('pkg/secret.ts', 'needle\n');
}

const fileRows = (window: Page) =>
  resultsTree(window)
    .locator('[role=treeitem][aria-level="1"]')
    .evaluateAll((els) => els.map((el) => el.getAttribute('aria-label') ?? el.textContent ?? ''));

test('在文件中查找:默认跳过 .gitignore 匹配的文件;关闭开关后照常搜(含构建产物目录)', async ({ window, workspaceRoot }) => {
  seed(workspaceRoot);
  await waitForTestHooks(window);
  await window.keyboard.press('ControlOrMeta+Shift+KeyF');
  const input = window.getByRole('textbox', { name: QUERY });
  await expect(input).toBeFocused({ timeout: 10_000 });
  await input.fill('needle');
  const tree = resultsTree(window);
  await expect(tree.locator('[role=treeitem][aria-level="1"]')).toHaveCount(1, { timeout: 10_000 });
  expect((await fileRows(window)).join('|')).toContain('kept.ts');

  await window.getByRole('button', { name: DETAILS }).click();
  const toggle = window.getByRole('button', { name: USE_EXCLUDES });
  await expect(toggle).toHaveAttribute('aria-pressed', 'true');
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-pressed', 'false');
  await expect(tree.locator('[role=treeitem][aria-level="1"]')).toHaveCount(5, { timeout: 10_000 });
  const rows = (await fileRows(window)).join('|');
  for (const name of ['kept.ts', 'today.txt', 'config.local', 'bundle.js', 'secret.ts']) expect(rows).toContain(name);
});

test('Quick Open:.gitignore 匹配的文件不在候选里', async ({ window, workspaceRoot }) => {
  seed(workspaceRoot);
  await openQuickOpen(window);
  const input = quickOpenInput(window);
  await expect(window.locator('.wm-modal-content')).toContainText('kept.ts', { timeout: 10_000 });
  const titles = () => window.locator('.wm-modal-content li').evaluateAll((els) => els.map((el) => el.getAttribute('title')));
  await input.fill('.');
  await expect.poll(titles).toContain('src/kept.ts');
  const all = await titles();
  expect(all).not.toContain('logs/today.txt');
  expect(all).not.toContain('config.local');
  expect(all).not.toContain('pkg/secret.ts');
});
