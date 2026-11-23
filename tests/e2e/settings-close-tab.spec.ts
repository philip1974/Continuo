// Settings panel 是 dockview panel,close × 关闭后回到默认 Editor 视图.
import { test, expect } from './fixtures/electron-app';
import { openOutputPanel } from './helpers/output';

const SETTINGS = /^(设置|Settings|설정)$/;
const CLOSE_SETTINGS = /^(关闭 (Settings|设置)|Close Settings|(Settings|설정) 닫기)$/;
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

// 齿轮走 toggleSettingsPanel:Settings 存在但非激活 → 激活现有 panel(不创建第二个);存在且激活 → 关闭。
test('Settings 被 Output 盖住(非激活)→ 再点齿轮 → 激活现有 panel(不重复创建)', async ({
  window,
}) => {
  await window.getByRole('button', { name: SETTINGS }).click();
  const nav = window.getByRole('navigation', { name: SETTINGS_NAV });
  await expect(nav).toBeVisible({ timeout: 10_000 });

  // 打开 Output 成为激活 panel,Settings 退为非激活(内容隐藏)
  await openOutputPanel(window);
  await expect(nav).toBeHidden();

  // 再点齿轮 → 激活现有 Settings
  await window.getByRole('button', { name: SETTINGS }).click();
  // 等过 panel 关闭动画时长(220ms):若误走关闭 / 新建路径,此时已可观察
  await window.waitForTimeout(500);
  await expect(nav).toBeVisible();
  await expect(nav).toHaveCount(1);
  await expect(window.getByRole('button', { name: CLOSE_SETTINGS })).toHaveCount(1);
});

test('Settings 已激活 → 再点齿轮 → 关闭', async ({ window }) => {
  await window.getByRole('button', { name: SETTINGS }).click();
  const nav = window.getByRole('navigation', { name: SETTINGS_NAV });
  await expect(nav).toBeVisible({ timeout: 10_000 });

  await window.getByRole('button', { name: SETTINGS }).click();
  // wrapPanelClose 延后约 220ms 移除
  await expect(nav).toBeHidden({ timeout: 2_000 });
  await expect(window.getByRole('button', { name: CLOSE_SETTINGS })).toHaveCount(0);
});
