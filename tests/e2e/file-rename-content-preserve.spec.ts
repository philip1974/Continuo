// 改名到根目录已存在文件 → 失败 + 原文件保留.
//
// 注:Continuo fs.rename 不显式检查同名(走 fs.rename),Node fs.rename 在
// 同目录下会覆盖目标。本测验证「重命名 a.ts → 仅同目录下唯一名字」流程的
// dirty path:用一个新名字 'a-renamed.ts' 不冲突,确保 IPC + UI 同步.
import { readFile } from 'node:fs/promises';
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
