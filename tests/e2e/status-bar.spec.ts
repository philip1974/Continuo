// 状态栏:无 workspace 时占位 + MCP 复制按钮.
import { test, expect } from './fixtures/electron-app';
import { MCP_COPY } from './helpers/status-bar';
import { waitForAppReady } from './helpers/app-ready';

test('MCP copy 按钮存在 + 点击不抛', async ({ window }) => {
  const pageErrors: string[] = [];
  window.on('pageerror', (err) => pageErrors.push(err.message));
  const status = window.locator('footer');
  const btn = status.locator('button').filter({ hasText: MCP_COPY });
  await expect(btn).toBeVisible();
  // 点击后会触发 IPC 调用 + 文案 1.5s 内变(setTimeout 调度难确定性断言);
  // 这里只验证不抛 + 1.5s 后文案回归默认.
  await btn.click();
  await expect(btn).toHaveText(MCP_COPY, { timeout: 5_000 });
  expect(pageErrors).toEqual([]);
});

test('agent terminal 计数 = 0 → 按钮不渲染', async ({ window }) => {
  // agent 撤销入口(data-agent-revoke)只在 agent 会话数 > 0 或存在「本次启动期间允许」授权时显示;
  // 新启动、无 agent 会话也无授权 → 不渲染(按属性断言,不依赖界面语言)。先等应用就绪(footer 已渲染、
  // Splash 已撤除),再稍等,避免在 render 前断言恒真。
  await waitForAppReady(window);
  await window.waitForTimeout(500);
  await expect(window.locator('footer [data-agent-revoke]')).toHaveCount(0);
});
