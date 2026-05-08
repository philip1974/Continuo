// 关闭 Explorer sidebar 后,IconSidebar 其它按钮仍可用(齿轮 / Account chip).
import { test, expect } from './fixtures/electron-app';

test('sidebar 关闭后,设置齿轮仍能打开 SettingsPanel', async ({ window }) => {
  // 关 sidebar
  await window.locator('button[title="隐藏 Explorer"]').click();
  await expect(window.locator('main aside')).toHaveCount(1, {
    timeout: 5_000,
  });

  // IconSidebar 仍存在(.w-12 aside),Settings 齿轮仍可点
  await window.locator('button[title="设置"]').click();
  await expect(window.locator('nav[aria-label="设置分类"]')).toBeVisible({
    timeout: 10_000,
  });
});

test('sidebar 关闭后,AccountChip 仍可点击不抛', async ({ window }) => {
  await window.locator('button[title="隐藏 Explorer"]').click();
  await expect(window.locator('main aside')).toHaveCount(1, {
    timeout: 5_000,
  });

  const chip = window.locator(
    'button[aria-label="账户:Continuo Dev,PRO Plan"]',
  );
  await expect(chip).toBeVisible();
  await chip.click(); // 占位 noop;只验证不崩
  await expect(chip).toBeVisible();
});
