// dockview layout 写盘:加 Terminal session → debounce 300ms → layout:write 写入 explorer.json 的窗口段,已剥离 terminal panel.
import { expect, test } from './fixtures/with-workspace';
import { TERMINAL_INPUT } from './helpers/editor';
import { dockHeaderMoreActionsButton } from './helpers/explorer';
import { TERMINAL_TAB } from './helpers/settings';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

test('加 Terminal session → 等 debounce → explorer.json 的 layout 不含 terminal panel', async ({
  userDataDir,
  window,
}) => {
  await dockHeaderMoreActionsButton(window).click();
  await window
    .getByRole('menu')
    .last()
    .getByRole('menuitem', { name: TERMINAL_TAB })
    .click();
  await expect(
    window.getByRole('textbox', { name: TERMINAL_INPUT }),
  ).toBeVisible({ timeout: 15_000 });

  const explorerPath = path.join(userDataDir, 'explorer.json');
  await expect
    .poll(() => (existsSync(explorerPath) ? readFileSync(explorerPath, 'utf8') : ''), { timeout: 5_000 })
    .toContain('"layout"');
  expect(readFileSync(explorerPath, 'utf8')).not.toContain('"contentComponent":"terminal"');
});
