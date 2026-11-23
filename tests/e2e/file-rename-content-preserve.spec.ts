// 改名为唯一新名 → 改名落盘、内容不变;改名到同目录已存在的文件 → 失败,两个文件都不变.
//
// 注:Continuo fs.rename 会先 lstat 目标,已存在即抛 FS_EEXIST(不覆盖).
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { test, expect } from './fixtures/with-workspace';
import { EXPLORER_RENAME } from './helpers/explorer';

test('a.ts 改名为唯一新名 → 文件改名 + 内容不变', async ({
  window,
  workspaceRoot,
}) => {
  const before = await readFile(path.join(workspaceRoot, 'src/a.ts'), 'utf8');

  await window.locator('text=src').first().click();
  await window
    .locator('[role=treeitem]')
    .filter({ hasText: 'a.ts' })
    .first()
    .click({ button: 'right' });
  await window.getByRole('menuitem', { name: EXPLORER_RENAME }).click();

  const input = window.locator('input:focus');
  await input.press('ControlOrMeta+KeyA');
  await input.fill('a-renamed.ts');
  await input.press('Enter');

  await expect(async () => {
    const after = await readFile(
      path.join(workspaceRoot, 'src/a-renamed.ts'),
      'utf8',
    );
    expect(after).toBe(before);
  }).toPass({ timeout: 5_000 });
});

test('a.ts 改名为已存在的 b.ts → 失败,a.ts / b.ts 内容都不变', async ({
  window,
  workspaceRoot,
}) => {
  const aPath = path.join(workspaceRoot, 'src/a.ts');
  const bPath = path.join(workspaceRoot, 'src/b.ts');
  const aBefore = await readFile(aPath, 'utf8');
  const bBefore = await readFile(bPath, 'utf8');

  await window.locator('text=src').first().click();
  await window
    .locator('[role=treeitem]')
    .filter({ hasText: /^a\.ts$/ })
    .first()
    .click({ button: 'right' });
  await window.getByRole('menuitem', { name: EXPLORER_RENAME }).click();

  const input = window.locator('input:focus');
  await expect(input).toHaveValue('a.ts', { timeout: 5_000 });
  await input.press('ControlOrMeta+KeyA');
  await input.fill('b.ts');
  await input.press('Enter');

  // 等改名请求结算后复核磁盘:两个文件都在、内容都不变,没有被覆盖
  await window.waitForTimeout(800);
  expect((await readdir(path.join(workspaceRoot, 'src'))).sort()).toEqual(['a.ts', 'b.ts']);
  expect(await readFile(aPath, 'utf8')).toBe(aBefore);
  expect(await readFile(bPath, 'utf8')).toBe(bBefore);
});
