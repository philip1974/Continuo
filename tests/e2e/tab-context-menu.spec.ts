// BDD:src/__tests__/tab-context-menu —— tab 右键菜单(对齐 VSCode)。
import { chmod, readFile } from 'node:fs/promises';
import path from 'node:path';
import { test, expect } from './fixtures/with-workspace';
import {
  EDITOR_DONT_SAVE,
  EDITOR_NO_FILE_OPEN,
  EDITOR_SAVE_CHANGES_TITLE,
  EDITOR_TABS,
  EDITOR_UNSAVED_CHANGES_SELECTOR,
} from './helpers/editor';
import { SETTINGS } from './helpers/settings';

const CLOSE_ALL = /^(全部关闭|Close All|모두 닫기)$/;
const CLOSE_OTHERS = /^(关闭其他|Close Others|기타 항목 닫기)$/;
const READONLY_TITLE = /^(File Is Read-Only|文件是只读的|읽기 전용 파일)$/;
const OVERWRITE = /^(Overwrite|覆盖|덮어쓰기)$/;
const MULTI_TITLE = /(following 2 files|以下 2 个文件|다음 2개 파일)/;
const SAVE_ALL = /^(Save All|全部保存|모두 저장)$/;

test('编辑器 tab 右键「全部关闭」遇脏文件:先确认,取消则一个都不关;不保存则全部关闭', async ({ window }) => {
  await window.locator('text=README.md').first().click();
  await window.locator('text=src').first().click();
  await window.locator('text=a.ts').first().click();
  const tabs = window.getByRole('tablist', { name: EDITOR_TABS }).getByRole('tab');
  await expect(tabs).toHaveCount(2, { timeout: 10_000 });

  const cm = window.locator('.cm-content');
  await expect(cm).toBeVisible({ timeout: 10_000 });
  await cm.click();
  await window.keyboard.type(' // dirty');
  await expect(window.locator(EDITOR_UNSAVED_CHANGES_SELECTOR)).toBeVisible({ timeout: 5_000 });

  // 右键 README.md tab → 菜单 → 全部关闭 → a.ts 脏 → 确认框;Esc 取消 → 两个 tab 都还在。
  await tabs.filter({ hasText: 'README.md' }).click({ button: 'right' });
  await window.getByRole('menuitem', { name: CLOSE_ALL }).click();
  const dialog = window.locator('.wm-modal-content');
  await expect(dialog).toContainText(EDITOR_SAVE_CHANGES_TITLE);
  await window.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(tabs).toHaveCount(2);

  // 再来一次选「不保存」→ 全部关闭。
  await tabs.filter({ hasText: 'README.md' }).click({ button: 'right' });
  await window.getByRole('menuitem', { name: CLOSE_ALL }).click();
  await expect(dialog).toBeVisible();
  await dialog.locator('button').filter({ hasText: EDITOR_DONT_SAVE }).click();
  await expect(window.getByText(EDITOR_NO_FILE_OPEN).first()).toBeVisible({ timeout: 5_000 });
});

test('编辑器 tab「全部关闭」遇 2 个脏文件 → 一个合并框列出两者;「全部保存」中途遇写保护 →「覆盖」后接着保存下一个,全部处理完一起关闭', async ({
  window,
  workspaceRoot,
}) => {
  test.skip(process.platform === 'win32', 'chmod 444 在 Windows 只映射只读属性,由单测覆盖');
  const aPath = path.join(workspaceRoot, 'src/a.ts');
  const bPath = path.join(workspaceRoot, 'src/b.ts');
  await window.locator('text=README.md').first().click();
  await window.locator('text=src').first().click();
  const tabs = window.getByRole('tablist', { name: EDITOR_TABS }).getByRole('tab');
  const cm = window.locator('.cm-content');
  for (const name of ['a.ts', 'b.ts']) {
    await window.locator(`text=${name}`).first().click();
    await expect(tabs.filter({ hasText: name })).toHaveAttribute('aria-selected', 'true', { timeout: 10_000 });
    await expect(cm).toContainText(`export const ${name[0]}`, { timeout: 10_000 });
    await cm.click();
    await window.keyboard.press('ControlOrMeta+End');
    await window.keyboard.type(`\n// dirty-${name}`);
  }
  await expect(tabs).toHaveCount(3);
  await chmod(aPath, 0o444);

  await tabs.filter({ hasText: 'README.md' }).click({ button: 'right' });
  await window.getByRole('menuitem', { name: CLOSE_ALL }).click();
  const dialog = window.locator('.wm-modal-content');
  await expect(dialog).toContainText(MULTI_TITLE);
  await expect(dialog.locator('li')).toHaveText(['a.ts', 'b.ts']);
  await dialog.getByRole('button', { name: SAVE_ALL }).click();
  await expect(dialog.getByText(READONLY_TITLE)).toBeVisible({ timeout: 5_000 });
  await expect(tabs).toHaveCount(3); // 尚未处理完 → 一个都不关
  await dialog.getByRole('button', { name: OVERWRITE }).click();
  await expect.poll(() => readFile(aPath, 'utf8'), { timeout: 5_000 }).toContain('// dirty-a.ts');
  // 接着保存 b.ts(不再逐个询问),然后全部关闭
  await expect.poll(() => readFile(bPath, 'utf8'), { timeout: 5_000 }).toContain('// dirty-b.ts');
  await expect(window.getByText(EDITOR_NO_FILE_OPEN).first()).toBeVisible({ timeout: 5_000 });
});

test('dock tab 右键:Shift+F10 打开菜单,「关闭其他」只留当前面板', async ({ window }) => {
  await window.locator('text=README.md').first().click();
  await window.getByRole('button', { name: SETTINGS }).click();
  const settingsTab = window.locator('.dv-tab [role=tab]', { hasText: /^(设置|Settings|설정)/ });
  await expect(settingsTab).toBeVisible({ timeout: 10_000 });
  await expect(window.locator('.dv-tab')).toHaveCount(2);

  await settingsTab.focus();
  await window.keyboard.press('Shift+F10');
  await window.getByRole('menuitem', { name: CLOSE_OTHERS }).click();
  await expect(window.locator('.dv-tab')).toHaveCount(1, { timeout: 5_000 });
  await expect(settingsTab).toBeVisible();
});
