// 转到符号(⇧⌘O / Quick Open `@`)与侧栏大纲视图(对照 VSCode)。BDD: src/__tests__/markdown-outline/
// 1. 源码模式:⇧⌘O 过滤 → 预览(光标到标题、焦点留在输入框);Esc 回原位;Enter 跳转并聚焦编辑器;后退回原处
// 2. 编辑 / 预览模式:Enter 跳到标题(标题滚进视口;编辑模式光标在标题里)
// 3. ⌘P 里键入 `@` 进入符号模式;非 Markdown → 「不提供符号信息」
// 4. 大纲视图:展开分区、树、跟随光标、单击跳转
// 5. popout 子窗里 ⇧⌘O:选择器画在子窗,跳转作用于子窗的编辑器
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Locator, Page } from '@playwright/test';
import { test, expect } from './fixtures/with-workspace';
import { DOCK_POPOUT, EDITOR_MODE_EDIT, EDITOR_MODE_PREVIEW, editorModeButton, openWorkspaceFile } from './helpers/editor';
import { openTreeItem } from './helpers/explorer';
import { closeDiscardingUnsaved } from './helpers/close-app';
import { launchContinuo } from './helpers/launch';
import { seedExplorerJson } from './helpers/seed-explorer';

const SECTIONS = 60;
// 每节 4 行:「## Section N」、空行、正文、空行 → 第 N 节标题在第 4N-3 行
const DOC = `# Title\n\n${Array.from({ length: SECTIONS }, (_, i) => `## Section ${i + 1}\n\nParagraph ${i + 1} body text.\n`).join('\n')}`;

const isMac = process.platform === 'darwin';
const BACK = isMac ? 'Control+Minus' : 'Alt+ArrowLeft';
const NO_PROVIDER = /(活动文本编辑器不提供符号信息|The active text editor does not provide symbol information|활성 텍스트 편집기는 기호 정보를 제공하지 않습니다)/;
const SYMBOLS_GROUP = /(符号（\d+）|symbols \(\d+\)|기호\(\d+\))/;
const OUTLINE = /^(大纲|Outline|개요)$/;
const FILTER = /^(筛选|Filter|필터)$/;

const dialog = (page: Page) => page.locator('[role="dialog"]');
const pickerInput = (page: Page) => dialog(page).getByRole('combobox');
const options = (page: Page) => dialog(page).getByRole('option');

/** CodeMirror 光标所在行的文字(.cm-activeLine 随光标,未聚焦时同样标出)。 */
function activeLine(page: Page, root?: Locator): Promise<string | null> {
  const scope = root ?? page.locator('main');
  return scope
    .locator('.cm-activeLine')
    .first()
    .textContent({ timeout: 2_000 })
    .catch(() => null);
}

/** 元素是否在其滚动容器的可视区内。 */
function inViewport(locator: Locator): Promise<boolean> {
  return locator.evaluate((el) => {
    let sc: HTMLElement | null = el.parentElement;
    while (sc && !(sc.scrollHeight > sc.clientHeight && /(auto|scroll)/.test(getComputedStyle(sc).overflowY))) sc = sc.parentElement;
    const box = (sc ?? document.documentElement).getBoundingClientRect();
    const r = el.getBoundingClientRect();
    return r.top >= box.top - 1 && r.bottom <= box.bottom + 1;
  });
}

async function openDoc(window: Page, workspaceRoot: string): Promise<void> {
  writeFileSync(path.join(workspaceRoot, 'README.md'), DOC);
  await openWorkspaceFile(window, ['README.md']);
  await expect(window.locator('.cm-content')).toContainText('Section 1', { timeout: 10_000 });
}

