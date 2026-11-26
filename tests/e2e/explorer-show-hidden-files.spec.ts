// explorer.showHiddenFiles=true(默认,VSCode 同款)→ .hidden 显、.git 不显(固定排除集);切 false → .hidden 消失.
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { test, expect } from './fixtures/with-workspace';
import { explorerTreeItem } from './helpers/explorer';
import { waitForTestHooks } from './helpers/app-ready';

test('默认显示 .hidden、不显示 .git → 切 setting=false → .hidden 消失', async ({
  window,
  workspaceRoot,
}) => {
  // 写一个 dot 文件 + 一个普通文件作对照:普通文件出现 = 树已渲染且 watch 已推送这批变更
  await writeFile(path.join(workspaceRoot, '.hidden'), 'secret');
  await mkdir(path.join(workspaceRoot, '.git'), { recursive: true });
  await writeFile(path.join(workspaceRoot, 'marker.txt'), 'marker');
  await expect(explorerTreeItem(window, /^marker\.txt$/)).toBeVisible({ timeout: 10_000 });

  // 默认 showHiddenFiles=true → .hidden 显;.git 属固定排除集,不显
  await expect(
    window.locator('[role=treeitem]').filter({ hasText: /^\.hidden$/ }),
  ).toBeVisible({ timeout: 5_000 });
  await expect(window.locator('[role=treeitem]').filter({ hasText: /^\.git$/ })).toHaveCount(0);

  // 切 false
  await waitForTestHooks(window);
  await window.evaluate(() => {
    const t = globalThis.__continuoTest!;
    t.setSettingValue('explorer.showHiddenFiles', false);
  });

  // .hidden 消失
  await expect(
    window.locator('[role=treeitem]').filter({ hasText: /^\.hidden$/ }),
  ).toHaveCount(0, { timeout: 5_000 });
});
