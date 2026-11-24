// 未设过的 setting id → getSettingValue 返 undefined.
import { test, expect } from './fixtures/electron-app';
import { waitForTestHooks } from './helpers/app-ready';

test('getSettingValue("xxx.never-set") === undefined', async ({ window }) => {
  await waitForTestHooks(window);

  const v = await window.evaluate(
    () =>
      globalThis.__continuoTest!.getSettingValue('xxx.never-set'),
  );
  expect(v).toBeUndefined();
});
