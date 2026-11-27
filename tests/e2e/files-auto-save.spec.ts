// 自动保存可配置(BDD: src/__tests__/files-auto-save/,对照 VSCode files.autoSave / files.autoSaveDelay):
// 1. 默认行为不变:Markdown 停手 2 秒自动写盘,代码不自动保存
// 2. Markdown 覆盖关 + files.autoSave = off → .md 不写盘
// 3. afterDelay → .ts 停手后自动写盘
// 4. onFocusChange → 切到另一 tab / 焦点进终端时保存
// 5. onWindowChange → 切 tab / 进终端不保存,窗口失焦时保存;popout 子窗的编辑器在子窗失焦时保存
// 6. 文件 → 自动保存(勾选项)/ 命令面板「切换自动保存」
// 7. 打开自动保存时立即保存已有的脏文件(命令切换 / 设置页修改;多窗口各自保存),不等延迟 / 失焦
// 判断保存完成:磁盘出现内容且未保存标记消失(只看磁盘可能早于 markSaved,见 cdb8df29)。
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { ElectronApplication, Page } from '@playwright/test';
import { test, expect } from './fixtures/with-workspace';
import { waitForAppReady, waitForTestHooks } from './helpers/app-ready';
import {
  DOCK_POPOUT,
  EDITOR_UNSAVED_CHANGES_SELECTOR,
  editorTab,
  TERMINAL_INPUT,
  TERMINAL_PANEL_TAB,
} from './helpers/editor';
import { commandPaletteInput, openCommandPalette } from './helpers/palette';
import { EDITOR_TAB, openSettingsTab } from './helpers/settings';
import type { AppMenuE2eHook, MenuSnapshotItem } from '../../electron/main/app-menu-e2e';

const TOGGLE_AUTO_SAVE = 'workbench.action.toggleAutoSave';

async function setSetting(window: Page, id: string, value: string | number | boolean): Promise<void> {
  await window.evaluate(({ id, value }) => globalThis.__continuoTest!.setSettingValue(id, value), { id, value });
}

const getSetting = (window: Page, id: string): Promise<unknown> =>
  window.evaluate((id) => globalThis.__continuoTest!.getSettingValue(id), id);

const disk = (root: string, rel: string): Promise<string> => readFile(path.join(root, rel), 'utf8');

/** 打开 src 下的文件(资源管理器单击;预览已关,每个文件各占一个 tab)。 */
async function openSrcFile(window: Page, name: string): Promise<void> {
  await window.locator(`text=${name}`).first().click();
  await expect(window.locator('header').first()).toContainText(name, { timeout: 10_000 });
}

/** 在活动代码编辑器末尾输入(真实键盘,焦点在编辑器里)。 */
async function typeInEditor(window: Page, text: string): Promise<void> {
  const cm = window.locator('.cm-content').first();
  await expect(cm).toBeVisible({ timeout: 10_000 });
  await cm.click();
  await window.keyboard.press('ControlOrMeta+End');
  await window.keyboard.type(text);
}

async function expectSaved(window: Page, root: string, rel: string, text: string): Promise<void> {
  await expect(async () => expect(await disk(root, rel)).toContain(text)).toPass({ timeout: 8_000 });
  await expect(editorTab(window, path.basename(rel)).locator(EDITOR_UNSAVED_CHANGES_SELECTOR)).toHaveCount(0, {
    timeout: 5_000,
  });
}

/** 打开终端(切换终端命令:在编辑器旁边 / 下方显示终端面板),等终端输入框就绪。 */
async function openTerminal(window: Page): Promise<void> {
  await window.evaluate(() => globalThis.__continuoTest!.executeCommand('workbench.action.terminal.toggleTerminal'));
  await expect(window.getByRole('textbox', { name: TERMINAL_INPUT }).first()).toBeAttached({ timeout: 15_000 });
}

/** 焦点进终端:点终端的 dock 页签(与编辑器同组时切过去),再聚焦其输入框。 */
async function focusTerminal(window: Page): Promise<void> {
  await window.getByRole('tab', { name: TERMINAL_PANEL_TAB }).first().click();
  const term = window.getByRole('textbox', { name: TERMINAL_INPUT }).first();
  await expect(term).toBeAttached({ timeout: 15_000 });
  await term.focus();
  await expect(term).toBeFocused();
}

