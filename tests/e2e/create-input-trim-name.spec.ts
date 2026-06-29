// CreateInput 输 '  hello.ts  ' → 创建为 hello.ts(submit 前 trim).
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { test, expect } from './fixtures/with-workspace';

const NEW_FILE = /^(新建文件|New file|새 파일)$/;
const NEW_FILE_NAME = /^(新建文件名…|New file name…|새 파일 이름…)$/;

test('右键 src → 新建文件 → 输 «  hello.ts  » → 创建 hello.ts', async ({
  window,
  workspaceRoot,
}) => {
  await window.locator('text=src').first().click();
  await window.locator('text=src').first().click({ button: 'right' });
  await window.getByRole('menuitem', { name: NEW_FILE }).click();

  const input = window.getByRole('textbox', { name: NEW_FILE_NAME });
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
