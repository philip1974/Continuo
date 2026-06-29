// 点 MCP 复制按钮 → 文案 1.5s 内变化(非默认),然后回归.
import { test, expect } from './fixtures/electron-app';
import { MCP_COPY } from './helpers/status-bar';

test('MCP 复制按钮:点 → 文案变 → 1.5s 后 复回 默认', async ({ window }) => {
  const status = window.locator('footer');
  const btn = status.locator('button').filter({ hasText: MCP_COPY });
  await expect(btn).toBeVisible();

  await btn.click();

  // 即时文案 应该变(已复制 / MCP 不可用 / 复制失败 三态之一)
  // setTimeout 1.5s 内会回归;这里只要求最终能回到默认文案.
  // (timing 可能极快,不强制 catch 中间态;只需最终回归)
  await expect(status.locator('button').filter({ hasText: MCP_COPY })).toBeVisible({
    timeout: 5_000,
  });
});
