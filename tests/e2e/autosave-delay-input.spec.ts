// autoSave.delayMs input 显示 store 值 + 改后 store 同步.
import { test, expect } from './fixtures/electron-app';
import { SETTINGS_NAV, EDITOR_TAB } from './helpers/settings';

test('编辑器 tab 第二 number input 显示 store 值(3000)+ 改后 store=4000', async ({
  window,
}) => {
  await window.waitForFunction(
    () =>
      Boolean(
        (window as unknown as { __continuoTest?: unknown }).__continuoTest,
      ),
    { timeout: 5_000 },
  );
  // dock 未就绪(DockShell onReady 前)时 openOrFocusPanel 按契约静默忽略;测试钩子可能更早可用。
  // 出现 dock 页签 = 布局已恢复(fromJSON / 默认布局);Splash 不在 = 就绪屏障已放行。
  await expect(window.getByRole('tab').first()).toBeVisible({ timeout: 10_000 });
  await expect(window.getByTestId('splash')).toHaveCount(0, { timeout: 10_000 });
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

  // openOrFocusPanel 幂等打开(布局恢复前会排队到恢复后执行);Settings 内容是懒加载 chunk,
  // 不能立即用 count()===0 判断「没打开」再点齿轮 —— 那会把刚排队打开的 Settings toggle 关掉。
  const settingsNav = window.getByRole('navigation', { name: SETTINGS_NAV });
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
    ).__continuoTest.setSettingValue('autoSave.delayMs', 3000),
  );

  // 第一个 input(fontSize)+ 第二个(autoSave.delayMs)
  const inputs = window.locator('input[type=number]');
  // 3000 非默认值(默认 2000):输入框显示它证明确实读自 store
  await expect(inputs.nth(1)).toHaveValue('3000');

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
