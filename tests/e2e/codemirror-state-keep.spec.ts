// 切 tab 再切回 → 编辑器状态保留(VSCode 同款):未保存内容来自 store;撤销历史与光标位置来自按 tab 保存的
// CodeMirror 视图状态(编辑器按 tab 卸载 / 重挂,见 src/__tests__/editor-view-state/)。
import { test, expect } from './fixtures/with-workspace';
import { EDITOR_TABS } from './helpers/editor';

const UNSAVED_CHANGES = /^(未保存的更改|Unsaved changes|저장되지 않은 변경 사항)$/;

test('编辑 a.ts → 切 b.ts → 切回 a.ts → content 保留(未保存),⌘Z 仍能撤销、接着输入落在原光标处', async ({
  window,
}) => {
  await window.locator('text=src').first().click();
  await window.locator('text=a.ts').first().click();
  const cm1 = window.locator('.cm-content');
  await expect(cm1).toBeVisible({ timeout: 10_000 });
  await cm1.click();
  await window.keyboard.press('ControlOrMeta+End');
  await window.keyboard.type('// edited');

  // dirty 圆点出现
  await expect(window.getByText(UNSAVED_CHANGES).first()).toBeVisible();

  // 切到 b.ts
  await window.locator('text=b.ts').first().click();
  await expect(window.locator('header').first()).toContainText('b.ts');

  // 切回 a.ts(鼠标点 tab:焦点随即进编辑器)
  const aTab = window
    .getByRole('tablist', { name: EDITOR_TABS })
    .getByRole('tab', { name: 'a.ts' });
  await aTab.click();

  // 内容来自 store → 含 'edited'
  const cm = window.locator('.cm-content');
  await expect(cm).toContainText('edited', { timeout: 5_000 });
  await expect(cm).toBeFocused();

  // 光标仍在上次输入的末尾:接着输入紧跟在 'edited' 后
  await window.keyboard.type('X');
  await expect(cm).toContainText('// editedX');

  // 撤销历史保留:⌘Z 撤掉 X,再撤掉 '// edited'(切走前的输入)
  await window.keyboard.press('ControlOrMeta+KeyZ');
  await expect(cm).not.toContainText('editedX');
  await window.keyboard.press('ControlOrMeta+KeyZ');
  await expect(cm).not.toContainText('edited', { timeout: 5_000 });
  await expect(window.getByText(UNSAVED_CHANGES)).toHaveCount(0);
});
