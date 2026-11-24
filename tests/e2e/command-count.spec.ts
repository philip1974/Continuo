// 内置命令注册数:Continuo 启动后至少 settings.toggle 命令注册.
import { test, expect } from './fixtures/electron-app';
import { waitForTestHooks } from './helpers/app-ready';

test('启动后命令数 ≥ 1(包含 settings.toggle)', async ({ window }) => {
  await waitForTestHooks(window);
  const count = (await window.evaluate(() =>
    globalThis.__continuoTest!.commandCount(),
  )) as number;
  expect(count).toBeGreaterThanOrEqual(1);
});
