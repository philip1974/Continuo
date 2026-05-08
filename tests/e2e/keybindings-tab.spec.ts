// 快捷键 Settings tab:列表 + 编辑 modal.
import { test, expect } from './fixtures/electron-app';

test('快捷键 tab 列出有 hotkey 的命令 + 计数', async ({ window }) => {
  await window.locator('button[title="设置"]').click();
  await expect(window.locator('nav[aria-label="设置分类"]')).toBeVisible({
    timeout: 10_000,
  });
  await window
    .locator('nav[aria-label="设置分类"]')
    .getByRole('button', { name: '快捷键', exact: true })
    .click();

  // 「共 N 个有快捷键的命令」
  await expect(window.locator('text=/共\\s*\\d+\\s*个有快捷键的命令/')).toBeVisible(
    { timeout: 10_000 },
  );

  // 至少有一个命令行(li)
  await expect(window.locator('main li').first()).toBeVisible();
});

test('每条命令行有「编辑快捷键」按钮 + 「恢复默认」占位', async ({
  window,
}) => {
  await window.locator('button[title="设置"]').click();
  await window
    .locator('nav[aria-label="设置分类"]')
    .getByRole('button', { name: '快捷键', exact: true })
    .click();
  // 等列表渲染
  await expect(window.locator('main li').first()).toBeVisible({
    timeout: 10_000,
  });

  // 至少有一个 编辑快捷键 按钮
  const editBtns = window.locator('button[aria-label="编辑快捷键"]');
  expect(await editBtns.count()).toBeGreaterThan(0);
  // 也至少有一个 恢复默认 按钮(invisible 但 DOM 存在)
  const resetBtns = window.locator('button[aria-label="恢复默认"]');
  expect(await resetBtns.count()).toBeGreaterThan(0);
});

test('搜索过滤命令(只显匹配项)', async ({ window }) => {
  await window.locator('button[title="设置"]').click();
  await window
    .locator('nav[aria-label="设置分类"]')
    .getByRole('button', { name: '快捷键', exact: true })
    .click();
  await expect(window.locator('main li').first()).toBeVisible({
    timeout: 10_000,
  });

  const initial = await window.locator('main li').count();

  const search = window.locator('input[placeholder*="搜索命令名"]');
  await search.fill('zzz_no_match_xx');
  await expect(window.locator('text=无匹配命令')).toBeVisible();

  await search.fill('');
  await expect(window.locator('main li')).toHaveCount(initial);
});
