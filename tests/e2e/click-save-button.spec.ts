// 编辑后触发保存命令 → 文件落盘 + dirty 清.
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { test, expect } from './fixtures/with-workspace';

const UNSAVED_CHANGES =
  '[aria-label="未保存的更改"], [aria-label="Unsaved changes"], [aria-label="저장되지 않은 변경 사항"]';

test('a.ts 修改 → 保存命令 → 磁盘更新 + dirty 消失', async ({
  window,
  workspaceRoot,
}) => {
  await window.locator('text=src').first().click();
  await window.locator('text=a.ts').first().click();
  const cm = window.locator('.cm-content');
  await expect(cm).toBeVisible({ timeout: 10_000 });
  await cm.click();
  await window.keyboard.type(' // click-save');

  const dirtyIndicators = window.locator(UNSAVED_CHANGES);
  await expect(dirtyIndicators.first()).toBeVisible();

  await cm.press('ControlOrMeta+KeyS');

  // 等磁盘 + dirty 清
  await expect(dirtyIndicators).toHaveCount(0, { timeout: 5_000 });
  await expect(async () => {
    const content = await readFile(
      path.join(workspaceRoot, 'src/a.ts'),
      'utf8',
    );
    expect(content).toContain('click-save');
  }).toPass({ timeout: 5_000 });
});
