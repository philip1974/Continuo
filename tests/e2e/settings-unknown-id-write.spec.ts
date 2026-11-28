// setValue 任意 id → 主进程设置文件写入(不阻 UI).
import { test, expect } from './fixtures/electron-app';
import { readUserSettingsFile } from './helpers/user-settings-file';
import { waitForTestHooks } from './helpers/app-ready';

test('setSettingValue("xxx.unknown", 42) → user-settings.json 仍记', async ({
  window,
  userDataDir,
}) => {
  await waitForTestHooks(window);

  await window.evaluate(() => {
    const t = globalThis.__continuoTest!;
    t.setSettingValue('xxx.unknown', 42);
  });

  await expect.poll(() => readUserSettingsFile(userDataDir)?.['xxx.unknown']).toBe(42);
});
