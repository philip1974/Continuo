// 状态栏:无 workspace 时占位 + MCP 复制按钮.
import { test, expect } from './fixtures/electron-app';
import { MCP_COPY, MCP_COPY_FEEDBACK } from './helpers/status-bar';
import { waitForAppReady } from './helpers/app-ready';

test('MCP copy 按钮存在 + 点击不抛', async ({ window }) => {
  const pageErrors: string[] = [];
  window.on('pageerror', (err) => pageErrors.push(err.message));
  const status = window.locator('footer');
  const btn = status.locator('button').filter({ hasText: MCP_COPY });
  await expect(btn).toBeVisible();
  // 点击后先经 IPC(handleCopyMcpConfig)再切到反馈文案(已复制 / 复制失败 / MCP 不可用之一),约 1.5s 后回到默认。
  // 先等反馈文案出现(证明点击处理已完成),再等回到默认文案,最后断言无页面错误。
  await btn.click();
  await expect(status.locator('button').filter({ hasText: MCP_COPY_FEEDBACK })).toBeVisible({
    timeout: 5_000,
  });
  await expect(status.locator('button').filter({ hasText: MCP_COPY })).toBeVisible({ timeout: 5_000 });
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
