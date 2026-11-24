// 多选 + 移到废纸篓:批量删除多个文件.
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { test, expect } from './fixtures/with-workspace';
import { EXPLORER_TRASH, confirmExplorerTrash } from './helpers/explorer';

test('Cmd-click 多选 a.ts + b.ts → 移到废纸篓 → 都消失', async ({
  window,
  workspaceRoot,
}) => {
  // 定位树行(role=treeitem),不用 text=:单击 a.ts 后编辑器标题栏也含「a.ts」,⌘ 单击 b.ts 只改选中不打开,
  // 标题栏保持 a.ts,`text=a.ts` 的首个匹配会落到标题栏上。
  const tree = window.getByRole('tree');
  await tree.getByRole('treeitem', { name: 'src' }).click();
  await tree.getByRole('treeitem', { name: 'a.ts' }).click();
  await tree.getByRole('treeitem', { name: 'b.ts' }).click({ modifiers: ['ControlOrMeta'] });

  // 右键 a.ts(在选中集合内)
  await tree.getByRole('treeitem', { name: 'a.ts' }).click({
    button: 'right',
    modifiers: ['ControlOrMeta'],
  });
  await window.getByRole('menuitem', { name: EXPLORER_TRASH }).click();
  await confirmExplorerTrash(window);

  // 两个文件都消失
  await expect(async () => {
    const aExists = await stat(path.join(workspaceRoot, 'src/a.ts'))
      .then(() => true)
      .catch(() => false);
    const bExists = await stat(path.join(workspaceRoot, 'src/b.ts'))
      .then(() => true)
      .catch(() => false);
    expect(aExists).toBe(false);
    expect(bExists).toBe(false);
  }).toPass({ timeout: 5_000 });
});
