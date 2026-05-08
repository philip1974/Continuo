// 未设过的 setting id → getSettingValue 返 undefined.
import { test, expect } from './fixtures/electron-app';

test('getSettingValue("xxx.never-set") === undefined', async ({ window }) => {
  await window.waitForFunction(
    () =>
      Boolean(
        (window as unknown as { __continuoTest?: unknown }).__continuoTest,
      ),
    { timeout: 5_000 },
  );

  const v = await window.evaluate(
    () =>
      (
        window as unknown as {
          __continuoTest: { getSettingValue: (id: string) => unknown };
        }
      ).__continuoTest.getSettingValue('xxx.never-set'),
  );
  expect(v).toBeUndefined();
});
