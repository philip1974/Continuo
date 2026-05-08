// .md 默认 autoSave 开,但 Cmd+S 仍触发显式保存(useEditorFile 路径).
// 用 autoSave.delayMs=10000 让 autoSave 不会先触发,确保 Cmd+S 起的作用.
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { test, expect } from './fixtures/with-workspace';

test('README.md autoSave delay=10s + 输入 + Cmd+S → 立即写盘', async ({
  window,
  workspaceRoot,
}) => {
  // 拉长 autoSave delay 让 autoSave 不抢
  await window.waitForFunction(
    () =>
      Boolean(
        (window as unknown as { __continuoTest?: unknown }).__continuoTest,
      ),
    { timeout: 5_000 },
  );
  await window.evaluate(() => {
    const t = (
      window as unknown as {
        __continuoTest: {
          setSettingValue: (id: string, v: number) => void;
        };
      }
    ).__continuoTest;
    t.setSettingValue('autoSave.delayMs', 10000);
  });

  await window.locator('text=README.md').first().click();
  await expect(window.locator('header').first()).toContainText('README.md', {
    timeout: 10_000,
  });

  // 切到 Source mode 让 CodeMirror 接收输入(milkdown 输入相对慢且 fragile)
  await window
    .locator('main')
    .locator('button')
    .filter({ hasText: /^Source$/ })
    .first()
    .click();

  const cm = window.locator('.cm-content');
  await expect(cm).toBeVisible({ timeout: 10_000 });
  await cm.click();
  await cm.press('ControlOrMeta+End');
  await window.keyboard.type(' // explicit-save');

  // Cmd+S 显式保存(早于 autoSave 10s)
  await cm.press('ControlOrMeta+KeyS');

  await expect(async () => {
    const content = await readFile(
      path.join(workspaceRoot, 'README.md'),
      'utf8',
    );
    expect(content).toContain('explicit-save');
  }).toPass({ timeout: 3_000 });
});
