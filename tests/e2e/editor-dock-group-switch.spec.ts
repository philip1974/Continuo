// 编辑器面板与终端面板在同一 dock 组:切到终端 tab 再点回编辑器 tab → 编辑器视口保持、焦点进编辑区
// (VSCode:同组切换编辑器 / 面板保持各自视口,点 tab 后可直接继续输入)。BDD: src/__tests__/dock-panel-switch-keep-view/
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { EDITOR_MODE_EDIT, EDITOR_MODE_SOURCE, TERMINAL_INPUT, editorModeButton, openWorkspaceFile } from './helpers/editor';
import { DOCK_OPEN_VIEW } from './helpers/explorer';
import { TERMINAL_TAB } from './helpers/settings';
import { closeDiscardingUnsaved } from './helpers/close-app';
import { launchContinuo } from './helpers/launch';
import { seedExplorerJson } from './helpers/seed-explorer';

const CODE = Array.from({ length: 400 }, (_, i) => `export const v${i + 1} = ${i + 1};`).join('\n') + '\n';
const README = Array.from({ length: 120 }, (_, i) => `## Section ${i + 1}\n\nParagraph ${i + 1} body text.\n`).join('\n');
const MILKDOWN_SCROLLER = '.milkdown >> xpath=ancestor::div[contains(@class,"overflow-auto")][1]';
const EDITOR_DOCK_TITLE = /^(编辑器|Editor|편집기)$/;
const apps: Awaited<ReturnType<typeof launchContinuo>>[] = [];

test.afterEach(async () => {
  for (const app of apps.splice(0)) await closeDiscardingUnsaved(app).catch(() => undefined);
});

/** 编辑器面板的 dock tab(dock 的 SharedTab 带 data-panel-id;编辑器自己的文件 tab 行没有)。 */
const editorDockTab = (win: Page): Locator =>
  win.locator('[role=tab][data-panel-id]').filter({ hasText: EDITOR_DOCK_TITLE }).first();

/** 在编辑器所在组里经「更多操作」加一个终端(加入同组并成为活动面板,编辑器内容被 dockview 卸下)。 */
async function addTerminalToEditorGroup(win: Page): Promise<void> {
  const group = win.locator('.dv-groupview').filter({ has: editorDockTab(win) }).first();
  await group.getByRole('button', { name: DOCK_OPEN_VIEW }).click();
  await win.getByRole('menu').last().getByRole('menuitem', { name: TERMINAL_TAB }).click();
  await expect(win.getByRole('textbox', { name: TERMINAL_INPUT })).toBeFocused({ timeout: 15_000 });
  // 终端与编辑器同组(同一 tab 条)
  await expect(group.locator('[role=tab][data-panel-id]')).toHaveCount(2);
  await expect(editorDockTab(win)).toHaveAttribute('aria-selected', 'false');
}

async function withWorkspace(run: (win: Page) => Promise<void>): Promise<void> {
  const ud = mkdtempSync(path.join(tmpdir(), 'ui43g-ud-'));
  const ws = mkdtempSync(path.join(tmpdir(), 'ui43g-ws-'));
  try {
    writeFileSync(path.join(ws, 'a.ts'), CODE);
    writeFileSync(path.join(ws, 'README.md'), README);
    seedExplorerJson(ud, { root: ws });
    const app = await launchContinuo(ud);
    apps.push(app);
    const win = await app.firstWindow();
    await win.waitForLoadState('domcontentloaded');
    await run(win);
  } finally {
    rmSync(ws, { recursive: true, force: true });
    rmSync(ud, { recursive: true, force: true });
  }
}

async function scrollCodeEditorAndSwitchBack(win: Page): Promise<void> {
  const scroller = win.locator('.cm-scroller');
  await scroller.evaluate((el) => {
    el.scrollTop = 2000;
  });
  await expect.poll(() => scroller.evaluate((el) => el.scrollTop)).toBe(2000);
  await win.waitForTimeout(300);

  await addTerminalToEditorGroup(win);
  await editorDockTab(win).click();
  await expect(win.locator('.cm-content')).toBeFocused({ timeout: 5_000 });
  await win.waitForTimeout(500);
  expect(await scroller.evaluate((el) => el.scrollTop)).toBe(2000);
  // 视口内容随之渲染:视口中部是一行编辑器内容(不是空白),且不是文档开头几行
  const center = await scroller.evaluate((el) => {
    const r = el.getBoundingClientRect();
    const line = el.ownerDocument.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)?.closest('.cm-line');
    return line ? { text: line.textContent ?? '' } : null;
  });
  expect(center).not.toBeNull();
  expect(center!.text).not.toMatch(/\b(v|Section |Paragraph )[1-9]\b/);
}

test('代码文件:滚到中段 → 同组切到终端 → 点回编辑器 tab → 滚动保持、焦点在编辑区', async () => {
  await withWorkspace(async (win) => {
    await openWorkspaceFile(win, ['a.ts']);
    await expect(win.locator('.cm-content')).toContainText('export const v1 ', { timeout: 10_000 });
    await scrollCodeEditorAndSwitchBack(win);
  });
});

test('Markdown 源码模式:同组切到终端再切回 → 滚动保持、焦点在编辑区', async () => {
  await withWorkspace(async (win) => {
    await openWorkspaceFile(win, ['README.md']);
    await editorModeButton(win, EDITOR_MODE_SOURCE).click();
    await expect(win.locator('.cm-content')).toContainText('Section 1', { timeout: 10_000 });
    await scrollCodeEditorAndSwitchBack(win);
  });
});

test('Markdown 编辑模式:同组切到终端再切回 → 滚动保持、焦点在编辑区', async () => {
  await withWorkspace(async (win) => {
    await openWorkspaceFile(win, ['README.md']);
    await editorModeButton(win, EDITOR_MODE_EDIT).click();
    const pm = win.locator('.milkdown .ProseMirror');
    await expect(pm).toBeVisible({ timeout: 10_000 });
    await pm.getByText('Section 1', { exact: true }).click();
    const scroller = win.locator(MILKDOWN_SCROLLER);
    await scroller.evaluate((el) => {
      el.scrollTop = 1500;
    });
    await expect.poll(() => scroller.evaluate((el) => el.scrollTop)).toBe(1500);
    await win.waitForTimeout(300);

    await addTerminalToEditorGroup(win);
    await editorDockTab(win).click();
    await expect(pm).toBeFocused({ timeout: 5_000 });
    await win.waitForTimeout(500);
    expect(await scroller.evaluate((el) => el.scrollTop)).toBe(1500);
  });
});
