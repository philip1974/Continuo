import { expect, type Page } from '@playwright/test';
import { SETTINGS } from './settings';

export const OUTPUT_PANEL = /^(输出|Output|출력)$/;
export const OUTPUT_CLOSE =
  /^(关闭 (输出|Output)|Close (输出|Output)|(출력|Output) 닫기)$/;
export const OUTPUT_READY =
  /(Continuo 就绪|Continuo ready|Continuo 준비됨)/;
export const OUTPUT_LAYOUT_RESTORED =
  /(已恢复停靠布局|dock layout restored|도크 레이아웃 복원됨)/;

export async function openOutputPanel(window: Page): Promise<void> {
  await expect(window.getByRole('button', { name: SETTINGS })).toBeVisible({
    timeout: 10_000,
  });
  await window.waitForFunction(
    () =>
      Boolean(
        (window as unknown as { __continuoTest?: unknown }).__continuoTest,
      ),
    { timeout: 5_000 },
  );
  await window.evaluate(() => {
    const t = (
      window as unknown as {
        __continuoTest: {
          openOrFocusPanel: (id: string, c: string, t: string) => void;
        };
      }
    ).__continuoTest;
    t.openOrFocusPanel('output', 'output', 'Output');
  });
  await expect(window.getByText(OUTPUT_READY)).toBeVisible({
    timeout: 10_000,
  });
}
