import { CLOSE_SETTINGS, EDITOR_TAB, SETTINGS, SETTINGS_NAV } from './helpers/settings';
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
  // 简单做:在 SettingsPanel 改 fontSize 到 20,看 cm 容器的 fontSize.
  await window.getByRole('button', { name: SETTINGS }).click();
  await expect(window.getByRole('navigation', { name: SETTINGS_NAV })).toBeVisible({
    timeout: 10_000,
  });
  await window
    .getByRole('navigation', { name: SETTINGS_NAV })
    .getByRole('button', { name: EDITOR_TAB })
    .click();

  const fontInput = window.locator('input[type=number]').first();
  await fontInput.fill('20');
  // 等 store 写入 + 重渲
  await window.waitForTimeout(200);

  // 关 Settings 回到 Editor
  await window.getByRole('button', { name: CLOSE_SETTINGS }).click();
  await window.waitForTimeout(400);

  // 经设置面板 UI 改值(区别于 editor-font-size-css 走 testing hook):CodeEditor 容器(.cm-editor 的父)
  // inline style.fontSize 同步到 20px
  await expect
    .poll(() =>
      window.evaluate(() => {
        const cmEl = document.querySelector('.cm-editor');
        return cmEl?.parentElement?.style.fontSize ?? null;
      }),
    )
    .toBe('20px');
});
