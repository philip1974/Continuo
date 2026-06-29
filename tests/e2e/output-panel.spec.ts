// Output panel:openOrFocusPanel → 显「Continuo ready」「dock layout restored」.
import { test, expect } from './fixtures/electron-app';
import { OUTPUT_LAYOUT_RESTORED, openOutputPanel } from './helpers/output';

test('打开 Output panel → 显占位 log 行', async ({ window }) => {
  await openOutputPanel(window);
  await expect(window.getByText(OUTPUT_LAYOUT_RESTORED)).toBeVisible();
});
