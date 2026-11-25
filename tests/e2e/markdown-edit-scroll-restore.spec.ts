// Markdown 编辑模式的滚动位置:切 tab 再切回 / 重启后保持保存时的视口,不被聚焦拉回光标处
// (VSCode:恢复编辑器视图状态 = 恢复视口,聚焦不滚到光标)。BDD: src/__tests__/focus-keeps-scroll/
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { EDITOR_MODE_EDIT, EDITOR_MODE_PREVIEW, editorModeButton, editorTab, openWorkspaceFile } from './helpers/editor';
import { closeDiscardingUnsaved } from './helpers/close-app';
import { launchContinuo } from './helpers/launch';
import { seedExplorerJson } from './helpers/seed-explorer';

const README = Array.from({ length: 120 }, (_, i) => `## Section ${i + 1}\n\nParagraph ${i + 1} body text.\n`).join('\n');
const SCROLLER = '.milkdown >> xpath=ancestor::div[contains(@class,"overflow-auto")][1]';
const apps: Awaited<ReturnType<typeof launchContinuo>>[] = [];

async function launch(ud: string): Promise<Page> {
  const app = await launchContinuo(ud);
  apps.push(app);
  const win = await app.firstWindow();
  await win.waitForLoadState('domcontentloaded');
  return win;
}

const scrollTop = (win: Page) => win.locator(SCROLLER).evaluate((el) => el.scrollTop);

/** 打开 README.md(编辑模式),光标放到开头,把正文滚到中段;返回滚动值。 */
async function openAndScroll(win: Page): Promise<number> {
  await openWorkspaceFile(win, ['README.md']);
  await editorModeButton(win, EDITOR_MODE_EDIT).click();
  await expect(editorModeButton(win, EDITOR_MODE_EDIT)).toHaveAttribute('aria-checked', 'true');
  const pm = win.locator('.milkdown .ProseMirror');
  await expect(pm).toBeVisible({ timeout: 10_000 });
  await pm.getByText('Section 1', { exact: true }).click();
  await win.locator(SCROLLER).evaluate((el) => {
    el.scrollTop = 1500;
  });
  await expect.poll(() => scrollTop(win)).toBe(1500);
  await win.waitForTimeout(300); // 滚动事件落入缓存
  return 1500;
}

test.afterEach(async () => {
  for (const app of apps.splice(0)) await closeDiscardingUnsaved(app).catch(() => undefined);
});

test('编辑模式:滚到中段 → 切到别的编辑器 tab 再切回 → 滚动位置保持', async () => {
  const ud = mkdtempSync(path.join(tmpdir(), 'ui42m-ud-'));
  const ws = mkdtempSync(path.join(tmpdir(), 'ui42m-ws-'));
  try {
    writeFileSync(path.join(ws, 'README.md'), README);
    writeFileSync(path.join(ws, 'a.ts'), 'export const a = 1;\n');
    seedExplorerJson(ud, { root: ws });
    const win = await launch(ud);
    const top = await openAndScroll(win);
    await openWorkspaceFile(win, ['a.ts']);
    await expect(win.locator('.cm-content')).toBeVisible();
    await editorTab(win, 'README.md').click();
    await expect(win.locator('.milkdown .ProseMirror')).toBeFocused();
    await win.waitForTimeout(500);
    expect(await scrollTop(win)).toBe(top);
  } finally {
    rmSync(ws, { recursive: true, force: true });
    rmSync(ud, { recursive: true, force: true });
  }
});

test('预览模式:滚到中段 → 切到别的编辑器 tab 再切回 → 滚动位置保持', async () => {
  const ud = mkdtempSync(path.join(tmpdir(), 'ui42m-ud-'));
  const ws = mkdtempSync(path.join(tmpdir(), 'ui42m-ws-'));
  try {
    writeFileSync(path.join(ws, 'README.md'), README);
    writeFileSync(path.join(ws, 'a.ts'), 'export const a = 1;\n');
    seedExplorerJson(ud, { root: ws });
    const win = await launch(ud);
    await openWorkspaceFile(win, ['README.md']);
    await editorModeButton(win, EDITOR_MODE_PREVIEW).click();
    await expect(editorModeButton(win, EDITOR_MODE_PREVIEW)).toHaveAttribute('aria-checked', 'true');
    await expect(win.locator('.milkdown .ProseMirror')).toBeVisible({ timeout: 10_000 });
    await win.locator(SCROLLER).evaluate((el) => {
      el.scrollTop = 1500;
    });
    await expect.poll(() => scrollTop(win)).toBe(1500);
    await win.waitForTimeout(300);
    await openWorkspaceFile(win, ['a.ts']);
    await expect(win.locator('.cm-content')).toBeVisible();
    await editorTab(win, 'README.md').click();
    await expect(win.locator('.milkdown .ProseMirror')).toBeVisible({ timeout: 10_000 });
    await win.waitForTimeout(500);
    expect(await scrollTop(win)).toBe(1500);
  } finally {
    rmSync(ws, { recursive: true, force: true });
    rmSync(ud, { recursive: true, force: true });
  }
});

test('编辑模式:滚到中段后重启 → 恢复滚动位置且焦点在编辑区,缓存不被改写', async () => {
  test.setTimeout(90_000);
  const ud = mkdtempSync(path.join(tmpdir(), 'ui42m-ud-'));
  const ws = mkdtempSync(path.join(tmpdir(), 'ui42m-ws-'));
  try {
    writeFileSync(path.join(ws, 'README.md'), README);
    seedExplorerJson(ud, { root: ws });
    const win1 = await launch(ud);
    const top = await openAndScroll(win1);
    await closeDiscardingUnsaved(apps.pop()!);

    const win2 = await launch(ud);
    await expect(win2.locator('.milkdown .ProseMirror')).toBeFocused({ timeout: 15_000 });
    await win2.waitForTimeout(800);
    expect(await scrollTop(win2)).toBe(top);
    await closeDiscardingUnsaved(apps.pop()!);

    // 再重启一次:上一轮恢复后未被聚焦改写的值仍是 top
    const win3 = await launch(ud);
    await expect(win3.locator('.milkdown .ProseMirror')).toBeFocused({ timeout: 15_000 });
    await win3.waitForTimeout(800);
    expect(await scrollTop(win3)).toBe(top);
  } finally {
    rmSync(ws, { recursive: true, force: true });
    rmSync(ud, { recursive: true, force: true });
  }
});