/** 关掉 Playwright 的焦点模拟(否则页面总以为自己有焦点、收不到真实的窗口失焦)。 */
async function realFocus(page: Page): Promise<void> {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: false });
}

/** 记录 page 的 window blur 次数(验证走的是真实窗口失焦)。 */
async function countBlurs(page: Page): Promise<() => Promise<number>> {
  await page.evaluate(() => {
    const g = globalThis as { __e2eBlurs?: number };
    g.__e2eBlurs = 0;
    globalThis.addEventListener('blur', () => {
      g.__e2eBlurs = (g.__e2eBlurs ?? 0) + 1;
    });
  });
  return () => page.evaluate(() => (globalThis as { __e2eBlurs?: number }).__e2eBlurs ?? 0);
}

const focusWindow = (app: ElectronApplication, popout: boolean): Promise<void> =>
  app.evaluate(({ BrowserWindow }, popout) => {
    BrowserWindow.getAllWindows()
      .find((w) => w.webContents.getURL().includes('popout=1') === popout)
      ?.focus();
  }, popout);

/**
 * 让 page 所在窗口失焦:realSwitch 做真实的窗口切换(关掉焦点模拟后);应用不在前台、系统不给焦点时(并发跑 / 用户正在用
 * 别的应用)3 秒内收不到 blur → 退回在该窗口派发同一个 window blur 事件(编辑器监听的就是它)。
 */
async function blurWindowOf(page: Page, realSwitch: () => Promise<void>): Promise<void> {
  await realFocus(page);
  const blurs = await countBlurs(page);
  await realSwitch();
  try {
    await expect.poll(blurs, { timeout: 3_000 }).toBeGreaterThan(0);
  } catch {
    await page.evaluate(() => globalThis.dispatchEvent(new FocusEvent('blur')));
  }
}

/** 主窗失焦:聚焦主窗后另开一个小窗口并聚焦它。 */
async function blurMainWindow(app: ElectronApplication, window: Page): Promise<void> {
  await blurWindowOf(window, async () => {
    await focusWindow(app, false);
    await window.waitForTimeout(300);
    await app.evaluate(({ BrowserWindow }) => {
      const other = new BrowserWindow({ width: 240, height: 120, show: true });
      other.focus();
      setTimeout(() => other.destroy(), 2_000);
    });
  });
}

const menuSnapshot = (app: ElectronApplication): Promise<MenuSnapshotItem[]> =>
  app.evaluate(() => (globalThis as { __continuoAppMenu?: AppMenuE2eHook }).__continuoAppMenu!.snapshot());

function findPath(items: readonly MenuSnapshotItem[], id: string, prefix: number[] = []): number[] | null {
  for (const [i, m] of items.entries()) {
    if (m.id === id) return [...prefix, i];
    const sub = m.submenu ? findPath(m.submenu, id, [...prefix, i]) : null;
    if (sub) return sub;
  }
  return null;
}

function itemAt(items: readonly MenuSnapshotItem[], p: readonly number[]): MenuSnapshotItem {
  let list = items;
  let item: MenuSnapshotItem | undefined;
  for (const i of p) {
    item = list[i];
    list = item?.submenu ?? [];
  }
  return item!;
}

async function autoSaveMenuChecked(app: ElectronApplication): Promise<boolean | undefined> {
  const items = await menuSnapshot(app);
  return itemAt(items, findPath(items, TOGGLE_AUTO_SAVE)!).checked;
}

test.beforeEach(async ({ window }) => {
  await waitForTestHooks(window);
  await setSetting(window, 'workbench.editor.enablePreview', false);
  await window.locator('text=src').first().click();
});

test('默认:Markdown 停手 2 秒自动写盘,代码不自动保存', async ({ window, workspaceRoot }) => {
  expect((await getSetting(window, 'files.autoSave')) ?? 'off').toBe('off');
  await window.locator('text=README.md').first().click();
  const mdId = await window.evaluate(() => globalThis.__continuoTest!.getEditorActiveTabId());
  await window.evaluate((id) => globalThis.__continuoTest!.setEditorContent(id as string, '# md auto\n'), mdId);
  await expectSaved(window, workspaceRoot, 'README.md', '# md auto');

  await openSrcFile(window, 'a.ts');
  await typeInEditor(window, ' // typed');
  await window.waitForTimeout(3_000); // > Markdown 的 2 秒 / files.autoSaveDelay 的 1 秒
  expect(await disk(workspaceRoot, 'src/a.ts')).toBe('export const a = 1;\n');
  await expect(editorTab(window, 'a.ts').locator(EDITOR_UNSAVED_CHANGES_SELECTOR)).toHaveCount(1);
});

