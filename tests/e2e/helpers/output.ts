import { expect, type Page } from '@playwright/test';
import { SETTINGS } from './settings';
import { waitForTestHooks } from './app-ready';

export const OUTPUT_PANEL = /^(输出|Output|출력)$/;
export const OUTPUT_CLOSE =
  /^(关闭 (输出|Output)|Close (输出|Output)|(출력|Output) 닫기)$/;
// Output 面板目前无写入方,只渲染空状态文案(panels.output.empty);其出现即表示面板内容已挂载。
export const OUTPUT_EMPTY = /(暂无输出。|No output yet\.|아직 출력이 없습니다\.)/;

export async function openOutputPanel(window: Page): Promise<void> {
  await expect(window.getByRole('button', { name: SETTINGS })).toBeVisible({
    timeout: 10_000,
  });
  await waitForTestHooks(window);
  // testing hook 可能先于 dock 就绪暴露(openOrFocusPanel 此时 no-op):重试到面板出现
  await expect(async () => {
    await window.evaluate(() => {
      const t = globalThis.__continuoTest!;
      t.openOrFocusPanel('output', 'output', 'Output');
    });
    await expect(window.getByText(OUTPUT_EMPTY)).toBeVisible({ timeout: 2_000 });
  }).toPass({ timeout: 20_000 });
}
