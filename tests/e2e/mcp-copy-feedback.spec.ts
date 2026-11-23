// 点 MCP 复制按钮 → 文案 1.5s 内变化(非默认),然后回归.
import { test, expect } from './fixtures/electron-app';
import { MCP_COPY, MCP_COPY_FEEDBACK } from './helpers/status-bar';

test('MCP 复制按钮:点 → 文案变 → 1.5s 后 复回 默认', async ({ window }) => {
  const status = window.locator('footer');
  const btn = status.locator('button').filter({ hasText: MCP_COPY });
  await expect(btn).toBeVisible();

  await btn.click();

  // 文案先变为反馈三态之一(已复制 / MCP 不可用 / 复制失败),约 1.5s 后回到默认文案
  await expect(status.locator('button').filter({ hasText: MCP_COPY_FEEDBACK })).toBeVisible({
    timeout: 3_000,
  });
  await expect(status.locator('button').filter({ hasText: MCP_COPY })).toBeVisible({
    timeout: 5_000,
  });
});
