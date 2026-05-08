// 代码文件 .ts:Cmd+S 显式保存 → 磁盘内容更新.
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { test, expect } from './fixtures/with-workspace';

test('a.ts 修改 + Cmd+S → 磁盘 diff 出现新内容', async ({
  window,
  workspaceRoot,
}) => {
  await window.locator('text=src').first().click();
  await window.locator('text=a.ts').first().click();
  const cm = window.locator('.cm-content');
  await expect(cm).toBeVisible({ timeout: 10_000 });
  await cm.click();
  await window.keyboard.type(' // saved');

  await cm.press('ControlOrMeta+KeyS');

  await expect(async () => {
    const onDisk = await readFile(
      path.join(workspaceRoot, 'src/a.ts'),
      'utf8',
    );
    expect(onDisk).toContain('saved');
  }).toPass({ timeout: 5_000 });
});
