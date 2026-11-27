// 滚动超过最后一行(editor.scrollBeyondLastLine,默认开):真实滚轮滚到底时最后一行可以到达视口顶部;关掉设置后最后一行停在底部。
// BDD: src/__tests__/editor-scroll-beyond-last-line/
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { test, expect } from './fixtures/with-workspace';
import { openWorkspaceFile } from './helpers/editor';
import { waitForTestHooks } from './helpers/app-ready';

test.use({
  // eslint-disable-next-line no-empty-pattern -- Playwright 夹具要求对象解构参数
  workspaceRoot: async ({}, use) => {
    const root = mkdtempSync(path.join(tmpdir(), 'ui150-spe-ws-'));
    writeFileSync(path.join(root, 'long.txt'), Array.from({ length: 200 }, (_, i) => `row ${i + 1}`).join('\n'));
    writeFileSync(path.join(root, 'long.md'), Array.from({ length: 200 }, (_, i) => `para ${i + 1}`).join('\n\n'));
    await use(root);
    rmSync(root, { recursive: true, force: true });
  },
});

/** 最后一行相对滚动区的位置:顶部距离 / 底部距离(px)。 */
function lastLineOffsets(window: Page): Promise<{ fromTop: number; fromBottom: number }> {
  return window.locator('.cm-scroller').first().evaluate((scroller) => {
    const lines = scroller.querySelectorAll('.cm-line');
    const last = lines[lines.length - 1]!.getBoundingClientRect();
    const box = scroller.getBoundingClientRect();
    return { fromTop: last.top - box.top, fromBottom: box.bottom - last.bottom };
  });
}

async function wheelToEnd(window: Page): Promise<void> {
  const box = (await window.locator('.cm-scroller').first().boundingBox())!;
  await window.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  for (let i = 0; i < 40; i++) await window.mouse.wheel(0, 2000);
  await expect
    .poll(() => window.locator('.cm-scroller').first().evaluate((s) => s.scrollHeight - s.clientHeight - s.scrollTop))
    .toBeLessThan(2);
}

test('默认:滚轮滚到底,最后一行到达视口顶部;关掉设置后最后一行停在视口底部', async ({ window }) => {
  await openWorkspaceFile(window, ['long.txt']);
  await expect(window.locator('.cm-content').first()).toContainText('row 1');
  await wheelToEnd(window);
  await expect(window.locator('.cm-line').last()).toHaveText('row 200');
  const on = await lastLineOffsets(window);
  expect(on.fromTop).toBeLessThan(40);

  await waitForTestHooks(window);
  await window.evaluate(() => globalThis.__continuoTest!.setSettingValue('editor.scrollBeyondLastLine', false));
  await wheelToEnd(window);
  const off = await lastLineOffsets(window);
  expect(off.fromBottom).toBeLessThan(40);
  expect(off.fromTop).toBeGreaterThan(100);
});

test('Markdown 源码模式同样可以滚过最后一行', async ({ window }) => {
  await openWorkspaceFile(window, ['long.md']);
  const source = window.locator('main').getByRole('radio', { name: /^(源码|Source|소스)$/ }).first();
  await source.click();
  await expect(window.locator('.cm-content').first()).toContainText('para 1');
  await wheelToEnd(window);
  await expect(window.locator('.cm-line').last()).toHaveText('para 200');
  expect((await lastLineOffsets(window)).fromTop).toBeLessThan(40);
});
