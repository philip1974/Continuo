// QuickOpen 开 → Cmd+Shift+P 触发 palette → 多个 .wm-modal-content 并存或 QO 关.
import { test, expect } from './fixtures/electron-app';
import {
  commandPaletteInput,
  openCommandPalette,
  openQuickOpen,
  quickOpenInput,
} from './helpers/palette';

test('QuickOpen 开 → Cmd+Shift+P → CommandPalette 也响应', async ({
  window,
}) => {
  // 开 QuickOpen
  await openQuickOpen(window);
  const qoInput = quickOpenInput(window);
  await expect(qoInput).toBeVisible({ timeout: 5_000 });

  // 触发 palette
  await openCommandPalette(window);

  // CommandPalette input 应可见
  const cpInput = commandPaletteInput(window);
  await expect(cpInput).toBeVisible({ timeout: 5_000 });
});
