// 搜索结果预览(BDD: src/__tests__/workspace-search/ 4、5):默认 1280×800 布局、默认侧栏宽度下,长行里靠后的命中词可见
//(命中前文按 VSCode lcut 截短 + 放不下时从左截前文);预览用 UI 比例字体,不用等宽字体。
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { test, expect } from './fixtures/with-workspace';
import { waitForTestHooks } from './helpers/app-ready';

const QUERY = /^(搜索|Search|검색)$/;
const resultsTree = (window: Page) => window.getByRole('tree', { name: /^(搜索结果|Search results|검색 결과)$/ });

test('1280×800 默认布局:长行里的命中词在结果行内完整可见;预览不是等宽字体', async ({ window, electronApp, workspaceRoot }) => {
  writeFileSync(
    path.join(workspaceRoot, 'src', 'long.ts'),
    'export function someVeryLongFunctionNameNumber0(argumentOne: string, argumentTwo: number, argumentThree: boolean): void {}\n',
  );
  await electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setSize(1280, 800));
  await waitForTestHooks(window);
  await window.keyboard.press('ControlOrMeta+Shift+KeyF');
  const input = window.getByRole('textbox', { name: QUERY });
  await expect(input).toBeFocused({ timeout: 10_000 });
  await input.fill('argumentTwo');
  const tree = resultsTree(window);
  await expect(tree.getByRole('treeitem')).toHaveCount(2, { timeout: 10_000 });
  const row = tree.getByRole('treeitem').nth(1);
  const mark = row.locator('mark');
  await expect(mark).toHaveText('argumentTwo');
  const [rowBox, markBox] = [(await row.boundingBox())!, (await mark.boundingBox())!];
  // 搜索组宽度(默认侧栏位置)
  const treeBox = (await tree.boundingBox())!;
  expect(treeBox.width).toBeLessThan(400);
  expect(markBox.x).toBeGreaterThanOrEqual(rowBox.x);
  expect(markBox.x + markBox.width).toBeLessThanOrEqual(Math.min(rowBox.x + rowBox.width, treeBox.x + treeBox.width) + 0.5);
  // 命中词没被截断(元素可见宽 = 内容宽)
  expect(await mark.evaluate((el) => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
  const fonts = await row.locator('[data-search-preview]').evaluate((el) => {
    const editor = document.createElement('span');
    editor.className = 'font-mono';
    document.body.append(editor);
    const mono = getComputedStyle(editor).fontFamily;
    editor.remove();
    return { preview: getComputedStyle(el).fontFamily, mono };
  });
  expect(fonts.preview).not.toBe(fonts.mono);
});