test('Markdown 覆盖关 + files.autoSave = off:.md 不写盘', async ({ window, workspaceRoot }) => {
  await setSetting(window, 'autoSave.markdown.enabled', false);
  await setSetting(window, 'autoSave.delayMs', 500);
  await window.locator('text=README.md').first().click();
  const mdId = await window.evaluate(() => globalThis.__continuoTest!.getEditorActiveTabId());
  await window.evaluate((id) => globalThis.__continuoTest!.setEditorContent(id as string, '# not saved\n'), mdId);
  await window.waitForTimeout(2_500);
  expect(await disk(workspaceRoot, 'README.md')).toBe('# Test Workspace\n');
});

test('afterDelay:.ts 停手 files.autoSaveDelay 后自动写盘', async ({ window, workspaceRoot }) => {
  await setSetting(window, 'files.autoSave', 'afterDelay');
  await setSetting(window, 'files.autoSaveDelay', 300);
  await openSrcFile(window, 'a.ts');
  await typeInEditor(window, ' // after delay');
  await expectSaved(window, workspaceRoot, 'src/a.ts', '// after delay');
});

test('onFocusChange:不按延迟保存;切到另一 tab、焦点进终端时保存', async ({ window, workspaceRoot }) => {
  await setSetting(window, 'files.autoSave', 'onFocusChange');
  await openTerminal(window);
  await openSrcFile(window, 'a.ts');
  await openSrcFile(window, 'b.ts');
  await editorTab(window, 'a.ts').click();
  await typeInEditor(window, ' // focus a');
  await window.waitForTimeout(1_500);
  expect(await disk(workspaceRoot, 'src/a.ts')).toBe('export const a = 1;\n');

  // 切到同组另一个 tab → 保存被切走的 a.ts
  await editorTab(window, 'b.ts').click();
  await expectSaved(window, workspaceRoot, 'src/a.ts', '// focus a');

  // 焦点进终端 → 保存 b.ts
  await typeInEditor(window, ' // focus b');
  await window.waitForTimeout(1_000);
  expect(await disk(workspaceRoot, 'src/b.ts')).toBe('export const b = 2;\n');
  await focusTerminal(window);
  await expectSaved(window, workspaceRoot, 'src/b.ts', '// focus b');
});

test('onWindowChange:切 tab / 进终端不保存,窗口失焦时保存(含后台 tab)', async ({
  electronApp,
  window,
  workspaceRoot,
}) => {
  await setSetting(window, 'files.autoSave', 'onWindowChange');
  await openTerminal(window);
  await openSrcFile(window, 'a.ts');
  await openSrcFile(window, 'b.ts');
  await editorTab(window, 'a.ts').click();
  await typeInEditor(window, ' // window a');
  await editorTab(window, 'b.ts').click();
  await typeInEditor(window, ' // window b');
  await focusTerminal(window);
  await window.waitForTimeout(1_500);
  expect(await disk(workspaceRoot, 'src/a.ts')).toBe('export const a = 1;\n');
  expect(await disk(workspaceRoot, 'src/b.ts')).toBe('export const b = 2;\n');

  await blurMainWindow(electronApp, window);
  await expectSaved(window, workspaceRoot, 'src/b.ts', '// window b');
  await expectSaved(window, workspaceRoot, 'src/a.ts', '// window a');
});

