// 改 a.ts(dirty)+ 改 b.ts(dirty)→ 各自 TabNavItem 都显 dirty dot.
import { test, expect } from './fixtures/with-workspace';
import { editorTabItem, openWorkspaceFile } from './helpers/editor';

test('a.ts dirty + b.ts dirty → 两个 tab 都显 dirty dot', async ({ window }) => {
  // 开 a.ts + 改
  await openWorkspaceFile(window, ['src', 'a.ts']);
  let cm = window.locator('.cm-content').first();
  await expect(cm).toBeVisible({ timeout: 10_000 });
  await cm.click();
  await window.keyboard.type(' // a-dirty');

  // 开 b.ts + 改
  await openWorkspaceFile(window, ['src', 'b.ts']);
  cm = window.locator('.cm-content').first();
  await expect(cm).toBeVisible();
  await cm.click();
  await window.keyboard.type(' // b-dirty');

  // 两个 tab 都 dirty
  const aItem = editorTabItem(window, 'a.ts');
  const bItem = editorTabItem(window, 'b.ts');

  await expect(aItem.locator('.wm-tab-nav-item__dirty-dot')).toHaveCount(1, {
    timeout: 5_000,
  });
  await expect(bItem.locator('.wm-tab-nav-item__dirty-dot')).toHaveCount(1);

  // 切回 a.ts → Cmd+S → 仅 a.ts 清 dirty
  await aItem.locator('button[role=tab]').click();
  cm = window.locator('.cm-content').first();
  await cm.press('ControlOrMeta+KeyS');

  await expect(aItem.locator('.wm-tab-nav-item__dirty-dot')).toHaveCount(0, {
    timeout: 5_000,
  });
  // b.ts 仍 dirty
  await expect(bItem.locator('.wm-tab-nav-item__dirty-dot')).toHaveCount(1);
});
