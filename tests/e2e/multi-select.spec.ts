// 多选 + 批量复制路径:Cmd-click 多个文件 → 右键「复制路径」→ \n 拼接.
import path from 'node:path';
import { test, expect } from './fixtures/with-workspace';

test('Cmd-click 多选 a.ts + b.ts → 复制路径 → 剪贴板含 \\n 拼接', async ({
  window,
  electronApp,
  workspaceRoot,
}) => {
  // 展开 src
  await window.locator('text=src').first().click();

  // 单击 a.ts(选中)
  await window.locator('text=a.ts').first().click();
  // Cmd-click b.ts(添加到选中集合)— headless-tree selection feature
  await window
    .locator('text=b.ts')
    .first()
    .click({ modifiers: ['ControlOrMeta'] });

  // 右键 a.ts → 「复制路径」(deleteTargets() 应包含两个 path)
  await window.locator('text=a.ts').first().click({
    button: 'right',
    modifiers: ['ControlOrMeta'],
  });
  const copyItem = window.getByRole('menuitem', { name: /^复制路径/ });
  await expect(copyItem).toBeVisible({ timeout: 5_000 });
  await copyItem.click();

  const clip = await electronApp.evaluate(({ clipboard }) =>
    clipboard.readText(),
  );

  // 期望 \n 拼接两条绝对路径(顺序不强求)
  const lines = clip.split('\n');
  expect(lines.length).toBe(2);
  const expectedA = path.join(workspaceRoot, 'src/a.ts');
  const expectedB = path.join(workspaceRoot, 'src/b.ts');
  expect(lines).toContain(expectedA);
  expect(lines).toContain(expectedB);
});
