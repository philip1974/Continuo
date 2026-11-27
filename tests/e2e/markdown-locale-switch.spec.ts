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

test('查找条开着时切换语言:计数 / 当前高亮保持切换前的匹配,下一次 Enter 从它接着走', async ({ window, workspaceRoot }) => {
  const paras = Array.from({ length: 11 }, (_, i) => `para ${i + 1} text`).join('\n\n');
  writeFileSync(path.join(workspaceRoot, 'find-loc.md'), `# Find\n\n${paras}\n`);
  await openWorkspaceFile(window, ['find-loc.md']);
  await window.evaluate(() => globalThis.__continuoTest!.setSettingValue('general.language', 'en'));
  await editorModeButton(window, EDITOR_MODE_EDIT).click();
  const pm = window.locator('main .milkdown .ProseMirror');
  await expect(pm.locator('p', { hasText: 'para 1 text' })).toBeVisible({ timeout: 10_000 });
  await pm.locator('h1').click(); // 光标在所有匹配之前
  await window.keyboard.press('ControlOrMeta+KeyF');
  const input = window.getByRole('textbox', { name: /^(查找|Find|찾기)$/ });
  await expect(input).toBeFocused();
  await window.keyboard.type('para');
  const status = window.locator('main [role="status"]', { hasText: /\d+ \/ 11/ });
  await expect(status).toHaveText('1 / 11');
  for (let i = 0; i < 5; i++) await window.keyboard.press('Enter');
  await expect(status).toHaveText('6 / 11');
  const oldPm = await pm.elementHandle();

  await window.evaluate(() => globalThis.__continuoTest!.setSettingValue('general.language', 'zh'));
  await expect.poll(async () => (await pm.elementHandle())?.evaluate((el, old) => el !== old, oldPm)).toBe(true);
  await expect(pm).toHaveAttribute('aria-label', /编辑器/);
  await expect(status).toHaveText('6 / 11');
  await expect(pm.locator('.co-find-match-current')).toHaveText('para');
  await expect(pm.locator('p', { has: window.locator('.co-find-match-current') })).toHaveText('para 6 text');
  await expect(input).toBeFocused();
  await window.keyboard.press('Enter');
  await expect(status).toHaveText('7 / 11');
  await expect(pm.locator('p', { has: window.locator('.co-find-match-current') })).toHaveText('para 7 text');
  await window.evaluate(() => globalThis.__continuoTest!.setSettingValue('general.language', 'en'));
});
