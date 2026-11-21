// reset 一个 override → localStorage values 中 key 删除.
import { test, expect } from './fixtures/electron-app';
import {
  clickFirstVisibleResetDefault,
  EDITOR_TAB,
  SETTINGS,
  SETTINGS_NAV,
} from './helpers/settings';

test('改 fontSize=20 → reset → values 不含 editor.fontSize', async ({
  window,
}) => {
  await window.getByRole('button', { name: SETTINGS }).click();
  await window
    .getByRole('navigation', { name: SETTINGS_NAV })
    .getByRole('button', { name: EDITOR_TAB })
    .click();

  const fontInput = window.locator('input[type=number]').first();
  await fontInput.fill('20');
  await window.waitForTimeout(200);

  let stored = await window.evaluate(() =>
    localStorage.getItem('continuo.settings.values'),
  );
  expect(stored).toContain('"editor.fontSize":20');

  // reset
  await clickFirstVisibleResetDefault(window);
  await window.waitForTimeout(200);

  stored = await window.evaluate(() =>
    localStorage.getItem('continuo.settings.values'),
  );
  // editor.fontSize key 删除
  expect(stored ?? '').not.toContain('"editor.fontSize"');
});
