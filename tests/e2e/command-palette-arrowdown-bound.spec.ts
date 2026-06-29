// CommandPalette ArrowDown 越界 → moveSelection 自然 wrap / clamp 行为.
// store.moveSelection(delta, max) 实现:wrap 到 (cur+delta+max) % max.
// 多次按下 ArrowDown 不会越界,顶到末尾后回 0.
import { test, expect } from './fixtures/electron-app';

const SETTINGS = /^(设置|Settings|설정)$/;
const COMMAND_SEARCH = /^(输入命令名…|Type a command…|명령어 입력…)$/;
const COMMAND_LIST = /^(命令列表|Command list|명령어 목록)$/;

test('ArrowDown N 次 → wrap 回 0 / 不越界', async ({ window }) => {
  await expect(window.getByRole('button', { name: SETTINGS })).toBeVisible({
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
  const input = window.getByRole('combobox', { name: COMMAND_SEARCH });
  await expect(input).toBeVisible();

  const items = window
    .getByRole('listbox', { name: COMMAND_LIST })
    .getByRole('option');
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
