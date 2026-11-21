// setValue 任意 id → localStorage 写入(不阻 UI).
import { test, expect } from './fixtures/electron-app';

test('setSettingValue("xxx.unknown", 42) → localStorage 仍记', async ({
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
    const t = (
      window as unknown as {
        __continuoTest: {
          setSettingValue: (id: string, v: number) => void;
        };
      }
    ).__continuoTest;
    t.setSettingValue('xxx.unknown', 42);
  });

  await window.waitForTimeout(200);
  const stored = await window.evaluate(() =>
    localStorage.getItem('continuo.settings.values'),
  );
  expect(stored).toContain('"xxx.unknown":42');
});
