// explorer.showHiddenFiles=false(默认)→ .hidden 不显;切 true → .hidden 出现.
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { test, expect } from './fixtures/with-workspace';
import { explorerTreeItem } from './helpers/explorer';

test('默认隐藏 .hidden → 切 setting=true → tree 显', async ({
  window,
  workspaceRoot,
}) => {
  // 写一个 dot 文件 + 一个普通文件作对照:普通文件出现 = 树已渲染且 watch 已推送这批变更
  await writeFile(path.join(workspaceRoot, '.hidden'), 'secret');
  await writeFile(path.join(workspaceRoot, 'marker.txt'), 'marker');
  await expect(explorerTreeItem(window, /^marker\.txt$/)).toBeVisible({ timeout: 10_000 });

  // 默认 showHiddenFiles=false → .hidden 不显
  await expect(
    window.locator('[role=treeitem]').filter({ hasText: /^\.hidden$/ }),
  ).toHaveCount(0);

  // 切 true
  await window.waitForFunction(
    () =>
      Boolean(
        (window as unknown as { __continuoTest?: unknown }).__continuoTest,
      ),
    { timeout: 5_000 },
  );
  await window.evaluate(() => {
    const t = (
      window as unknown as {
        __continuoTest: {
          setSettingValue: (id: string, v: boolean) => void;
        };
      }
    ).__continuoTest;
    t.setSettingValue('explorer.showHiddenFiles', true);
  });

  // .hidden 应出现
  await expect(
    window.locator('[role=treeitem]').filter({ hasText: /^\.hidden$/ }),
  ).toBeVisible({ timeout: 5_000 });
});
