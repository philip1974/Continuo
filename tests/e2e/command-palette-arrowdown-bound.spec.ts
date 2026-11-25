// CommandPalette ArrowDown 越界 → moveSelection 自然 wrap / clamp 行为.
// store.moveSelection(delta, max) 实现:wrap 到 (cur+delta+max) % max.
// 多次按下 ArrowDown 不会越界,顶到末尾后回 0.
import { test, expect } from './fixtures/electron-app';
import { COMMAND_SEARCH } from './helpers/palette';
import { SETTINGS } from './helpers/settings';

test('ArrowDown N 次 → wrap 回 0 / 不越界', async ({ window }) => {
  await expect(window.getByRole('button', { name: SETTINGS })).toBeVisible({
    timeout: 10_000,
  });
  await window.evaluate(() => {
    document.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'p',
        // 平台主修饰键:mac = Cmd,其它 = Ctrl(mac 上面板热键只认 Cmd)
        ctrlKey: !navigator.platform.toLowerCase().includes('mac'),
        metaKey: navigator.platform.toLowerCase().includes('mac'),
        shiftKey: true,
        bubbles: true,
        cancelable: true,
      }),
    );
  });
  const input = window.getByRole('combobox', { name: COMMAND_SEARCH });
  await expect(input).toBeVisible();

  // 列表是虚拟滚动(只渲染视口附近的行):总数不能用渲染出的 option 个数,按 aria-activedescendant(选中项 id
  // 带下标)判定。第一项按 ArrowUp → 末项,其下标 + 1 = 总数。
  const active = () => input.getAttribute('aria-activedescendant');
  await expect.poll(active).toMatch(/-option-0$/);
  await window.keyboard.press('ArrowUp');
  await expect.poll(active).toMatch(/-option-[1-9]\d*$/);
  const count = Number(/-option-(\d+)$/.exec((await active()) ?? '')?.[1] ?? -1) + 1;
  expect(count).toBeGreaterThan(1);
  await window.keyboard.press('ArrowDown'); // 末项 → wrap 回第一项
  await expect.poll(active).toMatch(/-option-0$/);

  // ArrowDown count 次:从 0 走完一圈 wrap 回第一项
  for (let i = 0; i < count; i++) {
    await window.keyboard.press('ArrowDown');
  }
  await expect(input).toBeVisible();
  await expect.poll(active).toMatch(/-option-0$/);

  // 再按一次 → 第二项(下标 1)选中,不越界
  await window.keyboard.press('ArrowDown');
  await expect.poll(active).toMatch(/-option-1$/);
});
