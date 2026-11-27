// 搜索结果预览保留空白、Tab 不让词序颠倒(BDD: src/__tests__/workspace-search/ 5、design-system TruncateStart):
// 第五十三轮审计:`x = needle + y` 显示成 `x =needle+ y`、`foo\tbar needle` 显示成 `bar  fooneedle` —— 前文的 rtl 截断下
// 双向算法 L1 把行尾空白 / Tab 重置成 rtl,后文 / 命中的 truncate(nowrap)合并空格。按真实排版位置(Range 矩形)断言。
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import type { Locator, Page } from '@playwright/test';
import { test, expect } from './fixtures/with-workspace';
import { waitForTestHooks } from './helpers/app-ready';

const QUERY = /^(搜索|Search|검색)$/;
const resultsTree = (window: Page) => window.getByRole('tree', { name: /^(搜索结果|Search results|검색 결과)$/ });

/** 预览行里各字符(按 DOM 文本顺序)的屏幕左边缘;空白字符也取(宽度 > 0)。 */
function charLefts(row: Locator): Promise<{ ch: string; left: number; width: number }[]> {
  return row.locator('[data-search-preview]').evaluate((root) => {
    const out: { ch: string; left: number; width: number }[] = [];
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const text = node.textContent ?? '';
      for (let i = 0; i < text.length; i++) {
        const r = document.createRange();
        r.setStart(node, i);
        r.setEnd(node, i + 1);
        const rect = r.getBoundingClientRect();
        out.push({ ch: text[i]!, left: rect.left, width: rect.width });
      }
    }
    return out;
  });
}

async function previewRow(window: Page, file: string): Promise<Locator> {
  const tree = resultsTree(window);
  const fileRow = tree.locator('[role=treeitem][aria-level="1"]').filter({ hasText: file });
  await expect(fileRow).toHaveCount(1, { timeout: 10_000 });
  // 文件行之后紧跟它的匹配行
  return fileRow.locator('xpath=following-sibling::*[1]');
}

test('前文 / 命中 / 后文的空格与 Tab 按原顺序显示(文本顺序 = 屏幕从左到右)', async ({ window, workspaceRoot }) => {
  writeFileSync(path.join(workspaceRoot, 'src', 'p1.ts'), 'x = needle + y\n');
  writeFileSync(path.join(workspaceRoot, 'src', 'p2.ts'), 'foo\tbar needle\n');
  writeFileSync(path.join(workspaceRoot, 'src', 'p3.ts'), 'one two\tthree four needle\n');
  writeFileSync(path.join(workspaceRoot, 'src', 'p4.ts'), 'short needle\n');
  await waitForTestHooks(window);
  await window.keyboard.press('ControlOrMeta+Shift+KeyF');
  const input = window.getByRole('textbox', { name: QUERY });
  await expect(input).toBeFocused({ timeout: 10_000 });
  await input.fill('needle');

  for (const [file, before] of [
    ['p1.ts', 'x = '],
    ['p2.ts', 'foo     bar '],
    ['p3.ts', 'one two three four '],
    ['p4.ts', 'short '],
  ] as const) {
    const row = await previewRow(window, file);
    await expect(row.locator('mark')).toHaveText('needle');
    await expect(row.locator('[data-preview-before]')).toHaveText(before);
    const chars = await charLefts(row);
    // 屏幕顺序与文本顺序一致(每个字符都在前一个字符右边)
    for (let i = 1; i < chars.length; i++) {
      expect(chars[i]!.left, `${file} 第 ${i} 个字符 ${JSON.stringify(chars[i]!.ch)}`).toBeGreaterThan(chars[i - 1]!.left);
    }
    // 命中前的空格占位(不被合并 / 挪走)
    const markIdx = chars.findIndex((c, i) => chars.slice(i, i + 6).map((x) => x.ch).join('') === 'needle');
    expect(chars[markIdx - 1]!.ch).toBe(' ');
    expect(chars[markIdx - 1]!.width).toBeGreaterThan(0);
  }
  // 后文的前导空格保留:`needle + y`
  const p1 = await charLefts(await previewRow(window, 'p1.ts'));
  expect(p1.map((c) => c.ch).join('')).toBe('x = needle + y');
  const plus = p1.findIndex((c) => c.ch === '+');
  expect(p1[plus - 1]!.ch).toBe(' ');
  expect(p1[plus - 1]!.width).toBeGreaterThan(0);

  // 命中词首尾带空格(搜 ` from`)
  writeFileSync(path.join(workspaceRoot, 'src', 'p5.ts'), "import a from 'b'\n");
  await input.fill(' from');
  const row = await previewRow(window, 'p5.ts');
  await expect(row.locator('mark')).toHaveText(' from');
  const chars = await charLefts(row);
  expect(chars.map((c) => c.ch).join('')).toBe("import a from 'b'");
  for (let i = 1; i < chars.length; i++) expect(chars[i]!.left).toBeGreaterThan(chars[i - 1]!.left);
});
