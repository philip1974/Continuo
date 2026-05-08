// 有 workspace + 关 sidebar → footer 含「侧栏已隐藏」+ basename + main 分支占位.
import path from 'node:path';
import { test, expect } from './fixtures/with-workspace';

test('workspace + 关 sidebar → footer 含 basename / main / 「侧栏已隐藏」', async ({
  window,
  workspaceRoot,
}) => {
  const footer = window.locator('footer');
  // workspace basename
  await expect(footer).toContainText(path.basename(workspaceRoot));
  // git 分支占位
  await expect(footer).toContainText('main');
  // sidebar 默认开 → 没「侧栏已隐藏」
  await expect(footer).not.toContainText('侧栏已隐藏');

  // 点 IconSidebar 「隐藏 Explorer」按钮 toggle off
  await window
    .getByRole('button', { name: '隐藏 Explorer' })
    .first()
    .click();

  await expect(footer).toContainText('侧栏已隐藏', { timeout: 5_000 });
});
