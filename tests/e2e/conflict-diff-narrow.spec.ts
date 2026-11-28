// 保存冲突差异视图窄宽(BDD: src/__tests__/editor-save-conflict-compare/ 3):差异区宽 ≤ 900 → 单栏内联(VSCode
// useInlineViewWhenSpaceIsLimited);两个编辑组的窄组里工具栏按钮不竖排、不溢出盖住代码;拉宽 → 并排,你的版本内容不丢。
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { ElectronApplication, Page } from '@playwright/test';
import { test, expect } from './fixtures/with-workspace';
import { EDITOR_UNSAVED_CHANGES_SELECTOR } from './helpers/editor';

const COMPARE = /^(比较|Compare|비교)$/;
const ACCEPT = /^(接受我的版本（覆盖磁盘）|Accept My Version \(Overwrite on Disk\)|내 버전 적용\(디스크 덮어쓰기\))$/;
const USE_DISK = /^(使用磁盘版本（放弃我的更改）|Use Disk Version \(Discard My Changes\)|디스크 버전 사용\(내 변경 내용 취소\))$/;
const diffPanel = (window: Page) => window.locator('[data-conflict-diff-panel]');

const setSize = (app: ElectronApplication, w: number, h: number) =>
  app.evaluate(({ BrowserWindow }, [width, height]) => BrowserWindow.getAllWindows()[0]!.setSize(width!, height!), [w, h] as const);

test('720×900 两个编辑组:冲突比较为单栏内联,按钮不竖排不溢出;拉宽后并排,编辑内容不丢、接受后写盘', async ({
  window,
  electronApp,
  workspaceRoot,
}) => {
  test.setTimeout(90_000);
  const file = path.join(workspaceRoot, 'src/a.ts');
  await setSize(electronApp, 720, 900);
  await window.locator('text=src').first().click();
  await window.locator('text=a.ts').first().click();
  const cm = window.locator('.cm-content').first();
  await expect(cm).toBeVisible({ timeout: 10_000 });
  // ⌘\ 拆成两个编辑组,a.ts 在右组
  await cm.click();
  await window.keyboard.press('ControlOrMeta+Backslash');
  await expect(window.locator('[data-editor-panel-root]')).toHaveCount(2, { timeout: 5_000 });
  const right = window.locator('[data-editor-panel-root]').nth(1).locator('.cm-content');
  await right.click();
  await window.keyboard.press('ControlOrMeta+End');
  await window.keyboard.type('// mine\n');
  await expect(window.locator(EDITOR_UNSAVED_CHANGES_SELECTOR).first()).toBeVisible({ timeout: 5_000 });
  await writeFile(file, 'export const theirs = 1;\n');
  await window.keyboard.press('ControlOrMeta+s');
  const dialog = window.getByRole('alertdialog');
  await expect(dialog).toBeVisible({ timeout: 5_000 });
  await dialog.getByRole('button', { name: COMPARE }).click();
  const panel = diffPanel(window);
  await expect(panel).toBeVisible({ timeout: 10_000 });

  // 窄:单栏内联,磁盘版本被改的行以只读块显示
  const panelBox = (await panel.boundingBox())!;
  expect(panelBox.width).toBeLessThan(900);
  await expect(panel.locator('.cm-mergeView')).toHaveCount(0);
  await expect(panel.locator('.cm-deletedChunk').first()).toContainText('theirs');
  await expect(panel.locator('.cm-merge-b .cm-content')).toContainText('// mine');

  // 工具栏:按钮单行(不竖排)、整体在面板内、不盖住下方代码
  const toolbar = panel.getByRole('toolbar');
  const tb = (await toolbar.boundingBox())!;
  for (const name of [ACCEPT, USE_DISK]) {
    const b = (await panel.getByRole('button', { name }).boundingBox())!;
    expect(b.height).toBeLessThan(40);
    expect(b.y).toBeGreaterThanOrEqual(tb.y - 0.5);
    expect(b.y + b.height).toBeLessThanOrEqual(tb.y + tb.height + 0.5);
  }
  const editorTop = (await panel.locator('[data-conflict-diff-body]').boundingBox())!.y;
  expect(tb.y + tb.height).toBeLessThanOrEqual(editorTop + 0.5);

  // 内联时继续输入
  await panel.locator('.cm-merge-b .cm-content').click();
  await window.keyboard.press('ControlOrMeta+End');
  await window.keyboard.type('// inline\n');

  // 拉宽到差异区 > 900 → 并排,你的版本含两次输入
  await setSize(electronApp, 1900, 900);
  await window.locator('[data-editor-panel-root]').first().locator('.cm-content').click();
  // 关掉左组让差异 tab 所在组占满
  await window.keyboard.press('ControlOrMeta+KeyW');
  await expect(window.locator('[data-editor-panel-root]')).toHaveCount(1, { timeout: 5_000 });
  // 关组后焦点到差异 tab 所在组,但该组正显示的冲突比较不被切走(VSCode:MRU 组正显示的编辑器不变),焦点在比较视图里
  await expect(panel).toBeVisible();
  await expect.poll(() => panel.evaluate((el) => el.contains(el.ownerDocument.activeElement))).toBe(true);
  await expect.poll(async () => (await panel.boundingBox())!.width, { timeout: 5_000 }).toBeGreaterThan(900);
  await expect(panel.locator('.cm-mergeView')).toHaveCount(1, { timeout: 5_000 });
  await expect(panel.locator('.cm-merge-a .cm-content')).toContainText('export const theirs = 1;');
  await expect(panel.locator('.cm-merge-b .cm-content')).toContainText('// mine');
  await expect(panel.locator('.cm-merge-b .cm-content')).toContainText('// inline');

  await panel.getByRole('button', { name: ACCEPT }).click();
  await expect(panel).toHaveCount(0, { timeout: 5_000 });
  await expect(async () => {
    const disk = await readFile(file, 'utf8');
    expect(disk).toContain('// mine');
    expect(disk).toContain('// inline');
  }).toPass({ timeout: 5_000 });
});
