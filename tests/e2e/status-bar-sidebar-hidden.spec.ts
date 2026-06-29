// 有 workspace + 关 sidebar → footer 含 hidden hint + basename + main 分支占位.
import path from 'node:path';
import { test, expect } from './fixtures/with-workspace';
import { EXPLORER_HIDE, SIDEBAR_HIDDEN_TEXT } from './helpers/explorer';

test('workspace + 关 sidebar → footer 含 basename / main / hidden hint', async ({
  window,
  workspaceRoot,
}) => {
  const footer = window.locator('footer');
  // workspace basename
  await expect(footer).toContainText(path.basename(workspaceRoot));
  // git 分支占位
  await expect(footer).toContainText('main');
  // sidebar 默认开 → 没 hidden hint.
  await expect(footer).not.toContainText(SIDEBAR_HIDDEN_TEXT);

  // 点 IconSidebar 「隐藏 Explorer」按钮 toggle off
  await window
    .getByRole('button', { name: EXPLORER_HIDE })
    .first()
    .click();

  await expect(footer).toContainText(SIDEBAR_HIDDEN_TEXT, {
    timeout: 5_000,
  });
});
