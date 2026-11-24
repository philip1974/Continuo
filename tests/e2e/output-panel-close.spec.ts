// Output panel 添加后,点 Close Output → panel 关闭.
import { test, expect } from './fixtures/electron-app';
import { OUTPUT_CLOSE, OUTPUT_EMPTY, openOutputPanel } from './helpers/output';

test('open Output → close → 空状态文案消失', async ({ window }) => {
  await openOutputPanel(window);

  await window.getByRole('button', { name: OUTPUT_CLOSE }).click();
  // 等关闭动画
  await window.waitForTimeout(300);
  await expect(window.getByText(OUTPUT_EMPTY)).toBeHidden({
    timeout: 5_000,
  });
});
