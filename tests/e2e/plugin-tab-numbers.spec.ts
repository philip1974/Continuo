// PluginsTabContent 的「已注册贡献点」行,数字与运行时 registry 一致.
import { test, expect } from './fixtures/electron-app';
import {
  PLUGINS_TAB,
  openSettingsTab,
  pluginContributionCount,
} from './helpers/settings';

const COMMAND_LABELS = ['命令', 'Commands', '명령'];

test('Plugin tab 显示的命令数 = testing hook commandCount()', async ({
  window,
}) => {
  await window.waitForFunction(
    () =>
      Boolean(
        (window as unknown as { __continuoTest?: unknown }).__continuoTest,
      ),
    { timeout: 5_000 },
  );

  const cmdCount = (await window.evaluate(() =>
    (
      window as unknown as {
        __continuoTest: { commandCount: () => number };
      }
    ).__continuoTest.commandCount(),
  )) as number;
  expect(cmdCount).toBeGreaterThanOrEqual(1);

  // 打开 Plugin tab
  await openSettingsTab(window, PLUGINS_TAB);

  // 「命令」行的 count cell(数字)= cmdCount
  // 「命令」label 文案 + 同行的 .tabular-nums.w-8 含 count
  // 简化:在 main 内查找含 "命令" 的 row 后取数字
  const uiCount = await pluginContributionCount(window, COMMAND_LABELS);

  expect(uiCount).toBe(cmdCount);
});
