// 同名文件 root/a.ts + src/a.ts → 两个独立 tab(以 filePath 区分,而非 basename).
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { test, expect } from './fixtures/with-workspace';
import { expandTreeItem, explorerTreeItem } from './helpers/explorer';
import { EDITOR_TABS } from './helpers/editor';

test('root/a.ts + src/a.ts 都打开 → 两个 tab 独立', async ({ window, workspaceRoot }) => {
  // 在根目录额外写一个 a.ts(fixture 已有 src/a.ts)
  await writeFile(path.join(workspaceRoot, 'a.ts'), 'export const rootA = 1;\n');

  // 等 watch 推送 / 自动出现根 a.ts
  await expect(explorerTreeItem(window, /^a\.ts$/)).toBeVisible({
    timeout: 10_000,
  });

  // 打开根 a.ts(此时 src 收起,treeitem a.ts 唯一)
  await explorerTreeItem(window, /^a\.ts$/).click();
  let titleSpan = window.locator('header').first().locator('span[title]');
  await expect(titleSpan).toHaveAttribute('title', path.join(workspaceRoot, 'a.ts'));

  // 展开 src — 现在 a.ts treeitem 出现两个
  await expandTreeItem(window, /^src$/);
  await expect(window.getByRole('treeitem', { name: /^a\.ts$/ })).toHaveCount(2, {
    timeout: 5_000,
  });

  // treeitem 自身带 title=绝对路径(FileRow):直接按 src/a.ts 的路径定位点开
  await window
    .locator(`[role=treeitem][title="${path.join(workspaceRoot, 'src', 'a.ts')}"]`)
    .click();

  // tooltip 此时应是 src/a.ts
  titleSpan = window.locator('header').first().locator('span[title]');
  await expect(titleSpan).toHaveAttribute('title', path.join(workspaceRoot, 'src/a.ts'), {
    timeout: 5_000,
  });

  // tablist 中应有 2 个 tab(都叫 a.ts)
  const tabs = window.getByRole('tablist', { name: EDITOR_TABS }).locator('[role=tab]');
  await expect(tabs).toHaveCount(2, { timeout: 5_000 });
  // 同名 tab 在文件名后显示最短区分父路径(VSCode 同款):根 a.ts 显示工作区目录名,src/a.ts 显示 src
  const desc = tabs.locator('[data-testid="tab-description"]');
  await expect(desc).toHaveText([path.basename(workspaceRoot), 'src']);
});
