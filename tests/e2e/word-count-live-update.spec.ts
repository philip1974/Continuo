// 输入 → wordCount 实时更新.
import { test, expect } from './fixtures/with-workspace';

test('a.ts 输入 → footer 词数增加', async ({ window }) => {
  await window.locator('text=src').first().click();
  await window.locator('text=a.ts').first().click();

  // 默认 'export const a = 1;\n' → 5 词('export','const','a','=','1;')
  const footer = window.locator('footer');
  const before = await footer.textContent();
  const matchBefore = before?.match(/(\d+)\s*词/);
  const wordsBefore = matchBefore ? Number(matchBefore[1]) : 0;
  expect(wordsBefore).toBeGreaterThan(0);

  const cm = window.locator('.cm-content');
  await cm.click();
  await cm.press('ControlOrMeta+End');
  await window.keyboard.type(' new word here');

  await expect(async () => {
    const after = await footer.textContent();
    const matchAfter = after?.match(/(\d+)\s*词/);
    const wordsAfter = matchAfter ? Number(matchAfter[1]) : 0;
    expect(wordsAfter).toBeGreaterThan(wordsBefore);
  }).toPass({ timeout: 5_000 });
});
