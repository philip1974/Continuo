// dockview layout 写盘:加 Terminal session → debounce 300ms → layout.json 剥离 terminal panel.
import { expect, test } from './fixtures/with-workspace';
import { TERMINAL_INPUT } from './helpers/editor';
import { dockHeaderMoreActionsButton } from './helpers/explorer';
import { TERMINAL_TAB } from './helpers/settings';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

test('加 Terminal session → 等 debounce → layout.json 不含 terminal panel', async ({
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

  await window.waitForTimeout(800);

  const layoutPath = path.join(userDataDir, 'layout.json');
  if (existsSync(layoutPath)) {
    const raw = readFileSync(layoutPath, 'utf8');
    expect(raw).not.toContain('"contentComponent":"terminal"');
  }
});
