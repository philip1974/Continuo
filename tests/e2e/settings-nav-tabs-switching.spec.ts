// Settings 内多 nav tab 切换 → 内容区随之切换.
import { test, expect } from './fixtures/electron-app';

const SETTINGS = /^(设置|Settings|설정)$/;
const SETTINGS_NAV = /^(设置分类|Setting categories|설정 카테고리)$/;
const GENERAL = /^(通用|General|일반)$/;
const EDITOR = /^(编辑器|Editor|편집기)$/;
const TERMINAL = /^(终端|Terminal|터미널)$/;
const KEYBINDINGS = /^(快捷键|Keybindings|단축키)$/;
const PLUGINS = /^(插件|Plugins|플러그인)$/;
const THEME = /^(主题|Theme|테마)$/;
const FONT_SIZE = /^(字号|Font size|글꼴 크기)$/;
const CURSOR_STYLE = /^(光标样式|Cursor style|커서 스타일)$/;
const KEYBINDINGS_TOTAL =
  /(共\s*\d+\s*个有快捷键的命令|\d+\s*commands with hotkey|단축키가 있는 명령어\s*\d+개)/;
const REGISTERED_CONTRIBUTIONS =
  /^(已注册贡献点|Registered contribution points|등록된 기여 항목)$/;

test('依次切「通用 → 编辑器 → 资源管理器 → 终端 → 快捷键 → 插件」内容均渲染', async ({
  window,
}) => {
  await window.getByRole('button', { name: SETTINGS }).click();
  const nav = window.getByRole('navigation', { name: SETTINGS_NAV });
  await expect(nav).toBeVisible({ timeout: 10_000 });

  // 通用(默认 active 含主题 / 字号配置)
  await nav.getByRole('button', { name: GENERAL }).click();
  await expect(window.getByText(THEME)).toBeVisible();

  await nav.getByRole('button', { name: EDITOR }).click();
  await expect(window.getByText(FONT_SIZE).first()).toBeVisible();

  await nav.getByRole('button', { name: TERMINAL }).click();
  await expect(window.getByText(CURSOR_STYLE)).toBeVisible();

  await nav.getByRole('button', { name: KEYBINDINGS }).click();
  await expect(window.getByText(KEYBINDINGS_TOTAL)).toBeVisible();

  await nav.getByRole('button', { name: PLUGINS }).click();
  await expect(window.getByText(REGISTERED_CONTRIBUTIONS)).toBeVisible();
});
