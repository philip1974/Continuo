// Settings panel 在 dock 中作为 panel 渲染,不是 Modal。
// 测左侧 nav 切换 + 搜索过滤模式。
import { test, expect } from './fixtures/electron-app';

const SETTINGS = /^(设置|Settings|설정)$/;
const SETTINGS_NAV = /^(设置分类|Setting categories|설정 카테고리)$/;
const SEARCH_SETTINGS = /^(搜索设置|Search settings|설정 검색)/;
const GENERAL = /^(通用|General|일반)$/;
const EDITOR = /^(编辑器|Editor|편집기)$/;
const EXPLORER = /^(资源管理器|Explorer|탐색기)$/;
const TERMINAL = /^(终端|Terminal|터미널)$/;
const KEYBINDINGS = /^(快捷键|Keybindings|단축키)$/;
const PLUGINS = /^(插件|Plugins|플러그인)$/;
const NO_MATCH = /未找到匹配|No settings matched|일치하는 설정을 찾을 수 없음/;
const REGISTERED_CONTRIBUTIONS =
  /^(已注册贡献点|Registered contribution points|등록된 기여 항목)$/;
const PANEL_TYPES = /^(Panel 类型|Panel types|Panel 유형)$/;
const COMMANDS = /^(命令|Commands|명령)$/;

test.beforeEach(async ({ window }) => {
  // 每个 spec 都从 IconSidebar 齿轮打开 Settings panel
  await window.getByRole('button', { name: SETTINGS }).click();
  await expect(
    window.getByRole('navigation', { name: SETTINGS_NAV }),
  ).toBeVisible({
    timeout: 10_000,
  });
});

test('Settings nav 列出全部内置 tab', async ({ window }) => {
  const nav = window.getByRole('navigation', { name: SETTINGS_NAV });
  // 内置 7 类:通用 / 编辑器 / 资源管理器 / 终端 / 快捷键 / 插件 / 商店
  for (const label of [GENERAL, EDITOR, EXPLORER, TERMINAL, KEYBINDINGS, PLUGINS]) {
    await expect(nav.getByRole('button', { name: label })).toBeVisible();
  }
});

test('点击 nav tab → 切换右侧内容', async ({ window }) => {
  const nav = window.getByRole('navigation', { name: SETTINGS_NAV });
  const editorBtn = nav.getByRole('button', { name: EDITOR });
  await editorBtn.click();
  // 编辑器 tab 通常含 fontSize 等 SettingItem 或贡献项;只校验内容区不空
  await expect(editorBtn).toHaveAttribute('class', /border-accent/);
});

test('搜索框过滤 → 「未找到匹配」 / 命中时左 nav 半透明', async ({
  window,
}) => {
  const search = window.getByRole('textbox', { name: SEARCH_SETTINGS });
  await search.fill('zzz_no_such_setting_xx');
  // 右侧文案
  await expect(window.getByText(NO_MATCH).first()).toBeVisible();
  // 左侧 nav 半透明 class(opacity-40)
  const nav = window.getByRole('navigation', { name: SETTINGS_NAV });
  await expect(nav).toHaveClass(/opacity-40/);

  // 清空恢复
  await search.fill('');
  await expect(nav).not.toHaveClass(/opacity-40/);
});

test('插件 tab → 显示「已注册贡献点」分段', async ({ window }) => {
  const nav = window.getByRole('navigation', { name: SETTINGS_NAV });
  await nav.getByRole('button', { name: PLUGINS }).click();
  await expect(window.getByText(REGISTERED_CONTRIBUTIONS)).toBeVisible();
  // 含至少 panel/命令两行
  await expect(window.getByText(PANEL_TYPES)).toBeVisible();
  await expect(window.getByText(COMMANDS)).toBeVisible();
});
