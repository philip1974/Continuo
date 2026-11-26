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
  DOCK_POPOUT,
} from './helpers/editor';
import { SETTINGS } from './helpers/settings';

const CLOSE_ALL = /^(全部关闭|Close All|모두 닫기)$/;
const CLOSE = /^(关闭|Close|닫기)$/;
const CLOSE_OTHERS = /^(关闭其他|Close Others|기타 항목 닫기)$/;
const READONLY_TITLE = /^(File Is Read-Only|文件是只读的|읽기 전용 파일)$/;
const OVERWRITE = /^(Overwrite|覆盖|덮어쓰기)$/;
const MULTI_TITLE = /(following 2 files|以下 2 个文件|다음 2개 파일)/;
const SAVE_ALL = /^(Save All|全部保存|모두 저장)$/;
const SAVE = /^(Save|保存|저장)$/;

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
  // 确认框是模态:初始焦点在「保存」,不被菜单关闭的焦点还原抢回背后的 tab
  await expect(dialog.getByRole('button', { name: SAVE })).toBeFocused({ timeout: 5_000 });
  await window.keyboard.press('Tab'); // Tab 留在确认框里,不进背后的 CodeMirror
  await expect(dialog.locator(':focus')).toHaveCount(1);
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
  await expect(dialog.getByRole('button', { name: SAVE_ALL })).toBeFocused({ timeout: 5_000 });
  await dialog.getByRole('button', { name: SAVE_ALL }).click();
  await expect(dialog.getByText(READONLY_TITLE)).toBeVisible({ timeout: 5_000 });
  await expect(tabs).toHaveCount(3); // 尚未处理完 → 一个都不关
  await dialog.getByRole('button', { name: OVERWRITE }).click();
  await expect.poll(() => readFile(aPath, 'utf8'), { timeout: 5_000 }).toContain('// dirty-a.ts');
  // 接着保存 b.ts(不再逐个询问),然后全部关闭
  await expect.poll(() => readFile(bPath, 'utf8'), { timeout: 5_000 }).toContain('// dirty-b.ts');
  await expect(window.getByText(EDITOR_NO_FILE_OPEN).first()).toBeVisible({ timeout: 5_000 });
});

test('编辑器 tab 右键「关闭」活动的干净 tab(不弹框)→ 同 ⌘W,焦点进新的活动编辑器,可直接键入', async ({ window }) => {
  await window.locator('text=README.md').first().click();
  await window.locator('text=src').first().click();
  await window.locator('text=a.ts').first().click();
  const tabs = window.getByRole('tablist', { name: EDITOR_TABS }).getByRole('tab');
  await expect(tabs).toHaveCount(2, { timeout: 10_000 });
  await expect(window.locator('.cm-content')).toContainText('export const a', { timeout: 10_000 });

  await tabs.filter({ hasText: 'a.ts' }).click({ button: 'right' });
  await window.getByRole('menuitem', { name: CLOSE }).click();
  await expect(tabs).toHaveCount(1, { timeout: 5_000 });
  const editable = window.locator('.cm-content, .ProseMirror').first();
  await expect(editable).toBeFocused({ timeout: 5_000 });
  await window.keyboard.type('ctx-close');
  await expect(editable).toContainText('ctx-close');
});

// 菜单关闭先把焦点还给被右键的 tab,随后它被移除 → 曾落到 body、键入丢失。VSCode(同点 ×):焦点留在活动编辑器。
test('编辑器 tab 右键「关闭」非活动的干净 tab → 焦点留在活动编辑器,可直接键入', async ({ window }) => {
  await window.locator('text=README.md').first().click();
  await window.locator('text=src').first().click();
  await window.locator('text=a.ts').first().click();
  const tabs = window.getByRole('tablist', { name: EDITOR_TABS }).getByRole('tab');
  await expect(tabs).toHaveCount(2, { timeout: 10_000 });
  const cm = window.locator('.cm-content');
  await expect(cm).toContainText('export const a', { timeout: 10_000 });
  await cm.click();

  await tabs.filter({ hasText: 'README.md' }).click({ button: 'right' });
  await window.getByRole('menuitem', { name: CLOSE }).click();
  await expect(tabs).toHaveCount(1, { timeout: 5_000 });
  await expect(cm).toBeFocused({ timeout: 5_000 });
  await window.keyboard.type('ctx-inactive');
  await expect(cm).toContainText('ctx-inactive');
});

