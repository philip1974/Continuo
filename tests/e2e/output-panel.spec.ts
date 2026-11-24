// Output panel:openOrFocusPanel → 显空状态文案(目前无写入方,不再显示写死的假日志)。
import { test, expect } from './fixtures/electron-app';
import { OUTPUT_EMPTY, openOutputPanel } from './helpers/output';

test('打开 Output panel → 显空状态,无假日志', async ({ window }) => {
  await openOutputPanel(window);
  await expect(window.getByText(OUTPUT_EMPTY)).toBeVisible();
  await expect(window.getByText(/dock layout restored|已恢复停靠布局/)).toHaveCount(0);
});
