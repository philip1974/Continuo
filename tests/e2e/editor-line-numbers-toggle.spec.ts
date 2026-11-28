// editor.lineNumbers setting 切 false → CM .cm-editor 加 .cm-no-gutters.
import { test, expect } from './fixtures/with-workspace';
import { waitForTestHooks } from './helpers/app-ready';

test('打开 a.ts → setting 改 lineNumbers=false → CM 加 cm-no-gutters', async ({
  window,
}) => {
  await window.locator('text=src').first().click();
  await window.locator('text=a.ts').first().click();
  const cm = window.locator('.cm-editor').first();
  await expect(cm).toBeVisible({ timeout: 10_000 });

  // 默认 lineNumbers=true → 不应有 cm-no-gutters
  await expect(cm).not.toHaveClass(/cm-no-gutters/);

  // 用 testing hook 改 setting
  await waitForTestHooks(window);
  await window.evaluate(() => {
    const t = globalThis.__continuoTest!;
    t.setSettingValue('editor.lineNumbers', false);
  });

  // CM 类 应同步加 cm-no-gutters
  await expect(cm).toHaveClass(/cm-no-gutters/, { timeout: 3_000 });
});

// 回归:关闭行号后再打开的文件,点进编辑器(获得焦点 → CodeMirror 重写 .cm-editor 的 class)行号不能又出现;
// 折叠 gutter 照常显示(VSCode lineNumbers: off 只去掉行号)。BDD: src/__tests__/51-debug-breakpoint-ui/
test('lineNumbers=false 后打开文件并点进编辑器 → 行号仍隐藏,折叠 gutter 显示', async ({ window }) => {
  await waitForTestHooks(window);
  await window.evaluate(() => globalThis.__continuoTest!.setSettingValue('editor.lineNumbers', false));
  await window.locator('text=src').first().click();
  await window.locator('text=b.ts').first().click();
  const cm = window.locator('.cm-editor').first();
  await expect(cm).toBeVisible({ timeout: 10_000 });
  await cm.locator('.cm-content').click();
  await expect(cm).toHaveClass(/cm-focused/);
  await expect(cm).toHaveClass(/cm-no-gutters/);
  await expect(cm.locator('.cm-lineNumbers')).toBeHidden();
  await expect(cm.locator('.cm-foldGutter')).toBeVisible();
});