test('源码模式:⇧⌘O 过滤 → 预览、焦点留在输入框;Esc 回原位;Enter 跳转聚焦编辑器;后退回原处', async ({ window, workspaceRoot }) => {
  await openDoc(window, workspaceRoot);
  await window.locator('.cm-content').click();
  await window.keyboard.press('ControlOrMeta+Home');
  await expect.poll(() => activeLine(window)).toBe('# Title');

  await window.keyboard.press('ControlOrMeta+Shift+O');
  await expect(pickerInput(window)).toHaveValue('@');
  // 列表虚拟化:按首行分组标签核对总数
  await expect(options(window).first()).toContainText(SYMBOLS_GROUP);
  await expect(options(window).first()).toContainText(String(SECTIONS + 1));

  await window.keyboard.type('Section 40');
  await expect(options(window).first()).toContainText('## Section 40');
  await expect.poll(() => activeLine(window)).toBe('## Section 40'); // 预览
  expect(await pickerInput(window).evaluate((el) => el === document.activeElement)).toBe(true);
  await window.keyboard.press('Escape');
  await expect(dialog(window)).toHaveCount(0);
  await expect.poll(() => activeLine(window)).toBe('# Title'); // 恢复

  await window.keyboard.press('ControlOrMeta+Shift+O');
  await window.keyboard.type('Section 50');
  await expect(options(window).first()).toContainText('## Section 50');
  await window.keyboard.press('Enter');
  await expect(dialog(window)).toHaveCount(0);
  await expect.poll(() => activeLine(window)).toBe('## Section 50');
  await expect.poll(() => window.evaluate(() => document.activeElement?.closest('.cm-editor') != null)).toBe(true);
  await window.keyboard.press(BACK);
  await expect.poll(() => activeLine(window)).toBe('# Title');
});

test('编辑 / 预览模式:⇧⌘O → Enter 跳到标题(滚进视口;编辑模式光标在标题里)', async ({ window, workspaceRoot }) => {
  await openDoc(window, workspaceRoot);
  for (const mode of [EDITOR_MODE_EDIT, EDITOR_MODE_PREVIEW]) {
    await editorModeButton(window, mode).click();
    await expect(window.locator('.ProseMirror h2').first()).toBeVisible({ timeout: 10_000 });
    const target = window.locator('.ProseMirror h2', { hasText: /^Section 45$/ });
    expect(await inViewport(target)).toBe(false);
    await window.keyboard.press('ControlOrMeta+Shift+O');
    await expect(pickerInput(window)).toHaveValue('@');
    await window.keyboard.type('Section 45');
    await expect(options(window).first()).toContainText('## Section 45');
    await expect.poll(() => inViewport(target)).toBe(true); // 移动选中项即预览
    await window.keyboard.press('Enter');
    await expect(dialog(window)).toHaveCount(0);
    await expect.poll(() => inViewport(target)).toBe(true);
    if (mode === EDITOR_MODE_EDIT) {
      await expect
        .poll(() => window.evaluate(() => document.getSelection()?.anchorNode?.parentElement?.closest('h2')?.textContent ?? null))
        .toBe('Section 45');
    }
    // 回到文首,下一种模式从顶部开始
    await window.evaluate(() => {
      for (const el of Array.from(document.querySelectorAll<HTMLElement>('main *'))) if (el.scrollTop > 0) el.scrollTop = 0;
    });
  }
});

test('⌘P 里键入 `@` → 符号模式;非 Markdown → 不提供符号信息', async ({ window, workspaceRoot }) => {
  await openDoc(window, workspaceRoot);
  await window.locator('.cm-content').click();
  await window.keyboard.press('ControlOrMeta+p');
  await expect(pickerInput(window)).toBeVisible();
  await window.keyboard.type('@sect 7');
  await expect(options(window).first()).toContainText('## Section 7');
  await window.keyboard.press('Escape');

  await openWorkspaceFile(window, ['src', 'a.ts']);
  await window.locator('.cm-content').click();
  await window.keyboard.press('ControlOrMeta+Shift+O');
  await expect(dialog(window).getByRole('status')).toHaveText(NO_PROVIDER);
  await window.keyboard.press('Escape');
});

