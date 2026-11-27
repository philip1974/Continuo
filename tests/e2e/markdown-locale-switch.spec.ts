// 运行中切换界面语言:Markdown 编辑模式(Crepe)以当前内容重挂,光标 / 焦点还原到切换前的位置,可直接继续输入。
// 撤销历史不保留(见 src/__tests__/editor-milkdown-chrome-i18n/README.md)。
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { test, expect } from './fixtures/with-workspace';
import { EDITOR_MODE_EDIT, editorModeButton, openWorkspaceFile } from './helpers/editor';

test('切换语言后编辑区焦点与光标还原,继续输入落在原光标处;浮层文案换成新语言', async ({ window, workspaceRoot }) => {
  writeFileSync(path.join(workspaceRoot, 'loc.md'), '# Locale\n\nalpha beta gamma\n');
  await openWorkspaceFile(window, ['loc.md']);
  await editorModeButton(window, EDITOR_MODE_EDIT).click();
  const pm = window.locator('main .milkdown .ProseMirror');
  const para = pm.locator('p', { hasText: 'alpha beta gamma' });
  await expect(para).toBeVisible({ timeout: 10_000 });

  await window.evaluate(() => globalThis.__continuoTest!.setSettingValue('general.language', 'en'));
  // 光标放到 beta 之后
  await para.click();
  await window.keyboard.press('End');
  for (let i = 0; i < ' gamma'.length; i++) await window.keyboard.press('ArrowLeft');
  const oldPm = await pm.elementHandle();

  await window.evaluate(() => globalThis.__continuoTest!.setSettingValue('general.language', 'zh'));
  // 重挂:换了新的 ProseMirror 根
  await expect.poll(async () => (await pm.elementHandle())?.evaluate((el, old) => el !== old, oldPm)).toBe(true);
  await expect(pm).toHaveAttribute('aria-label', /编辑器/);
  await expect.poll(() => window.evaluate(() => !!document.activeElement?.closest('.ProseMirror'))).toBe(true);

  await window.keyboard.type('X');
  await expect(pm.locator('p', { hasText: 'alpha betaX gamma' })).toBeVisible();
  await window.evaluate(() => globalThis.__continuoTest!.setSettingValue('general.language', 'en'));
});
