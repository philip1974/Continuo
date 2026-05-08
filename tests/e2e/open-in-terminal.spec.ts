// 右键文件夹 → 「在集成终端中打开」 → 创建新 terminal session(cwd 设到该目录)
// + 自动打开 dock terminal panel.
import { test, expect } from './fixtures/with-workspace';

test('右键 src → 在集成终端中打开 → TerminalTabs 出现 + 「+」按钮可用', async ({
  window,
}) => {
  // 展开 src(单击文件夹会 expand;不影响后续右键)
  await window.locator('text=src').first().click();
  await window.locator('text=src').first().click({ button: 'right' });

  const item = window.getByRole('menuitem', {
    name: /在集成终端中打开/,
  });
  await expect(item).toBeVisible({ timeout: 5_000 });
  await item.click();

  // dock 中出现 Terminal panel(TerminalTabs 内的 + 按钮)
  await expect(
    window.locator('button[aria-label="新建终端"]'),
  ).toBeVisible({ timeout: 15_000 });
});
