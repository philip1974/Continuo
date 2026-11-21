// Quick Open Ctrl+P 切换:isOpen=false → open;isOpen=true → close.
import { test, expect } from './fixtures/electron-app';
import {
  commandPaletteInput,
  openCommandPalette,
  openQuickOpen,
  quickOpenInput,
} from './helpers/palette';
import { dispatchModKey } from './helpers/hotkeys';

test('Ctrl+P 二次 → toggle 关闭', async ({ window }) => {
  await openQuickOpen(window);
  const input = quickOpenInput(window);
  await expect(input).toBeVisible();

  // 再按 Ctrl+P → toggle close
  await dispatchModKey(window, 'p');
  await expect(input).toBeHidden();
});

test('Ctrl+Shift+P 二次 → 命令面板 toggle 关闭', async ({ window }) => {
  await openCommandPalette(window);
  const input = commandPaletteInput(window);
  await expect(input).toBeVisible();

  await dispatchModKey(window, 'p', { shift: true });
  await expect(input).toBeHidden();
});
