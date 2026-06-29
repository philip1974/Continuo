// 多选 + 批量复制路径:Cmd-click 多个文件 → 右键「复制路径」→ \n 拼接.
import path from 'node:path';
import { test, expect } from './fixtures/with-workspace';
import { EXPLORER_COPY_PATH, expandTreeItem, explorerTreeItem } from './helpers/explorer';

test('Cmd-click 多选 a.ts + b.ts → 复制路径 → 剪贴板含 \\n 拼接', async ({
  window,
  electronApp,
  workspaceRoot,
}) => {
  // 展开 src
  await expandTreeItem(window, /^src$/);

  // 单击 a.ts(选中)
  const aRow = explorerTreeItem(window, /^a\.ts$/);
  const bRow = explorerTreeItem(window, /^b\.ts$/);
  await aRow.click();
  // Cmd-click b.ts(添加到选中集合)— headless-tree selection feature
  await bRow.click({ modifiers: ['ControlOrMeta'] });

  // 右键 a.ts → 「复制路径」(deleteTargets() 应包含两个 path)
  await aRow.click({
    button: 'right',
    modifiers: ['ControlOrMeta'],
  });
  const copyItem = window.getByRole('menuitem', { name: EXPLORER_COPY_PATH });
  await expect(copyItem).toBeVisible({ timeout: 5_000 });
  await copyItem.click();

  // 期望 \n 拼接两条绝对路径(顺序不强求)
  const expectedA = path.join(workspaceRoot, 'src/a.ts');
  const expectedB = path.join(workspaceRoot, 'src/b.ts');
  await expect
    .poll(
      async () => {
        const clip = await electronApp.evaluate(({ clipboard }) => clipboard.readText());
        return clip.split('\n').sort();
      },
      { timeout: 5_000 },
    )
    .toEqual([expectedA, expectedB].sort());
});
