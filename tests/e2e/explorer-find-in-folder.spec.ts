// 资源管理器「在文件夹中查找…」(VSCode filesExplorer.findInFolder;BDD: src/__tests__/explorer-find-in-folder/):
// 真实右键文件夹 → 搜索视图打开,「要包含的文件」= ./src、焦点在查询框,键入后只出该文件夹里的结果。
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { test, expect } from './fixtures/with-workspace';

const FIND_IN_FOLDER = /^(在文件夹中查找…|Find in Folder…|폴더에서 찾기…)/;
const QUERY = /^(搜索|Search|검색)$/;
const INCLUDE = /^(要包含的文件|files to include|포함할 파일)$/;
const rowOf = (window: Page, p: string) => window.locator(`[role=treeitem][title="${p}"]`);
const resultsTree = (window: Page) => window.getByRole('tree', { name: /^(搜索结果|Search results|검색 결과)$/ });

test('右键文件夹「在文件夹中查找…」→ 搜索范围限定该文件夹,焦点进查询框', async ({ window, workspaceRoot }) => {
  writeFileSync(path.join(workspaceRoot, 'top.ts'), 'export const top = 0;\n');
  const src = path.join(workspaceRoot, 'src');
  await expect(rowOf(window, path.join(workspaceRoot, 'top.ts'))).toBeVisible({ timeout: 10_000 });

  await rowOf(window, src).click({ button: 'right' });
  await window.getByRole('menuitem', { name: FIND_IN_FOLDER }).click();

  const query = window.getByRole('textbox', { name: QUERY });
  await expect(query).toBeFocused({ timeout: 10_000 });
  const include = window.locator('[data-testid=search-panel]').getByRole('textbox', { name: INCLUDE });
  await expect(include).toHaveValue('./src');

  await window.keyboard.type('export const');
  const tree = resultsTree(window);
  await expect(tree).toContainText('a.ts', { timeout: 10_000 });
  await expect(tree).toContainText('b.ts');
  await expect(tree).not.toContainText('top.ts');
});
