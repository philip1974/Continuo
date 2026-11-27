// 保存冲突 →「比较」→ 差异 tab(左磁盘 / 右你的版本)→ 接受我的版本 / 使用磁盘版本;Markdown 按源码比较,
// 差异期间磁盘再次变化左侧更新。单元规范见 src/__tests__/editor-save-conflict-compare/。
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { test, expect } from './fixtures/with-workspace';
import {
  EDITOR_MODE_SOURCE,
  EDITOR_UNSAVED_CHANGES_SELECTOR,
  editorModeButton,
  openWorkspaceFile,
} from './helpers/editor';
import { waitForTestHooks } from './helpers/app-ready';

const COMPARE = /^(比较|Compare|비교)$/;
const ACCEPT = /^(接受我的版本（覆盖磁盘）|Accept My Version \(Overwrite on Disk\)|내 버전 적용\(디스크 덮어쓰기\))$/;
const USE_DISK = /^(使用磁盘版本（放弃我的更改）|Use Disk Version \(Discard My Changes\)|디스크 버전 사용\(내 변경 내용 취소\))$/;

const diffPanel = (window: Page) => window.locator('[data-conflict-diff-panel]');
const diskSide = (window: Page) => diffPanel(window).locator('.cm-merge-a .cm-content');
const mineSide = (window: Page) => diffPanel(window).locator('.cm-merge-b .cm-content');

/** 改脏 → 外部改盘 → ⌘S → 冲突框 →「比较」。 */
async function conflictThenCompare(window: Page, file: string, theirs: string): Promise<void> {
  await writeFile(file, theirs);
  await window.keyboard.press('ControlOrMeta+s');
  const dialog = window.getByRole('alertdialog');
  await expect(dialog).toBeVisible({ timeout: 5_000 });
  await dialog.getByRole('button', { name: COMPARE }).click();
  await expect(dialog).toBeHidden();
  await expect(diffPanel(window)).toBeVisible({ timeout: 10_000 });
}

async function dirtyATs(window: Page): Promise<void> {
  await window.locator('text=src').first().click();
  await window.locator('text=a.ts').first().click();
  const cm = window.locator('.cm-content').first();
  await expect(cm).toBeVisible({ timeout: 10_000 });
  await cm.click();
  await window.keyboard.press('ControlOrMeta+End');
  await window.keyboard.type('// mine\n');
  await expect(window.locator(EDITOR_UNSAVED_CHANGES_SELECTOR)).toBeVisible({ timeout: 5_000 });
}

const THEIRS = 'export const theirs = 1;\n';

test('冲突 → 比较:差异内容正确 → 接受我的版本(覆盖磁盘)', async ({ window, workspaceRoot }) => {
  const file = path.join(workspaceRoot, 'src/a.ts');
  await dirtyATs(window);
  await conflictThenCompare(window, file, THEIRS);

  await expect(diskSide(window)).toContainText('export const theirs = 1;');
  await expect(diskSide(window)).not.toContainText('// mine');
  await expect(mineSide(window)).toContainText('export const a = 1;');
  await expect(mineSide(window)).toContainText('// mine');
  // 差异高亮(逐行 + 行内)
  await expect(diffPanel(window).locator('.cm-changedLine').first()).toBeVisible();
  // dock tab 标题
  await expect(window.getByText(/a\.ts（在磁盘上）↔ a\.ts（你的版本）|a\.ts \(on Disk\) ↔ a\.ts \(Your Version\)|a\.ts\(디스크\) ↔ a\.ts\(내 버전\)/).first()).toBeVisible();

  await diffPanel(window).getByRole('button', { name: ACCEPT }).click();
  await expect(diffPanel(window)).toHaveCount(0, { timeout: 5_000 });
  await expect(async () => {
    const disk = await readFile(file, 'utf8');
    expect(disk).toContain('export const a = 1;');
    expect(disk).toContain('// mine');
  }).toPass({ timeout: 5_000 });
  const cm = window.locator('.cm-content').first();
  await expect(cm).toContainText('// mine');
  await expect(window.locator(EDITOR_UNSAVED_CHANGES_SELECTOR)).toHaveCount(0);
});

test('冲突 → 比较 → 使用磁盘版本(放弃我的更改)', async ({ window, workspaceRoot }) => {
  const file = path.join(workspaceRoot, 'src/a.ts');
  await dirtyATs(window);
  await conflictThenCompare(window, file, THEIRS);
  await expect(diskSide(window)).toContainText('export const theirs = 1;');

  await diffPanel(window).getByRole('button', { name: USE_DISK }).click();
  await expect(diffPanel(window)).toHaveCount(0, { timeout: 5_000 });
  const cm = window.locator('.cm-content').first();
  await expect(cm).toContainText('export const theirs = 1;', { timeout: 5_000 });
  await expect(cm).not.toContainText('// mine');
  await expect(window.locator(EDITOR_UNSAVED_CHANGES_SELECTOR)).toHaveCount(0);
  expect(await readFile(file, 'utf8')).toBe(THEIRS);
});

test('Markdown 冲突 → 比较(按源码文本);磁盘再次变化 → 左侧更新', async ({ window, workspaceRoot }) => {
  await waitForTestHooks(window);
  // 拉长自动保存延迟:冲突前不让 Markdown 自动保存抢先写盘
  await window.evaluate(() => {
    globalThis.__continuoTest!.setSettingValue('autoSave.delayMs', 60_000);
  });
  const file = path.join(workspaceRoot, 'README.md');
  await openWorkspaceFile(window, ['README.md']);
  await editorModeButton(window, EDITOR_MODE_SOURCE).click();
  const cm = window.locator('.cm-content').first();
  await expect(cm).toBeVisible({ timeout: 10_000 });
  await cm.click();
  await window.keyboard.press('ControlOrMeta+End');
  await window.keyboard.type('\n**mine**\n');
  await expect(window.locator(EDITOR_UNSAVED_CHANGES_SELECTOR)).toBeVisible({ timeout: 5_000 });

  await conflictThenCompare(window, file, '# Theirs\n');
  await expect(diskSide(window)).toContainText('# Theirs');
  // 源码文本(Markdown 标记原样),不是渲染后的 Milkdown
  await expect(mineSide(window)).toContainText('# Test Workspace');
  await expect(mineSide(window)).toContainText('**mine**');
  await expect(diffPanel(window).locator('.milkdown')).toHaveCount(0);

  await writeFile(file, '# Theirs again\n');
  await expect(diskSide(window)).toContainText('# Theirs again', { timeout: 10_000 });

  await diffPanel(window).getByRole('button', { name: ACCEPT }).click();
  await expect(diffPanel(window)).toHaveCount(0, { timeout: 5_000 });
  await expect(async () => {
    expect(await readFile(file, 'utf8')).toContain('**mine**');
  }).toPass({ timeout: 5_000 });
});
