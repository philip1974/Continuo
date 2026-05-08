// 同名文件 root/a.ts + src/a.ts → 两个独立 tab(以 filePath 区分,而非 basename).
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { test, expect } from './fixtures/with-workspace';

test('root/a.ts + src/a.ts 都打开 → 两个 tab 独立', async ({
  window,
  workspaceRoot,
}) => {
  // 在根目录额外写一个 a.ts(fixture 已有 src/a.ts)
  await writeFile(
    path.join(workspaceRoot, 'a.ts'),
    'export const rootA = 1;\n',
  );

  // 等 watch 推送 / 自动出现根 a.ts
  await expect(window.locator('text=a.ts').first()).toBeVisible({
    timeout: 10_000,
  });

  // 打开根 a.ts(此时 src 收起,treeitem a.ts 唯一)
  await window.locator('[role=treeitem]').filter({ hasText: /^a\.ts$/ }).first().click();
  let titleSpan = window.locator('header').first().locator('span[title]');
  await expect(titleSpan).toHaveAttribute(
    'title',
    path.join(workspaceRoot, 'a.ts'),
  );

  // 展开 src — 现在 a.ts treeitem 出现两个
  await window.locator('text=src').first().click();
  await expect(
    window.locator('[role=treeitem]').filter({ hasText: /^a\.ts$/ }),
  ).toHaveCount(2, { timeout: 5_000 });

  // 找路径指向 src/a.ts 的那个 treeitem 点开 — 通过 ID 属性 / 或最后一个
  // (DOM 顺序看渲染:src 被渲染在 root/a.ts 之前还是后,不假设;直接 evaluate
  // 找 data-id / aria-label / title 含 'src/a.ts')
  const srcAItem = window
    .locator('[role=treeitem]')
    .filter({ hasText: /^a\.ts$/ })
    .filter({ has: window.locator(`[title*="${path.join(workspaceRoot, 'src/a.ts')}"]`) });
  if ((await srcAItem.count()) > 0) {
    await srcAItem.first().click();
  } else {
    // fallback:点击两个 nth 中标题不是已打开的那个
    const items = window
      .locator('[role=treeitem]')
      .filter({ hasText: /^a\.ts$/ });
    const i0 = items.nth(0);
    const i1 = items.nth(1);
    await i0.click();
    const t = await titleSpan.getAttribute('title');
    if (t === path.join(workspaceRoot, 'a.ts')) {
      await i1.click();
    }
  }

  // tooltip 此时应是 src/a.ts
  titleSpan = window.locator('header').first().locator('span[title]');
  await expect(titleSpan).toHaveAttribute(
    'title',
    path.join(workspaceRoot, 'src/a.ts'),
    { timeout: 5_000 },
  );

  // tablist 中应有 2 个 tab(都叫 a.ts)
  const tabs = window
    .locator('main [role=tablist]')
    .first()
    .locator('[role=tab]');
  await expect(tabs).toHaveCount(2, { timeout: 5_000 });
});
