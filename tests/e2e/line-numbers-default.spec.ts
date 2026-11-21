// 默认 lineNumbers=true → .cm-editor 不含 cm-no-gutters,gutters 渲染.
import { test, expect } from './fixtures/with-workspace';

test('默认 → CM 不含 cm-no-gutters + .cm-gutters 元素存在', async ({
  window,
}) => {
  await window.locator('text=src').first().click();
  await window.locator('text=a.ts').first().click();
  const cm = window.locator('.cm-editor').first();
  await expect(cm).toBeVisible({ timeout: 10_000 });

  // class 不含 cm-no-gutters
  await expect(cm).not.toHaveClass(/cm-no-gutters/);

  // gutters 元素渲染(行号区)
  const gutters = window.locator('.cm-gutters').first();
  await expect(gutters).toBeVisible();
});
