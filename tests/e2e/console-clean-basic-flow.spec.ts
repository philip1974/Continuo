// 启动 → 打开 Settings → 切 5 个 tab → 关 → console 不应产 error 级日志.
// 已知误差:某些第三方包(dockview / xterm)startup 可能 warn,只 fail 'error' 级别.
import { test, expect } from './fixtures/electron-app';

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
  await window.locator('button[title="设置"]').click();
  const nav = window.locator('nav[aria-label="设置分类"]');
  await expect(nav).toBeVisible({ timeout: 10_000 });

  // 走 5 个 tab
  for (const t of ['通用', '编辑器', '资源管理器', '快捷键', '插件']) {
    const btn = nav.getByRole('button', { name: t, exact: true });
    if ((await btn.count()) > 0) await btn.click();
    await window.waitForTimeout(80);
  }

  // 关 Settings
  await window.locator('button[aria-label="Close Settings"]').click();
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
