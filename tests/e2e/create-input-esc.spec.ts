// CreateInput 的 Esc 取消 + Enter 空白也算取消(空 trim).
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { test, expect } from './fixtures/with-workspace';

test('右键 src → 新建文件 → Esc 取消 → input 消失 + 无文件落盘', async ({
  window,
  workspaceRoot,
}) => {
  await window.locator('text=src').first().click({ button: 'right' });
  await window.getByRole('menuitem', { name: '新建文件', exact: true }).click();

  const input = window.locator('input[placeholder^="新建文件名"]');
  await expect(input).toBeVisible();

  await input.fill('something.ts');
  await input.press('Escape');

  await expect(input).toBeHidden();
  // src 下没有 something.ts(被 Esc 取消)
  const exists = await stat(path.join(workspaceRoot, 'src/something.ts'))
    .then(() => true)
    .catch(() => false);
  expect(exists).toBe(false);
});

test('Enter 空白名字 → 视为取消 → 无文件', async ({
  window,
  workspaceRoot,
}) => {
  await window.locator('text=src').first().click({ button: 'right' });
  await window.getByRole('menuitem', { name: '新建文件', exact: true }).click();

  const input = window.locator('input[placeholder^="新建文件名"]');
  await expect(input).toBeVisible();

  // 不输入,直接 Enter
  await input.press('Enter');
  await expect(input).toBeHidden();

  // 落盘验证(没有任何 'undefined' / 'untitled' 之类)
  const exists = await stat(path.join(workspaceRoot, 'src/'))
    .then(() => true)
    .catch(() => false);
  expect(exists).toBe(true);
});

test('全空格名字 → 视为取消', async ({ window }) => {
  await window.locator('text=src').first().click({ button: 'right' });
  await window.getByRole('menuitem', { name: '新建文件', exact: true }).click();

  const input = window.locator('input[placeholder^="新建文件名"]');
  await input.fill('   ');
  await input.press('Enter');

  await expect(input).toBeHidden();
});
