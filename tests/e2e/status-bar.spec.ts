// 状态栏:无 workspace 时占位 + MCP 复制按钮.
import { test, expect } from './fixtures/electron-app';

test('「复制 MCP 配置」按钮存在 + 点击不抛', async ({ window }) => {
  const status = window.locator('footer');
  const btn = status.getByRole('button', { name: '复制 MCP 配置' });
  await expect(btn).toBeVisible();
  // 点击后会触发 IPC 调用 + 文案 1.5s 内变(setTimeout 调度难确定性断言);
  // 这里只验证不抛 + 1.5s 后文案回归默认.
  await btn.click();
  await expect(btn).toHaveText('复制 MCP 配置', { timeout: 5_000 });
});

test('agent terminal 计数 = 0 → 按钮不渲染', async ({ window }) => {
  const status = window.locator('footer');
  // 「N agent」按钮只在 sessions 中 originHint='agent' > 0 时显示
  await expect(status).not.toContainText(/\d+\s*agent/);
});
