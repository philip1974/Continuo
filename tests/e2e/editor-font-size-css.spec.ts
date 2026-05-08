// editor.fontSize 改 → CodeEditor 容器 div style.fontSize 同步.
import { test, expect } from './fixtures/with-workspace';

test('setting fontSize=20 → CodeEditor 容器 fontSize=20px', async ({
  window,
}) => {
  await window.locator('text=src').first().click();
  await window.locator('text=a.ts').first().click();
  const cm = window.locator('.cm-editor').first();
  await expect(cm).toBeVisible({ timeout: 10_000 });

  // 默认 13px:CodeEditor 外层 div(.cm-editor 的父)style.fontSize
  const containerSelector = '.cm-editor';
  const beforeFontSize = await window.evaluate((sel) => {
    const cm = document.querySelector(sel);
    if (!cm || !cm.parentElement) return null;
    return cm.parentElement.style.fontSize;
  }, containerSelector);
  expect(beforeFontSize).toBe('13px');

  // 改 setting → 20
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
        __continuoTest: {
          setSettingValue: (id: string, v: number) => void;
        };
      }
    ).__continuoTest;
    t.setSettingValue('editor.fontSize', 20);
  });

  await expect(async () => {
    const after = await window.evaluate((sel) => {
      const cm = document.querySelector(sel);
      if (!cm || !cm.parentElement) return null;
      return cm.parentElement.style.fontSize;
    }, containerSelector);
    expect(after).toBe('20px');
  }).toPass({ timeout: 5_000 });
});
