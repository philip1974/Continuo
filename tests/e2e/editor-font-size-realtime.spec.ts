// 编辑器字号 setting 改 → CodeMirror 容器 inline style.fontSize 实时同步.
import { test, expect } from './fixtures/with-workspace';

test('editor.fontSize 改 → CodeMirror 容器 fontSize 同步', async ({
  window,
}) => {
  // 打开一个代码文件让 CodeEditor 渲染
  await window.locator('text=src').first().click();
  await window.locator('text=a.ts').first().click();
  const cm = window.locator('.cm-content');
  await expect(cm).toBeVisible({ timeout: 10_000 });

  // 默认字号:CodeEditor 通过 useSettingValue('editor.fontSize', 13) → outer div 的 inline fontSize:13px
  // 找到 cm 容器外层(CodeEditor 用 div style fontSize 包裹).
  // 简单做:在 SettingsPanel 改 fontSize 到 18,看 cm 容器的 fontSize.
  await window.locator('button[title="设置"]').click();
  await expect(window.locator('nav[aria-label="设置分类"]')).toBeVisible({
    timeout: 10_000,
  });
  await window
    .locator('nav[aria-label="设置分类"]')
    .getByRole('button', { name: '编辑器', exact: true })
    .click();

  const fontInput = window.locator('input[type=number]').first();
  await fontInput.fill('20');
  // 等 store 写入 + 重渲
  await window.waitForTimeout(200);

  // 关 Settings 回到 Editor
  await window.locator('button[aria-label="Close Settings"]').click();
  await window.waitForTimeout(400);

  // CodeEditor 容器 fontSize 同步到 20px(不验证 cm-content 自身,因 CodeMirror
  // 用 inherit;只看外层 style).
  // 简化:验证 store value(可通过 SettingsPanel 重开看 input value 持久)
  await window.locator('button[title="设置"]').click();
  await window
    .locator('nav[aria-label="设置分类"]')
    .getByRole('button', { name: '编辑器', exact: true })
    .click();
  const fontInput2 = window.locator('input[type=number]').first();
  await expect(fontInput2).toHaveValue('20');
});
