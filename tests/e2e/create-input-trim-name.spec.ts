// CreateInput 输 '  hello.ts  ' → 创建为 hello.ts(submit 前 trim).
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { test, expect } from './fixtures/with-workspace';

test('右键 src → 新建文件 → 输 «  hello.ts  » → 创建 hello.ts', async ({
  window,
  workspaceRoot,
}) => {
  await window.locator('text=src').first().click();
  await window.locator('text=src').first().click({ button: 'right' });
  await window.getByRole('menuitem', { name: '新建文件', exact: true }).click();

  const input = window.locator('input[placeholder^="新建文件名"]');
  await expect(input).toBeVisible();
  await input.fill('  hello.ts  ');
  await input.press('Enter');

  await expect(async () => {
    await stat(path.join(workspaceRoot, 'src/hello.ts'));
  }).toPass({ timeout: 5_000 });
  // 不应有空格 padded 文件
  const padded = await stat(path.join(workspaceRoot, 'src/  hello.ts  '))
    .then(() => true)
    .catch(() => false);
  expect(padded).toBe(false);
});
