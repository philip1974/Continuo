// 行号栏鼠标选行(对齐 VSCode):单击行号选整行(含换行)、按住拖动按行扩展、⇧ 单击扩展;拖动时行号数字不被浏览器选中。
// 真实鼠标事件(page.mouse)。BDD: src/__tests__/editor-line-number-select/
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { test, expect } from './fixtures/with-workspace';
import { openWorkspaceFile } from './helpers/editor';
import { cmSelection } from './helpers/codemirror';

const LINES = Array.from({ length: 12 }, (_, i) => `line ${i + 1}`).join('\n');

test.use({
  // eslint-disable-next-line no-empty-pattern -- Playwright 夹具要求对象解构参数
  workspaceRoot: async ({}, use) => {
    const root = mkdtempSync(path.join(tmpdir(), 'ui150-lns-ws-'));
    writeFileSync(path.join(root, 'lines.txt'), LINES);
    await use(root);
    rmSync(root, { recursive: true, force: true });
  },
});

const lineNumber = (window: Page, n: number) =>
  window.locator('.cm-lineNumbers .cm-gutterElement').filter({ hasText: new RegExp(`^${n}$`) }).first();

async function centerOf(window: Page, n: number): Promise<{ x: number; y: number }> {
  const box = (await lineNumber(window, n).boundingBox())!;
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

test('单击行号选整行;拖动按行扩展(向下 / 向上);⇧ 单击扩展;行号文字不被选中', async ({ window }) => {
  await openWorkspaceFile(window, ['lines.txt']);
  const content = window.locator('.cm-content').first();
  await expect(content).toContainText('line 12');
  await expect(lineNumber(window, 5)).toBeVisible();

  // 单击第 3 行行号 → 选中「line 3\n」,光标在第 4 行行首;编辑器获焦
  const p3 = await centerOf(window, 3);
  await window.mouse.click(p3.x, p3.y);
  await expect.poll(() => cmSelection(content)).toMatchObject({ text: 'line 3\n', headLine: 4, ranges: 1 });
  await expect(window.locator('.cm-editor.cm-focused')).toHaveCount(1);

  // 从第 2 行行号按住拖到第 5 行 → 第 2..5 行
  const p2 = await centerOf(window, 2);
  const p5 = await centerOf(window, 5);
  await window.mouse.move(p2.x, p2.y);
  await window.mouse.down();
  await window.mouse.move(p5.x, p5.y, { steps: 6 });
  await expect.poll(() => cmSelection(content)).toMatchObject({ text: 'line 2\nline 3\nline 4\nline 5\n', headLine: 6 });
  // 拖动期间浏览器原生选区不含行号数字(gutter 不参与文字选择)
  const domSel = await window.evaluate(() => document.getSelection()?.toString() ?? '');
  expect(domSel).not.toMatch(/^\s*\d+\s*$/m);
  // 再向上拖到第 1 行 → 第 1..2 行(锚点在第 2 行末)
  const p1 = await centerOf(window, 1);
  await window.mouse.move(p1.x, p1.y, { steps: 6 });
  await expect.poll(() => cmSelection(content)).toMatchObject({ text: 'line 1\nline 2\n', headLine: 1 });
  await window.mouse.up();

  // 松开后移动不再跟随
  await window.mouse.move(p5.x, p5.y, { steps: 3 });
  await expect.poll(() => cmSelection(content)).toMatchObject({ text: 'line 1\nline 2\n' });

  // 先单击第 4 行行号,再 ⇧ 单击第 7 行行号 → 第 4..7 行
  const p4 = await centerOf(window, 4);
  await window.mouse.click(p4.x, p4.y);
  const p7 = await centerOf(window, 7);
  await window.keyboard.down('Shift');
  await window.mouse.click(p7.x, p7.y);
  await window.keyboard.up('Shift');
  await expect.poll(() => cmSelection(content)).toMatchObject({ text: 'line 4\nline 5\nline 6\nline 7\n', headLine: 8 });

  // 选中后直接键入 → 替换整行(焦点在编辑器)
  await window.mouse.click(p3.x, p3.y);
  await window.keyboard.type('X\n');
  await expect(content).toContainText('X');
  await expect.poll(() => content.evaluate((el) => el.textContent ?? '')).not.toContain('line 3');
});
