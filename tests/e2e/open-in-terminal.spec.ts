// 右键文件夹 → 「在集成终端中打开」 → 创建新 terminal session + 自动打开 dock terminal panel.
// (cwd 设到所选目录由 create-user-terminal 单测覆盖;本用例只验证 panel 出现.)
import { test, expect } from './fixtures/with-workspace';
import { TERMINAL_INPUT } from './helpers/editor';
import { EXPLORER_OPEN_IN_TERMINAL } from './helpers/explorer';

test('右键 src → 在集成终端中打开 → Terminal panel 出现(终端输入框可见)', async ({
  window,
}) => {
  // 展开 src(单击文件夹会 expand;不影响后续右键)
  await window.locator('text=src').first().click();
  await window.locator('text=src').first().click({ button: 'right' });

  const item = window.getByRole('menuitem', {
    name: EXPLORER_OPEN_IN_TERMINAL,
  });
  await expect(item).toBeVisible({ timeout: 5_000 });
  await item.click();

  // dock 中出现 Terminal panel(终端输入框)
  await expect(
    window.getByRole('textbox', { name: TERMINAL_INPUT }),
  ).toBeVisible({ timeout: 15_000 });
});
