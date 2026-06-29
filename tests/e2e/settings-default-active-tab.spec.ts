// 首次打开 Settings → 默认 active tab = 通用(priority=1).
import { test, expect } from './fixtures/electron-app';

const SETTINGS = /^(设置|Settings|설정)$/;
const SETTINGS_NAV = /^(设置分类|Setting categories|설정 카테고리)$/;
const GENERAL = /^(通用|General|일반)$/;
const THEME = /^(主题|Theme|테마)$/;

test('打开 Settings → 通用 button 高亮(border-accent)', async ({
  window,
}) => {
  await window.getByRole('button', { name: SETTINGS }).click();
  const nav = window.getByRole('navigation', { name: SETTINGS_NAV });
  await expect(nav).toBeVisible({ timeout: 10_000 });

  const generalBtn = nav.getByRole('button', { name: GENERAL });
  await expect(generalBtn).toHaveAttribute('class', /border-accent/);

  // 主区显主题 setting(general 类)
  await expect(window.getByText(THEME)).toBeVisible();
});
