// Settings 内多 nav tab 切换 → 内容区随之切换.
import { test, expect } from './fixtures/electron-app';
import { KEYBINDINGS_TAB, MARKETPLACE_TAB, PLUGINS_TAB, SETTINGS, SETTINGS_NAV } from './helpers/settings';

const GENERAL = /^(通用|General|일반)$/;
const EDITOR = /^(编辑器|Editor|편집기)$/;
const TERMINAL = /^(终端|Terminal|터미널)$/;
const KEYBINDINGS = /^(快捷键|Keybindings|단축키)$/;
const PLUGINS = /^(插件|Plugins|플러그인)$/;
const THEME = /^(主题|Theme|테마)$/;
const FONT_SIZE = /^(字号|Font size|글꼴 크기)$/;
const CURSOR_STYLE = /^(光标样式|Cursor style|커서 스타일)$/;
const KEYBINDINGS_TOTAL =
  /(共\s*\d+\s*个命令[,，]\d+\s*个已绑定|\d+\s*commands, \d+ bound|명령어\s*\d+개, \d+개 바인딩됨)/;
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

// 首次点开「插件市场 / 插件 / 快捷键」:此前这三个页签内容 chunk 不随设置外壳预取,内容区约 310ms 全空白
//(React.lazy 首次渲染必挂起、揭示被节流),第二次才即时。现在随外壳预取 → 首次点开下一帧即有内容、高亮同步。
test('首次点开插件市场 / 插件 / 快捷键页签:下一帧即有内容,左侧高亮同步', async ({ window }) => {
  await window.getByRole('button', { name: SETTINGS }).click();
  const nav = window.getByRole('navigation', { name: SETTINGS_NAV });
  await expect(nav).toBeVisible({ timeout: 10_000 });
  await expect(window.getByText(THEME)).toBeVisible();
  for (const name of [MARKETPLACE_TAB, PLUGINS_TAB, KEYBINDINGS_TAB]) {
    const btn = nav.getByRole('button', { name });
    await expect(btn).toBeVisible();
    const handle = await btn.elementHandle();
    const r = await window.evaluate(async (el) => {
      const b = el as HTMLButtonElement;
      const content = b.closest('nav')!.nextElementSibling as HTMLElement;
      b.click();
      // 两帧:提交 + 布局。挂起时内容区为空(fallback=null)。
      await new Promise((res) => requestAnimationFrame(() => requestAnimationFrame(res)));
      // innerText:挂起时 React 把旧页签内容留在 DOM 里 display:none,textContent 仍有字。
      return { current: b.getAttribute('aria-current'), text: content.innerText.trim().length };
    }, handle);
    expect(r.current).toBe('page');
    expect(r.text).toBeGreaterThan(0);
  }
});