test('dock tab 右键「关闭」非活动面板 → 焦点进同组活动的编辑器,可直接键入', async ({ window }) => {
  await window.locator('text=src').first().click();
  await window.locator('text=a.ts').first().click();
  const cm = window.locator('.cm-content');
  await expect(cm).toContainText('export const a', { timeout: 10_000 });
  await window.getByRole('button', { name: SETTINGS }).click();
  const settingsTab = window.locator('.dv-tab [role=tab]', { hasText: /^(设置|Settings|설정)/ });
  await expect(settingsTab).toBeVisible({ timeout: 10_000 });
  await expect(window.locator('.dv-tab')).toHaveCount(2);
  // 切回编辑器(设置面板成为同组非活动面板)
  await window.locator('.dv-tab [role=tab]', { hasText: /^(编辑器|Editor|편집기)$/ }).click();
  await expect(cm).toBeFocused({ timeout: 5_000 });

  await settingsTab.click({ button: 'right' });
  await window.getByRole('menuitem', { name: CLOSE }).click();
  await expect(window.locator('.dv-tab')).toHaveCount(1, { timeout: 5_000 });
  await expect(cm).toBeFocused({ timeout: 5_000 });
  await window.keyboard.type('dock-inactive');
  await expect(cm).toContainText('dock-inactive');
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

// popout 子窗:Radix 右键菜单按全局 document(主窗)记录 / 还原焦点,子窗里关闭菜单 / 取消确认后焦点曾落到子窗 body。
// 期望同主窗(VSCode 辅助窗口):焦点回到右键的那个 tab。
test('popout 子窗里 tab 右键「关闭」遇脏文件 → Esc 取消确认 → 焦点回到该 tab;菜单直接 Esc 同样回到 tab', async ({
  electronApp,
  window,
}) => {
  await window.locator('text=src').first().click();
  await window.locator('text=a.ts').first().click();
  const cm = window.locator('.cm-content');
  await expect(cm).toContainText('export const a', { timeout: 10_000 });
  await cm.click();
  await window.keyboard.type(' // dirty');
  await expect(window.locator(EDITOR_UNSAVED_CHANGES_SELECTOR)).toBeVisible({ timeout: 5_000 });
  await window.getByRole('button', { name: DOCK_POPOUT }).click();
  await expect.poll(() => electronApp.windows().length, { timeout: 10_000 }).toBe(2);
  const child = electronApp.windows().find((w) => w !== window)!;
  await child.waitForLoadState('domcontentloaded');
  await child.bringToFront();
  const tab = child.getByRole('tablist', { name: EDITOR_TABS }).getByRole('tab').filter({ hasText: 'a.ts' });
  await expect(tab).toBeVisible({ timeout: 10_000 });

  await tab.click({ button: 'right' });
  await child.getByRole('menuitem', { name: CLOSE }).click();
  const dialog = child.locator('.wm-modal-content');
  await expect(dialog).toContainText(EDITOR_SAVE_CHANGES_TITLE);
  await expect(dialog.getByRole('button', { name: SAVE })).toBeFocused({ timeout: 5_000 });
  await child.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(tab).toBeFocused({ timeout: 5_000 });

  await tab.click({ button: 'right' });
  await expect(child.getByRole('menuitem', { name: CLOSE })).toBeVisible();
  await child.keyboard.press('Escape');
  await expect(child.getByRole('menu')).toHaveCount(0);
  await expect(tab).toBeFocused({ timeout: 5_000 });
});

// popout 子窗:菜单打开期间子窗 body 是 pointer-events:none(Radix 模态菜单),点编辑器正文只关菜单、编辑器拿不到焦点
// (主窗 Chromium 会把焦点给被点处,子窗不会)→ 曾落到子窗 body、键入丢失。期望:回到打开前的焦点(tab),键入不丢;
// 菜单关闭后子窗随即可点(pointer-events 已还原),再点正文即进编辑器。
test('popout 子窗里 tab 右键菜单点编辑器正文关闭 → 焦点不落 body(回到 tab);再点正文可输入', async ({ electronApp, window }) => {
  await window.locator('text=src').first().click();
  await window.locator('text=a.ts').first().click();
  await expect(window.locator('.cm-content')).toContainText('export const a', { timeout: 10_000 });
  await window.getByRole('button', { name: DOCK_POPOUT }).click();
  await expect.poll(() => electronApp.windows().length, { timeout: 10_000 }).toBe(2);
  const child = electronApp.windows().find((w) => w !== window)!;
  await child.waitForLoadState('domcontentloaded');
  await child.bringToFront();
  const tab = child.getByRole('tablist', { name: EDITOR_TABS }).getByRole('tab').filter({ hasText: 'a.ts' });
  await expect(tab).toBeVisible({ timeout: 10_000 });
  const cm = child.locator('.cm-content');
  await expect(cm).toBeVisible();

  await tab.click({ button: 'right' });
  await expect(child.getByRole('menuitem', { name: CLOSE })).toBeVisible();
  await cm.click({ force: true }); // 菜单打开时 body pointer-events:none,跳过可操作性检查
  await expect(child.getByRole('menu')).toHaveCount(0);
  await expect(tab).toBeFocused({ timeout: 5_000 });
  expect(await child.evaluate(() => document.body.style.pointerEvents)).toBe('');
  await cm.click();
  await expect(cm).toBeFocused();
  await child.keyboard.type('Z');
  await expect(cm).toContainText('Z');
});
