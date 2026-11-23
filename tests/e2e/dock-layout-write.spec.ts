// dockview layout 写盘:加 Terminal session → debounce 300ms → layout:write 写入 explorer.json 的窗口段,已剥离 terminal panel.
import { expect, test } from './fixtures/with-workspace';
import { TERMINAL_INPUT } from './helpers/editor';
import { dockHeaderMoreActionsButton } from './helpers/explorer';
import { TERMINAL_TAB } from './helpers/settings';
import { persistedPanelComponents } from './helpers/persisted-layout';

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

  // 等明显超过 300ms 防抖,确保加终端之后的那次写盘已落地(剥离后布局与之前相同时会去重不写,
  // 故没有可轮询的「新写盘」信号);再断言窗口段 layout 含 editor panel、已剥离 terminal panel。
  await window.waitForTimeout(1_500);
  expect(persistedPanelComponents(userDataDir)).toContain('editor');
  expect(persistedPanelComponents(userDataDir)).not.toContain('terminal');
});
