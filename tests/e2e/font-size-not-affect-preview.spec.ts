// editor.fontSize 改 → Markdown Preview mode 不渲染 CodeMirror,fontSize 不影响 Milkdown.
import { test, expect } from './fixtures/with-workspace';

test('Preview mode 改 fontSize → main 内 CodeMirror 不存在', async ({
  window,
}) => {
  await window.locator('text=README.md').first().click();
  // 切 Preview
  await window
    .locator('main')
    .locator('button')
    .filter({ hasText: /^Preview$/ })
    .first()
    .click();

  // CodeMirror 在 main 内不存在
  await expect(window.locator('main .cm-content')).toHaveCount(0, {
    timeout: 5_000,
  });

  // 改 fontSize 不抛
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
        __continuoTest: { setSettingValue: (id: string, v: number) => void };
      }
    ).__continuoTest;
    t.setSettingValue('editor.fontSize', 22);
  });

  // Preview 仍渲(h1 文本)
  await expect(
    window.locator('main h1', { hasText: 'Test Workspace' }),
  ).toBeVisible({ timeout: 5_000 });
});