test('onWindowChange:popout 子窗里的编辑器在子窗失焦时保存', async ({ electronApp, window, workspaceRoot }) => {
  test.setTimeout(120_000);
  await setSetting(window, 'files.autoSave', 'onWindowChange');
  const editors = (page: Page) => page.locator('[data-editor-panel-root]');
  await openSrcFile(window, 'a.ts');
  await editors(window).first().locator('.cm-content').click();
  await window.keyboard.press('ControlOrMeta+Backslash');
  await expect(editors(window)).toHaveCount(2, { timeout: 10_000 });
  await openSrcFile(window, 'b.ts');
  await expect(editors(window).nth(1).locator('.cm-content')).toContainText('export const b', { timeout: 10_000 });
  await editors(window)
    .nth(1)
    .locator('xpath=ancestor::*[contains(@class,"dv-groupview")]')
    .getByRole('button', { name: DOCK_POPOUT })
    .click();
  await expect.poll(() => electronApp.windows().length, { timeout: 15_000 }).toBeGreaterThan(1);
  const child = electronApp.windows().find((w) => w !== window)!;
  await child.waitForLoadState('domcontentloaded');
  const childCm = editors(child).locator('.cm-content');
  await expect(childCm).toContainText('export const b', { timeout: 10_000 });

  // 子窗编辑器里的 b.ts 变脏(经 store 改内容,不牵动窗口焦点);onWindowChange 不按延迟保存
  const bId = await window.evaluate(() => globalThis.__continuoTest!.getEditorActiveTabId());
  expect(bId).toMatch(/b\.ts$/);
  await window.evaluate(
    (id) => globalThis.__continuoTest!.setEditorContent(id!, 'export const b = 2;\n // popout b\n'),
    bId,
  );
  await expect(child.locator(EDITOR_UNSAVED_CHANGES_SELECTOR)).toHaveCount(1);
  await child.waitForTimeout(1_000);
  expect(await disk(workspaceRoot, 'src/b.ts')).toBe('export const b = 2;\n');

  // 子窗失焦(聚焦子窗后切回主窗)→ 子窗编辑器的 b.ts 保存
  for (const page of [window, child]) await realFocus(page);
  await blurWindowOf(child, async () => {
    await focusWindow(electronApp, true);
    await child.waitForTimeout(300);
    await focusWindow(electronApp, false);
  });
  await expect(async () => expect(await disk(workspaceRoot, 'src/b.ts')).toContain('// popout b')).toPass({ timeout: 8_000 });
  await expect(child.locator(EDITOR_UNSAVED_CHANGES_SELECTOR)).toHaveCount(0, { timeout: 5_000 });
});

test('文件 → 自动保存 勾选项与命令面板「切换自动保存」:off ↔ afterDelay,勾选跟随', async ({
  electronApp,
  window,
  workspaceRoot,
}) => {
  await expect.poll(() => autoSaveMenuChecked(electronApp)).toBe(false);

  // 点菜单项(与真实点击同一路径:sendMenuCommand → renderer 命令)
  const items = await menuSnapshot(electronApp);
  const p = findPath(items, TOGGLE_AUTO_SAVE)!;
  const winId = await electronApp.evaluate(
    ({ BrowserWindow }) => BrowserWindow.getAllWindows().find((w) => !w.webContents.getURL().includes('popout=1'))!.id,
  );
  await electronApp.evaluate(
    (_e, { p, winId }) => (globalThis as { __continuoAppMenu?: AppMenuE2eHook }).__continuoAppMenu!.click(p, winId),
    { p, winId },
  );
  await expect.poll(() => getSetting(window, 'files.autoSave')).toBe('afterDelay');
  await expect.poll(() => autoSaveMenuChecked(electronApp)).toBe(true);

  // 已开启:代码文件按默认 1 秒延迟自动写盘
  await openSrcFile(window, 'a.ts');
  await typeInEditor(window, ' // via menu');
  await expectSaved(window, workspaceRoot, 'src/a.ts', '// via menu');

  // 命令面板切回 off
  await openCommandPalette(window);
  await commandPaletteInput(window).fill('Toggle Auto Save');
  await window.keyboard.press('Enter');
  await expect.poll(() => getSetting(window, 'files.autoSave')).toBe('off');
  await expect.poll(() => autoSaveMenuChecked(electronApp)).toBe(false);
});

// 打开自动保存(VSCode onDidChangeAutoSaveConfiguration → saveAllDirtyAutoSaveables):已有的脏文件立即保存。
// files.autoSaveDelay 设成 60 秒:afterDelay 的延迟保存远在 expectSaved 的等待之外,只有「打开时立即保存」能写盘。
async function dirtyBoth(window: Page, root: string): Promise<void> {
  await setSetting(window, 'files.autoSaveDelay', 60_000);
  await openSrcFile(window, 'a.ts');
  await openSrcFile(window, 'b.ts');
  await editorTab(window, 'a.ts').click();
  await typeInEditor(window, ' // dirty a');
  await editorTab(window, 'b.ts').click();
  await typeInEditor(window, ' // dirty b');
  await window.waitForTimeout(1_500);
  expect(await disk(root, 'src/a.ts')).toBe('export const a = 1;\n');
  expect(await disk(root, 'src/b.ts')).toBe('export const b = 2;\n');
}

