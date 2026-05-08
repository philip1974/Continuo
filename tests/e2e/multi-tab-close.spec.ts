// 多 tab 时点 tab close × → 该 tab 移除;关到 1 tab 退回紧凑模式.
import { test, expect } from './fixtures/with-workspace';

test('开 2 tab → 关其中一个 → 回紧凑模式(无 tablist)', async ({
  window,
}) => {
  // 开 README.md
  await window.locator('text=README.md').first().click();
  await expect(window.locator('header').first()).toContainText('README.md', {
    timeout: 10_000,
  });

  // 展开 src + 开 a.ts → 进 TabNav 模式
  await window.locator('text=src').first().click();
  await window.locator('text=a.ts').first().click();
  await expect(
    window.locator('main [role=tablist]').first(),
  ).toBeVisible({ timeout: 10_000 });

  // TabNavItem close button aria-label='Close ${title}',title 是完整 filePath.
  // 用 *= 模糊匹配 README.md.
  const closeReadme = window.locator(
    'button[aria-label*="Close"][aria-label*="README.md"]',
  );
  await expect(closeReadme).toBeVisible();
  await closeReadme.click();

  // tablist 消失(只剩 1 tab → 紧凑模式)
  await expect(window.locator('main [role=tablist]')).toHaveCount(0, {
    timeout: 5_000,
  });
  // header 显示剩下的 a.ts
  await expect(window.locator('header').first()).toContainText('a.ts');
});

test('紧凑模式右侧 close × → 回 EditorWelcome', async ({ window }) => {
  await window.locator('text=README.md').first().click();
  await expect(window.locator('header').first()).toContainText('README.md', {
    timeout: 10_000,
  });

  // EditorHeader 紧凑模式的关闭按钮 aria-label='关闭文件'
  await window.locator('button[aria-label=关闭文件]').click();

  // EditorWelcome 出现
  await expect(window.getByText('未打开文件').first()).toBeVisible({
    timeout: 5_000,
  });
});
