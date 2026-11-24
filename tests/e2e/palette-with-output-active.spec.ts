// Output panel active → Cmd+Shift+P → palette modal 显.
import { test, expect } from './fixtures/electron-app';
import { commandPaletteInput, openCommandPalette } from './helpers/palette';
import { waitForTestHooks } from './helpers/app-ready';

test('Output active → Cmd+Shift+P → palette 显', async ({ window }) => {
  await waitForTestHooks(window);
  await window.evaluate(() => {
    const t = globalThis.__continuoTest!;
    t.openOrFocusPanel('output', 'output', 'Output');
  });
  await window.waitForTimeout(200);

  await openCommandPalette(window);

  await expect(commandPaletteInput(window)).toBeVisible({ timeout: 5_000 });
});