test('大纲视图:展开分区 → 标题树;单击跳转;光标移动 → 活动行跟随', async ({ window, workspaceRoot }) => {
  await openDoc(window, workspaceRoot);
  const header = window.getByRole('button', { name: OUTLINE });
  await expect(header).toHaveAttribute('aria-expanded', 'false');
  await header.click();
  const tree = window.getByRole('tree', { name: OUTLINE });
  await expect(tree).toBeVisible();
  const item = (n: number) => tree.getByRole('treeitem', { name: `Section ${n}`, exact: true });
  await expect(tree.getByRole('treeitem', { name: 'Title', exact: true })).toHaveAttribute('aria-level', '1');
  await expect(item(1)).toHaveAttribute('aria-level', '2');

  await item(3).click();
  await expect.poll(() => activeLine(window)).toBe('## Section 3');
  await expect(item(3)).toHaveAttribute('aria-selected', 'true');

  // 编辑器里移动光标(键盘)→ 活动行跟随当前节
  await window.locator('.cm-activeLine').click(); // 聚焦编辑器,光标仍在 Section 3 标题行
  for (let i = 0; i < 8; i++) await window.keyboard.press('ArrowDown');
  await expect(item(5)).toHaveAttribute('aria-selected', 'true');

  // 预览模式:滚动 → 当前节跟随视口顶部
  await editorModeButton(window, EDITOR_MODE_PREVIEW).click();
  await expect(window.locator('.ProseMirror h2').first()).toBeVisible({ timeout: 10_000 });
  // 树虚拟化(分区不高):过滤出该节再点
  const filter = window.getByRole('textbox', { name: FILTER });
  await filter.fill('Section 30');
  await item(30).click();
  await expect.poll(() => inViewport(window.locator('.ProseMirror h2', { hasText: /^Section 30$/ }))).toBe(true);
  await filter.fill('');
  await window.locator('.ProseMirror h2', { hasText: /^Section 20$/ }).evaluate((el) => el.scrollIntoView({ block: 'start' }));
  await expect(item(20)).toHaveAttribute('aria-selected', 'true');
});

test('popout 子窗里 ⇧⌘O:选择器画在子窗,Enter 跳转子窗的编辑器', async () => {
  test.setTimeout(120_000);
  const ud = mkdtempSync(path.join(tmpdir(), 'ud-'));
  const ws = mkdtempSync(path.join(tmpdir(), 'ws-'));
  writeFileSync(path.join(ws, 'main-file.ts'), 'export const main = 1;\n');
  writeFileSync(path.join(ws, 'notes.md'), DOC);
  seedExplorerJson(ud, { root: ws });
  const app = await launchContinuo(ud);
  try {
    const win = await app.firstWindow();
    await win.waitForLoadState('domcontentloaded');
    const roots = (page: Page) => page.locator('[data-editor-panel-root]');
    await openTreeItem(win, /^main-file\.ts$/);
    await expect(roots(win).first().locator('.cm-content')).toContainText('export const main', { timeout: 10_000 });
    await roots(win).first().locator('.cm-content').click();
    await win.keyboard.press('ControlOrMeta+Backslash');
    await expect(roots(win)).toHaveCount(2, { timeout: 10_000 });
    await openTreeItem(win, /^notes\.md$/);
    await expect(roots(win).nth(1).locator('.cm-content')).toContainText('Section 1', { timeout: 10_000 });
    await roots(win).nth(1).locator('xpath=ancestor::*[contains(@class,"dv-groupview")]').getByRole('button', { name: DOCK_POPOUT }).click();
    await expect.poll(() => app.windows().length, { timeout: 15_000 }).toBeGreaterThan(1);
    const child = app.windows().find((w) => w !== win)!;
    await child.waitForLoadState('domcontentloaded');
    for (const page of [win, child]) {
      const cdp = await page.context().newCDPSession(page);
      await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: false });
    }
    await app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().includes('popout=1'))?.focus();
    });
    const childCm = roots(child).locator('.cm-content');
    await expect(childCm).toContainText('Section 1', { timeout: 10_000 });
    await childCm.click();

    await child.keyboard.press('ControlOrMeta+Shift+O');
    await expect(dialog(child)).toBeVisible({ timeout: 10_000 });
    await expect(dialog(win)).toHaveCount(0);
    await expect(pickerInput(child)).toHaveValue('@');
    await child.keyboard.type('Section 33');
    await expect(options(child).first()).toContainText('## Section 33');
    await child.keyboard.press('Enter');
    await expect(dialog(child)).toHaveCount(0);
    await expect.poll(() => activeLine(child, roots(child))).toBe('## Section 33');
  } finally {
    await closeDiscardingUnsaved(app).catch(() => undefined);
    rmSync(ud, { recursive: true, force: true });
    rmSync(ws, { recursive: true, force: true });
  }
});
