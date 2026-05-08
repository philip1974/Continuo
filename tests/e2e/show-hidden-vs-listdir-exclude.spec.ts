// showHiddenFiles=true → .env 显;node_modules 仍不显(listDir 内部 exclude).
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { test, expect } from './fixtures/with-workspace';

test('切 showHiddenFiles=true → .env 显;node_modules 仍不显', async ({
  window,
  workspaceRoot,
}) => {
  await writeFile(path.join(workspaceRoot, '.env'), 'SECRET=x');
  await mkdir(path.join(workspaceRoot, 'node_modules'), { recursive: true });

  // 等 watch 推
  await window.waitForTimeout(500);

  // 默认 false → .env 不显
  await expect(
    window.locator('[role=treeitem]').filter({ hasText: /^\.env$/ }),
  ).toHaveCount(0);

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
        __continuoTest: { setSettingValue: (id: string, v: boolean) => void };
      }
    ).__continuoTest;
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
