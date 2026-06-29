// 插件 tab:fresh state 下没有第三方插件 →「暂无第三方插件」.
// 内置 4 条 core 插件 + 已注册贡献点数字非零.
import { test, expect } from './fixtures/electron-app';
import { PLUGINS_TAB, openSettingsTab } from './helpers/settings';

const REGISTERED_CONTRIBUTIONS =
  /^(已注册贡献点|Registered contribution points|등록된 기여 항목)$/;
const PANEL_TYPES = /^(Panel 类型|Panel types|Panel 유형)$/;
const COMMANDS = /^(命令|Commands|명령)$/;
const NO_USER_PLUGINS =
  /^(暂无用户插件|No user plugins installed|설치된 사용자 플러그인이 없습니다)$/;
const INSTALL_FROM_GIT =
  /^(从 Git URL 安装|Install from Git URL|Git URL에서 설치)$/;

test('插件 tab → 「暂无第三方插件」 + 4 条内置 + 贡献点统计 > 0', async ({
  window,
}) => {
  await openSettingsTab(window, PLUGINS_TAB);

  // 已注册贡献点 section
  await expect(window.getByText(REGISTERED_CONTRIBUTIONS)).toBeVisible();
  await expect(window.getByText(PANEL_TYPES)).toBeVisible();
  await expect(window.getByText(COMMANDS)).toBeVisible();

  // 内置插件 4 条 core.*(用 code chip exact 匹配,避开贡献点 samples 行)
  await expect(window.getByText('core.editor', { exact: true })).toBeVisible();
  await expect(window.getByText('core.terminal', { exact: true })).toBeVisible();
  await expect(window.getByText('core.output', { exact: true })).toBeVisible();
  await expect(window.getByText('core.plugins', { exact: true })).toBeVisible();

  // 第三方区:fresh state → 暂无
  await expect(window.getByText(NO_USER_PLUGINS)).toBeVisible();

  // Git URL 安装段(从 PluginsTabContent)
  await expect(window.getByText(INSTALL_FROM_GIT).first()).toBeVisible();
});
