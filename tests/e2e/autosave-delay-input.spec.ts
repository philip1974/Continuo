// autoSave.delayMs input 显示 store 值 + 改后 store 同步.
import { test, expect } from './fixtures/electron-app';

const SETTINGS = /^(设置|Settings|설정)$/;
const SETTINGS_NAV = /^(设置分类|Setting categories|설정 카테고리)$/;
const EDITOR_TAB = /^(编辑器|Editor|편집기)$/;

test('编辑器 tab 第二 number input = 2000 + 改后 store=4000', async ({
  window,
}) => {
  await window.waitForFunction(
    () =>
      Boolean(
        (window as unknown as { __continuoTest?: unknown }).__continuoTest,
      ),
    { timeout: 5_000 },
  );
  await window.evaluate(() => {
    (
      window as unknown as {
        __continuoTest: {
          openOrFocusPanel: (
            id: string,
            component: string,
            title: string,
          ) => void;
        };
      }
    ).__continuoTest.openOrFocusPanel('settings', 'settings', 'Settings');
  });

  const settingsNav = window.getByRole('navigation', { name: SETTINGS_NAV });
  if ((await settingsNav.count()) === 0) {
    await window.getByRole('button', { name: SETTINGS }).click();
  }
  await expect(settingsNav).toBeVisible({ timeout: 10_000 });
  const editorTab = settingsNav.getByRole('button', { name: EDITOR_TAB });
  await expect(editorTab).toBeVisible();
  await editorTab.dispatchEvent('click');
  await window.evaluate(() =>
    (
      window as unknown as {
        __continuoTest: {
          setSettingValue: (id: string, value: number) => void;
        };
      }
    ).__continuoTest.setSettingValue('autoSave.delayMs', 2000),
  );

  // 第一个 input(fontSize)+ 第二个(autoSave.delayMs)
  const inputs = window.locator('input[type=number]');
  await expect(inputs.nth(1)).toHaveValue('2000');

  await inputs.nth(1).fill('4000');
  await expect(inputs.nth(1)).toHaveValue('4000');

  const v = await window.evaluate(
    () =>
      (
        window as unknown as {
          __continuoTest: { getSettingValue: (id: string) => unknown };
        }
      ).__continuoTest.getSettingValue('autoSave.delayMs'),
  );
  expect(v).toBe(4000);
});