test('打开自动保存(命令切换 off → afterDelay):活动与后台的脏文件立即写盘,不等延迟', async ({ window, workspaceRoot }) => {
  await dirtyBoth(window, workspaceRoot);
  await window.evaluate((id) => globalThis.__continuoTest!.executeCommand(id), TOGGLE_AUTO_SAVE);
  await expect.poll(() => getSetting(window, 'files.autoSave')).toBe('afterDelay');
  await expectSaved(window, workspaceRoot, 'src/b.ts', '// dirty b');
  await expectSaved(window, workspaceRoot, 'src/a.ts', '// dirty a');
});

test('打开自动保存(设置页改为「窗口改变时」):脏文件立即写盘,不等窗口失焦', async ({ window, workspaceRoot }) => {
  await dirtyBoth(window, workspaceRoot);
  await openSettingsTab(window, EDITOR_TAB);
  const onWindowChange = window
    .getByRole('radio', { name: /^(窗口改变时|On window change|창 변경 시)$/ })
    .first();
  await onWindowChange.scrollIntoViewIfNeeded();
  await onWindowChange.click();
  await expect.poll(() => getSetting(window, 'files.autoSave')).toBe('onWindowChange');
  await expect(async () => expect(await disk(workspaceRoot, 'src/a.ts')).toContain('// dirty a')).toPass({ timeout: 8_000 });
  await expect(async () => expect(await disk(workspaceRoot, 'src/b.ts')).toContain('// dirty b')).toPass({ timeout: 8_000 });
});

test('打开自动保存:多窗口各自保存自己的脏文件', async ({ electronApp, window, workspaceRoot }) => {
  test.setTimeout(90_000);
  await setSetting(window, 'files.autoSaveDelay', 60_000);
  const otherRoot = mkdtempSync(path.join(tmpdir(), 'autosave-multi-ws-'));
  mkdirSync(path.join(otherRoot, 'src'));
  writeFileSync(path.join(otherRoot, 'src', 'c.ts'), 'export const c = 3;\n');
  try {
    // 新窗口开另一个文件夹(e2e 下无应用菜单,走 macOS open-file 同款入口,见 fresh-window-reload-keeps-tabs)
    const newWindow = electronApp.waitForEvent('window');
    await electronApp.evaluate(({ app }, dir) => {
      app.emit('open-file', { preventDefault: () => {} }, dir);
    }, otherRoot);
    const other = await newWindow;
    await other.waitForLoadState('domcontentloaded');
    await waitForAppReady(other);
    await other.evaluate(() => globalThis.__continuoTest!.setSettingValue('workbench.editor.enablePreview', false));
    await other.locator('text=src').first().click();
    await openSrcFile(other, 'c.ts');
    await typeInEditor(other, ' // dirty c');

    await openSrcFile(window, 'a.ts');
    await typeInEditor(window, ' // dirty a');
    await window.waitForTimeout(1_500);
    expect(await disk(workspaceRoot, 'src/a.ts')).toBe('export const a = 1;\n');
    expect(await disk(otherRoot, 'src/c.ts')).toBe('export const c = 3;\n');

    // 在主窗打开自动保存:设置跨窗同步,两个窗口各自立即保存
    await window.evaluate((id) => globalThis.__continuoTest!.executeCommand(id), TOGGLE_AUTO_SAVE);
    await expectSaved(window, workspaceRoot, 'src/a.ts', '// dirty a');
    await expect(async () => expect(await disk(otherRoot, 'src/c.ts')).toContain('// dirty c')).toPass({ timeout: 8_000 });
    await expect(editorTab(other, 'c.ts').locator(EDITOR_UNSAVED_CHANGES_SELECTOR)).toHaveCount(0, { timeout: 5_000 });
  } finally {
    rmSync(otherRoot, { recursive: true, force: true });
  }
});
