// Settings panel 是 dockview panel,close × 关闭后回到默认 Editor 视图.
import { test, expect } from './fixtures/electron-app';

const SETTINGS = /^(设置|Settings|설정)$/;
const CLOSE_SETTINGS = /^(关闭 Settings|Close Settings|Settings 닫기)$/;
const SETTINGS_NAV = /^(设置分类|Setting categories|설정 카테고리)$/;
const NO_FILE_OPEN = /^(未打开文件|No file open|열린 파일 없음)$/;

test('打开 Settings → 关闭 → 回到 Editor', async ({ window }) => {
  await window.getByRole('button', { name: SETTINGS }).click();
  await expect(
    window.getByRole('navigation', { name: SETTINGS_NAV }),
  ).toBeVisible({
    timeout: 10_000,
  });

  // SharedTab close × button: aria-label="Close ${title}",Settings panel 标题 'Settings'
  const closeBtn = window.getByRole('button', { name: CLOSE_SETTINGS });
  await expect(closeBtn).toBeVisible();
  await closeBtn.click();

  // 等动画完成
  await window.waitForTimeout(400);

  // Settings nav 消失
  await expect(
    window.getByRole('navigation', { name: SETTINGS_NAV }),
  ).toBeHidden();

  // Editor panel 仍在(默认 layout 含 Editor)
  // 验证 Editor 区显示 EditorWelcome(无打开 tab 时)
  await expect(window.getByText(NO_FILE_OPEN).first()).toBeVisible();
});

test('Settings 已开 → 再点齿轮 → focus 现有 panel(不重复创建)', async ({
  window,
}) => {
  await window.getByRole('button', { name: SETTINGS }).click();
  await expect(
    window.getByRole('navigation', { name: SETTINGS_NAV }),
  ).toBeVisible({
    timeout: 10_000,
  });

  // 再点齿轮 → openOrFocusPanel 路径,setActive 现有 panel(不创建第二个)
  await window.getByRole('button', { name: SETTINGS }).click();

  // 仍只有 1 个 Settings nav
  await expect(
    window.getByRole('navigation', { name: SETTINGS_NAV }),
  ).toHaveCount(1);
});
