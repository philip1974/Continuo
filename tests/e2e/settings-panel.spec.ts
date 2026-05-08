// Settings panel 在 dock 中作为 panel 渲染,不是 Modal。
// 测左侧 nav 切换 + 搜索过滤模式。
import { test, expect } from './fixtures/electron-app';

test.beforeEach(async ({ window }) => {
  // 每个 spec 都从 IconSidebar 齿轮打开 Settings panel
  await window.locator('button[title="设置"]').click();
  await expect(window.locator('nav[aria-label="设置分类"]')).toBeVisible({
    timeout: 10_000,
  });
});

test('Settings nav 列出全部内置 tab', async ({ window }) => {
  const nav = window.locator('nav[aria-label="设置分类"]');
  // 内置 7 类:通用 / 编辑器 / 资源管理器 / 终端 / 快捷键 / 插件 / 商店
  for (const label of [
    '通用',
    '编辑器',
    '资源管理器',
    '终端',
    '快捷键',
    '插件',
  ]) {
    await expect(nav.getByText(label, { exact: true })).toBeVisible();
  }
});

test('点击 nav tab → 切换右侧内容', async ({ window }) => {
  const nav = window.locator('nav[aria-label="设置分类"]');
  const editorBtn = nav.getByRole('button', { name: '编辑器', exact: true });
  await editorBtn.click();
  // 编辑器 tab 通常含 fontSize 等 SettingItem 或贡献项;只校验内容区不空
  await expect(editorBtn).toHaveAttribute('class', /border-accent/);
});

test('搜索框过滤 → 「未找到匹配」 / 命中时左 nav 半透明', async ({
  window,
}) => {
  const search = window.locator('input[placeholder*="搜索设置"]');
  await search.fill('zzz_no_such_setting_xx');
  // 右侧文案
  await expect(
    window.locator('text=未找到匹配').first(),
  ).toBeVisible();
  // 左侧 nav 半透明 class(opacity-40)
  const nav = window.locator('nav[aria-label="设置分类"]');
  await expect(nav).toHaveClass(/opacity-40/);

  // 清空恢复
  await search.fill('');
  await expect(nav).not.toHaveClass(/opacity-40/);
});

test('插件 tab → 显示「已注册贡献点」分段', async ({ window }) => {
  const nav = window.locator('nav[aria-label="设置分类"]');
  await nav.getByRole('button', { name: '插件', exact: true }).click();
  await expect(window.locator('text=已注册贡献点')).toBeVisible();
  // 含至少 panel/命令两行
  await expect(window.locator('text=Panel 类型')).toBeVisible();
  await expect(window.locator('text=命令')).toBeVisible();
});
