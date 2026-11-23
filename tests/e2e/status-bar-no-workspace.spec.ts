// 无 workspace → StatusBar 左侧显示「无工作区」.
import { test, expect } from './fixtures/electron-app';
import { NO_WORKSPACE } from './helpers/status-bar';

test('无 workspace → footer 含「无工作区」', async ({ window }) => {
  const footer = window.locator('footer');
  await expect(footer).toContainText(NO_WORKSPACE);
  // 回归哨兵:StatusBar 本身没有 git 分支显示(若将来加入,不应在无 workspace 时出现)
  await expect(footer).not.toContainText('main');
});
