// Quick Open / 命令面板高亮命中字符(VSCode Quick Input highlights)。
// BDD: src/__tests__/quick-open-modal/、src/__tests__/command-palette/、src/__tests__/picker-shared/
import { test, expect } from './fixtures/with-workspace';
import { commandPaletteInput, openCommandPalette, openQuickOpen, quickOpenInput } from './helpers/palette';

test('Quick Open:文件名与目录里的命中字符加粗高亮,背景透明;行文本不变', async ({ window }) => {
  await openQuickOpen(window);
  await expect(window.locator('.wm-modal-content')).toContainText('a.ts', { timeout: 10_000 });
  await quickOpenInput(window).fill('src/a');
  const row = window.locator('.wm-modal-content li').first();
  await expect(row).toHaveAttribute('title', 'src/a.ts');
  await expect(row.locator('mark')).toHaveText(['a', 'src']);
  const style = await row.locator('mark').first().evaluate((el) => {
    const cs = getComputedStyle(el);
    return { bg: cs.backgroundColor, weight: Number(cs.fontWeight) };
  });
  expect(style.bg).toBe('rgba(0, 0, 0, 0)');
  expect(style.weight).toBeGreaterThanOrEqual(600);
  await expect(row).toHaveText('a.tssrc');
});

test('命令面板:分类 / 标题里的命中字符高亮(界面语言无关:取首行开头两个字作查询)', async ({ window }) => {
  await openCommandPalette(window);
  const first = window.locator('.wm-modal-content li').first();
  await expect(first).toBeVisible();
  const query = ((await first.textContent()) ?? '').replace(/[\s:]/g, '').slice(0, 2);
  expect(query.length).toBe(2);
  await commandPaletteInput(window).fill(query);
  const marks = window.locator('.wm-modal-content li').first().locator('mark');
  await expect(marks.first()).toBeVisible();
  expect((await marks.allTextContents()).join('').toLowerCase()).toBe(query.toLowerCase());
});
