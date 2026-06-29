// 启动 → 打开 Settings → 切 5 个 tab → 关 → console 不应产 error 级日志.
// 已知误差:某些第三方包(dockview / xterm)startup 可能 warn,只 fail 'error' 级别.
import { test, expect } from './fixtures/electron-app';

const SETTINGS = /^(设置|Settings|설정)$/;
const SETTINGS_NAV = /^(设置分类|Setting categories|설정 카테고리)$/;
const CLOSE_SETTINGS = /^(关闭 Settings|Close Settings|Settings 닫기)$/;
const SETTING_TABS = [
  /^(通用|General|일반)$/,
  /^(编辑器|Editor|편집기)$/,
  /^(资源管理器|Explorer|탐색기)$/,
  /^(快捷键|Keybindings|단축키)$/,
  /^(插件|Plugins|플러그인)$/,
];

test('basic flow → 无 console.error', async ({ window }) => {
  const errors: string[] = [];
  window.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(msg.text());
  });
  window.on('pageerror', (err) => {
    errors.push(`pageerror: ${err.message}`);
  });

  // 等基础渲染完成
  await expect(window.locator('footer')).toBeVisible({ timeout: 5_000 });

  // 打开 Settings
  await window.getByRole('button', { name: SETTINGS }).click();
  const nav = window.getByRole('navigation', { name: SETTINGS_NAV });
  await expect(nav).toBeVisible({ timeout: 10_000 });

  // 走 5 个 tab
  for (const tabName of SETTING_TABS) {
    const btn = nav.getByRole('button', { name: tabName });
    if ((await btn.count()) > 0) await btn.dispatchEvent('click');
    await window.waitForTimeout(80);
  }

  // 关 Settings
  await window.getByRole('button', { name: CLOSE_SETTINGS }).click();
  await window.waitForTimeout(400);

  // 过滤已知噪音(若有):marketplace 离线 / autoSave 警告等
  const filtered = errors.filter(
    (e) =>
      !e.includes('Failed to load resource') &&
      !e.includes('marketplace') &&
      !e.includes('Marketplace') &&
      !e.includes('insertNodes') &&
      !e.includes('No active tab'),
  );

  if (filtered.length > 0) {
    console.warn('[console errors]', filtered);
  }
  expect(filtered).toEqual([]);
});
