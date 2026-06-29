// 切 tab 再切回 → editor.store 中 tab.content 保留(CodeMirror remount,但
// content 来自 store 已修改值).
import { test, expect } from './fixtures/with-workspace';

const UNSAVED_CHANGES = /^(未保存的更改|Unsaved changes|저장되지 않은 변경 사항)$/;

test('编辑 a.ts → 切 b.ts → 切回 a.ts → content 保留(未保存)', async ({
  window,
}) => {
  await window.locator('text=src').first().click();
  await window.locator('text=a.ts').first().click();
  const cm1 = window.locator('.cm-content');
  await expect(cm1).toBeVisible({ timeout: 10_000 });
  await cm1.click();
  await window.keyboard.type(' // edited');

  // dirty 圆点出现
  await expect(window.getByText(UNSAVED_CHANGES).first()).toBeVisible();

  // 切到 b.ts
  await window.locator('text=b.ts').first().click();
  await expect(window.locator('header').first()).toContainText('b.ts');

  // 切回 a.ts
  const aTab = window
    .locator('main [role=tablist]')
    .first()
    .locator('[role=tab]')
    .filter({ hasText: 'a.ts' });
  await aTab.click();

  // CodeMirror 重新渲染 a.ts content;由 store 提供 → 含 'edited'
  await expect(window.locator('.cm-content')).toContainText('edited', {
    timeout: 5_000,
  });
});
