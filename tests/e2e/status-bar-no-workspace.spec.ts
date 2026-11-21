// 无 workspace → StatusBar 左侧显示「无工作区」.
import { test, expect } from './fixtures/electron-app';
import { NO_WORKSPACE } from './helpers/status-bar';

test('无 workspace → footer 含「无工作区」', async ({ window }) => {
  const footer = window.locator('footer');
  await expect(footer).toContainText(NO_WORKSPACE);
  // 不显示 git 分支
  await expect(footer).not.toContainText('main');
});
