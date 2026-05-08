// CommandPalette ArrowDown 越界 → moveSelection 自然 wrap / clamp 行为.
// store.moveSelection(delta, max) 实现:wrap 到 (cur+delta+max) % max.
// 多次按下 ArrowDown 不会越界,顶到末尾后回 0.
import { test, expect } from './fixtures/electron-app';

test('ArrowDown N 次 → wrap 回 0 / 不越界', async ({ window }) => {
  await expect(window.locator('button[title="设置"]')).toBeVisible({
    timeout: 10_000,
  });
  await window.evaluate(() => {
    document.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'p',
        ctrlKey: true,
        shiftKey: true,
        bubbles: true,
        cancelable: true,
      }),
    );
  });
  const input = window.locator(
    '.wm-modal-content input[placeholder^="输入命令名"]',
  );
  await expect(input).toBeVisible();

  const items = window.locator('.wm-modal-content li');
  const count = await items.count();
  expect(count).toBeGreaterThan(0);

  // ArrowDown count + 1 次:wrap 回头(末项后 → 第一项)
  for (let i = 0; i < count + 1; i++) {
    await window.keyboard.press('ArrowDown');
  }

  // 不抛 + modal 仍开
  await expect(input).toBeVisible();
  // 第一项有 selected 样式(bg-hover.text-fg)
  const firstClass = await items.first().getAttribute('class');
  expect(firstClass).toContain('bg-hover');
});
