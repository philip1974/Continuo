// Plugins tab 「命令」 计数随动态 register 同步 +1.
import { test, expect } from './fixtures/electron-app';
import {
  PLUGINS_TAB,
  openSettingsTab,
  pluginContributionCount,
} from './helpers/settings';

const COMMAND_LABELS = ['命令', 'Commands', '명령'];
const REGISTERED_CONTRIBUTIONS =
  /^(已注册贡献点|Registered contribution points|등록된 기여 항목)$/;

test('register 命令 → 插件 tab 命令计数 +1', async ({ window }) => {
  await window.waitForFunction(
    () =>
      Boolean(
        (window as unknown as { __continuoTest?: unknown }).__continuoTest,
      ),
    { timeout: 5_000 },
  );

  // 打开 Settings → 插件 tab
  await openSettingsTab(window, PLUGINS_TAB);

  // 等贡献点 section
  await expect(window.getByText(REGISTERED_CONTRIBUTIONS)).toBeVisible({
    timeout: 10_000,
  });

  // 取「命令」行计数
  const before = await pluginContributionCount(window, COMMAND_LABELS);
  expect(before).toBeGreaterThan(0);

  // register 4 个新命令
  await window.evaluate(() => {
    const t = (
      window as unknown as {
        __continuoTest: {
          registerCommand: (id: string, title: string) => () => void;
        };
      }
    ).__continuoTest;
    t.registerCommand('e2e.pl1', 'PL1');
    t.registerCommand('e2e.pl2', 'PL2');
    t.registerCommand('e2e.pl3', 'PL3');
    t.registerCommand('e2e.pl4', 'PL4');
  });

  // 计数 +4
  await expect(async () => {
    const after = await pluginContributionCount(window, COMMAND_LABELS);
    expect(after).toBe(before + 4);
  }).toPass({ timeout: 5_000 });
});
