// autoSave.delayMs input 显示 store 值 + 改后 store 同步.
import { test, expect } from './fixtures/electron-app';
import { SETTINGS_NAV, EDITOR_TAB } from './helpers/settings';
import { waitForTestHooks } from './helpers/app-ready';

test('编辑器 tab 的自动保存延迟输入框(autoSave.delayMs)显示 store 值(3000)+ 改后 store=4000', async ({
  window,
}) => {
  await waitForTestHooks(window);
  // dock 未就绪(DockShell onReady 前)时 openOrFocusPanel 按契约静默忽略;测试钩子可能更早可用。
  // 出现 dock 页签 = 布局已恢复(fromJSON / 默认布局);Splash 不在 = 就绪屏障已放行。
  await expect(window.getByRole('tab').first()).toBeVisible({ timeout: 10_000 });
  await expect(window.getByTestId('splash')).toHaveCount(0, { timeout: 10_000 });
  await window.evaluate(() => {
    globalThis.__continuoTest!.openOrFocusPanel('settings', 'settings', 'Settings');
  });

  // openOrFocusPanel 幂等打开(布局恢复前会排队到恢复后执行);Settings 内容是懒加载 chunk,
  // 不能立即用 count()===0 判断「没打开」再点齿轮 —— 那会把刚排队打开的 Settings toggle 关掉。
  const settingsNav = window.getByRole('navigation', { name: SETTINGS_NAV });
  await expect(settingsNav).toBeVisible({ timeout: 10_000 });
  const editorTab = settingsNav.getByRole('button', { name: EDITOR_TAB });
  await expect(editorTab).toBeVisible();
  await editorTab.dispatchEvent('click');
  await window.evaluate(() =>
    globalThis.__continuoTest!.setSettingValue('autoSave.delayMs', 3000),
  );

  // 按名称取自动保存延迟(autoSave.delayMs)的输入框(外观 / 缩进组另有字号、行高、制表符大小等数字项,不按位置数)
  const delayInput = window.getByRole('spinbutton', { name: /^(自动保存延迟|Auto-save delay|자동 저장 지연)$/ });
  // 3000 非默认值(默认 2000):输入框显示它证明确实读自 store
  await expect(delayInput).toHaveValue('3000');

  await delayInput.fill('4000');
  await expect(delayInput).toHaveValue('4000');

  const v = await window.evaluate(
    () =>
      globalThis.__continuoTest!.getSettingValue('autoSave.delayMs'),
  );
  expect(v).toBe(4000);
});
