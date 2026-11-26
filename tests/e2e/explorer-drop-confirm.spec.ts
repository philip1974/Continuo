// 资源管理器误操作防护(对齐 VSCode):
//   - 从 Finder 拖入与已有文件同名 → 先问「替换 / 取消」,取消不动原文件,替换才覆盖;无同名直接写入
//   - 树内拖动移动先确认(explorer.confirmDragAndDrop 默认开):取消不动;勾「不再询问」后移动,下次不再问
// 外部拖入:在渲染进程构造带 File 的 DataTransfer 派发 drop(真实 Finder 拖放 Playwright 驱动不了)。
import { readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { test, expect } from './fixtures/with-workspace';

// 界面语言随系统(三语都认)。
const CANCEL = /^(Cancel|取消|취소)$/;
const REPLACE = /^(Replace|替换|바꾸기)$/;
const MOVE = /^(Move|移动|이동)$/;
const DONT_ASK = /(Do not ask me again|不再询问|다시 묻지 않음)/;
const IRREVERSIBLE = /(This action is irreversible!|此操作不可撤销！|이 작업은 되돌릴 수 없습니다!)/;

const rowOf = (window: Page, p: string) => window.locator(`[role=treeitem][title="${p}"]`);

const exists = (p: string): Promise<boolean> =>
  stat(p)
    .then(() => true)
    .catch(() => false);

async function dropForeignFile(window: Page, name: string, content: string): Promise<void> {
  await window.evaluate(
    ({ name, content }) => {
      const dt = new DataTransfer();
      dt.items.add(new File([content], name));
      const tree = document.querySelector('[role=tree]')!;
      for (const type of ['dragenter', 'dragover', 'drop']) {
        tree.dispatchEvent(new DragEvent(type, { dataTransfer: dt, bubbles: true, cancelable: true }));
      }
    },
    { name, content },
  );
}

test('Finder 拖入同名文件:先确认;取消不覆盖,替换才覆盖;不同名直接写入', async ({
  window,
  workspaceRoot,
}) => {
  const readme = path.join(workspaceRoot, 'README.md');
  await expect(rowOf(window, readme)).toBeVisible({ timeout: 10_000 });

  await dropForeignFile(window, 'README.md', 'dropped');
  const dialog = window.getByRole('alertdialog');
  await expect(dialog).toContainText(/[“「]README\.md[”」]/);
  await expect(dialog).toContainText(IRREVERSIBLE);
  await dialog.getByRole('button', { name: CANCEL }).click();
  await expect(dialog).toHaveCount(0);
  expect(await readFile(readme, 'utf8')).toBe('# Test Workspace\n');

  await dropForeignFile(window, 'README.md', 'dropped');
  await window.getByRole('alertdialog').getByRole('button', { name: REPLACE }).click();
  await expect(async () => {
    expect(await readFile(readme, 'utf8')).toBe('dropped');
  }).toPass({ timeout: 5_000 });

  await dropForeignFile(window, 'fresh.txt', 'new');
  await expect(rowOf(window, path.join(workspaceRoot, 'fresh.txt'))).toBeVisible({ timeout: 5_000 });
  await expect(window.getByRole('alertdialog')).toHaveCount(0);
});

test('树内拖动移动先确认:取消不动;勾「不再询问」后移动,之后拖动不再询问', async ({
  window,
  workspaceRoot,
}) => {
  const readme = path.join(workspaceRoot, 'README.md');
  const src = rowOf(window, path.join(workspaceRoot, 'src'));
  await expect(rowOf(window, readme)).toBeVisible({ timeout: 10_000 });

  await rowOf(window, readme).dragTo(src);
  const dialog = window.getByRole('dialog');
  await expect(dialog).toContainText(/[“「]README\.md[”」].*[“「]src[”」]/);
  await dialog.getByRole('button', { name: CANCEL }).click();
  await expect(dialog).toHaveCount(0);
  expect(await exists(readme)).toBe(true);

  await rowOf(window, readme).dragTo(src);
  await dialog.getByRole('checkbox', { name: DONT_ASK }).check();
  await dialog.getByRole('button', { name: MOVE }).click();
  await expect(async () => {
    expect(await exists(path.join(workspaceRoot, 'src', 'README.md'))).toBe(true);
  }).toPass({ timeout: 5_000 });
  expect(
    await window.evaluate(
      () =>
        (window as unknown as { __continuoTest: { getSettingValue: (id: string) => unknown } })
          .__continuoTest.getSettingValue('explorer.confirmDragAndDrop'),
    ),
  ).toBe(false);

  // 已不再询问:再拖一个文件进 src → 直接移动,无确认框
  const other = path.join(workspaceRoot, 'other.txt');
  await writeFile(other, 'x');
  await expect(rowOf(window, other)).toBeVisible({ timeout: 10_000 });
  await rowOf(window, other).dragTo(src);
  await expect(async () => {
    expect(await exists(path.join(workspaceRoot, 'src', 'other.txt'))).toBe(true);
  }).toPass({ timeout: 5_000 });
  await expect(window.getByRole('dialog')).toHaveCount(0);
});

// headless-tree 在 drop 回调之后的定时器里轮询聚焦源行(≤500ms),此前把焦点从刚弹出的确认框抢回树行:
// Enter 展开背后的目录,要 Tab 才进对话框。VSCode:对话框弹出即聚焦主按钮。
const TREE_FOCUS_WRITEBACK_MS = 700;

test('树内拖动的移动确认框:弹出即聚焦「移动」(树的焦点回写之后仍在),Enter 执行移动', async ({
  window,
  workspaceRoot,
}) => {
  const readme = path.join(workspaceRoot, 'README.md');
  const src = rowOf(window, path.join(workspaceRoot, 'src'));
  await expect(rowOf(window, readme)).toBeVisible({ timeout: 10_000 });

  await rowOf(window, readme).dragTo(src);
  const dialog = window.getByRole('dialog');
  const move = dialog.getByRole('button', { name: MOVE });
  await expect(move).toBeFocused();
  await window.waitForTimeout(TREE_FOCUS_WRITEBACK_MS);
  await expect(move).toBeFocused();
  await window.keyboard.press('Enter');
  await expect(dialog).toHaveCount(0);
  await expect.poll(() => exists(path.join(workspaceRoot, 'src', 'README.md'))).toBe(true);
  expect(await exists(readme)).toBe(false);
});

test('Finder 拖到目录行上遇同名:询问框弹出即聚焦初始按钮(取消),树的焦点回写之后仍在对话框里', async ({
  window,
  workspaceRoot,
}) => {
  const srcDir = path.join(workspaceRoot, 'src');
  const a = path.join(srcDir, 'a.ts');
  await expect(rowOf(window, srcDir)).toBeVisible({ timeout: 10_000 });
  await window.evaluate((title) => {
    const dt = new DataTransfer();
    dt.items.add(new File(['dropped'], 'a.ts'));
    const row = document.querySelector(`[role=treeitem][title="${title}"]`)!;
    for (const type of ['dragenter', 'dragover', 'drop']) {
      row.dispatchEvent(new DragEvent(type, { dataTransfer: dt, bubbles: true, cancelable: true }));
    }
  }, srcDir);
  const dialog = window.getByRole('alertdialog');
  await expect(dialog).toContainText(/[“「]a\.ts[”」]/);
  const cancel = dialog.getByRole('button', { name: CANCEL });
  await expect(cancel).toBeFocused();
  await window.waitForTimeout(TREE_FOCUS_WRITEBACK_MS);
  await expect(cancel).toBeFocused();
  await window.keyboard.press('Enter');
  await expect(dialog).toHaveCount(0);
  expect(await readFile(a, 'utf8')).toBe('export const a = 1;\n');
});
