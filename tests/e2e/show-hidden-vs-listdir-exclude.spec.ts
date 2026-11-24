// showHiddenFiles=true → .env 显;node_modules 仍不显(listDir 内部 exclude).
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { test, expect } from './fixtures/with-workspace';
import { explorerTreeItem } from './helpers/explorer';
import { waitForTestHooks } from './helpers/app-ready';

test('切 showHiddenFiles=true → .env 显;node_modules 仍不显', async ({
  window,
  workspaceRoot,
}) => {
  await writeFile(path.join(workspaceRoot, '.env'), 'SECRET=x');
  await mkdir(path.join(workspaceRoot, 'node_modules'), { recursive: true });
  // 普通文件作对照:出现 = 树已渲染且 watch 已推送这批变更
  await writeFile(path.join(workspaceRoot, 'marker.txt'), 'marker');
  await expect(explorerTreeItem(window, /^marker\.txt$/)).toBeVisible({ timeout: 10_000 });

  // 默认 false → .env 不显
  await expect(
    window.locator('[role=treeitem]').filter({ hasText: /^\.env$/ }),
  ).toHaveCount(0);

  await waitForTestHooks(window);
  await window.evaluate(() => {
    const t = globalThis.__continuoTest!;
    t.setSettingValue('explorer.showHiddenFiles', true);
  });

  // .env 出现
  await expect(
    window.locator('[role=treeitem]').filter({ hasText: /^\.env$/ }),
  ).toBeVisible({ timeout: 5_000 });

  // node_modules 仍不显(listDir 默认 exclude)
  await expect(
    window.locator('[role=treeitem]').filter({ hasText: /^node_modules$/ }),
  ).toHaveCount(0);
});
