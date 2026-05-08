// Settings panel 是 dockview panel,close × 关闭后回到默认 Editor 视图.
import { test, expect } from './fixtures/electron-app';

test('打开 Settings → 关闭 → 回到 Editor', async ({ window }) => {
  await window.locator('button[title="设置"]').click();
  await expect(window.locator('nav[aria-label="设置分类"]')).toBeVisible({
    timeout: 10_000,
  });

  // SharedTab close × button: aria-label="Close ${title}",Settings panel 标题 'Settings'
  const closeBtn = window.locator('button[aria-label="Close Settings"]');
  await expect(closeBtn).toBeVisible();
  await closeBtn.click();

  // 等动画完成
  await window.waitForTimeout(400);

  // Settings nav 消失
  await expect(window.locator('nav[aria-label="设置分类"]')).toBeHidden();

  // Editor panel 仍在(默认 layout 含 Editor)
  // 验证 Editor 区显示 EditorWelcome(无打开 tab 时)
  await expect(window.getByText('未打开文件').first()).toBeVisible();
});

test('Settings 已开 → 再点齿轮 → focus 现有 panel(不重复创建)', async ({
  window,
}) => {
  await window.locator('button[title="设置"]').click();
  await expect(window.locator('nav[aria-label="设置分类"]')).toBeVisible({
    timeout: 10_000,
  });

  // 再点齿轮 → openOrFocusPanel 路径,setActive 现有 panel(不创建第二个)
  await window.locator('button[title="设置"]').click();

  // 仍只有 1 个 Settings nav
  await expect(window.locator('nav[aria-label="设置分类"]')).toHaveCount(1);
});
