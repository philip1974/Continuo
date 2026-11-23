import {
  AUTO_SAVE_MARKDOWN,
  CLOSE_SETTINGS,
  EDITOR_TAB,
  SETTINGS,
  SETTINGS_NAV,
} from './helpers/settings';
// Markdown 自动保存设置的默认值在设置面板可见(autoSave.markdown.enabled=true、autoSave.delayMs=2000)。
// 真实的「修改 → 防抖后写盘」见 markdown-auto-save-real.spec.ts。

import { test, expect } from './fixtures/with-workspace';

test('打开 .md → 设置面板显示自动保存默认值(开启、2000ms)', async ({
  window,
}) => {
  // 直接打开 README.md
  await window.locator('text=README.md').first().click();
  await expect(window.locator('header').first()).toContainText('README.md', {
    timeout: 10_000,
  });

  // milkdown 编辑器渲染需要时间,等元素出现
  await window.waitForTimeout(500);


  // 验证自动保存 setting 默认 true:打开 settings 看 toggle.
  await window.getByRole('button', { name: SETTINGS }).click();
  await window
    .getByRole('navigation', { name: SETTINGS_NAV })
    .getByRole('button', { name: EDITOR_TAB })
    .click();

  await expect(
    window.locator('main').getByText(AUTO_SAVE_MARKDOWN),
  ).toBeVisible();

  // 自动保存 toggle = on(boolean default=true).
  // 「编辑器」tab 内 button[role=switch] 顺序:lineNumbers(外观) → autoSave.markdown.enabled(自动保存).
  // 断言第二个 toggle(autoSave.markdown.enabled,priority 排序后在 lineNumbers 之后)为 true.
  const toggles = window.locator('main button[role=switch]');
  expect(await toggles.count()).toBeGreaterThanOrEqual(2);
  // autoSave.markdown.enabled 是第二个(priority 排序后)
  await expect(toggles.nth(1)).toHaveAttribute('aria-checked', 'true');

  // 也验证 autoSave.delayMs number input 默认 2000
  // 数 input 中至少有一个值是 2000(autoSave.delayMs);
  // editor.fontSize 是另一个 number,默认 13(可能在 fontSize 行)
  const numberInputs = window.locator('main input[type=number]');
  const values = await numberInputs.evaluateAll((els) =>
    (els as HTMLInputElement[]).map((el) => el.value),
  );
  expect(values).toContain('2000');

  await window.getByRole('button', { name: CLOSE_SETTINGS }).click();
});
