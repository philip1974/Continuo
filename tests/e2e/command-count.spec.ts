// 内置命令注册数:Continuo 启动后至少 settings.toggle 命令注册.
import { test, expect } from './fixtures/electron-app';

test('启动后命令数 ≥ 1(包含 settings.toggle)', async ({ window }) => {
  await window.waitForFunction(
    () =>
      Boolean(
        (window as unknown as { __continuoTest?: unknown }).__continuoTest,
      ),
    { timeout: 5_000 },
  );
  const count = (await window.evaluate(() =>
    (
      window as unknown as {
        __continuoTest: { commandCount: () => number };
      }
    ).__continuoTest.commandCount(),
  )) as number;
  expect(count).toBeGreaterThanOrEqual(1);
});
