// 保存写保护(chmod 444)文件:⌘S 弹「文件是只读的 —— 覆盖 / 取消」;取消不改磁盘;覆盖后写入并去掉写保护。
// BDD: src/__tests__/save-readonly-file/
import { chmod, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { test, expect } from './fixtures/with-workspace';

const TITLE = /^(File Is Read-Only|文件是只读的|읽기 전용 파일)$/;
const OVERWRITE = /^(Overwrite|覆盖|덮어쓰기)$/;
const CANCEL = /^(Cancel|取消|취소)$/;

test.skip(process.platform === 'win32', 'chmod 444 在 Windows 只映射只读属性,由单测覆盖');

test('只读文件 ⌘S → 确认框;取消不改磁盘;覆盖后写入', async ({ window, workspaceRoot }) => {
  const aPath = path.join(workspaceRoot, 'src/a.ts');
  const original = await readFile(aPath, 'utf8');

  await window.locator('text=src').first().click();
  await window.locator('text=a.ts').first().click();
  await expect(window.locator('header').first()).toContainText('a.ts', { timeout: 10_000 });

  await chmod(aPath, 0o444);

  const editor = window.locator('.cm-content').first();
  await editor.click();
  await window.keyboard.press('ControlOrMeta+End');
  await window.keyboard.type('\n// readonly-edit');
  await window.keyboard.press('ControlOrMeta+s');

  const dialog = window.getByRole('alertdialog');
  await expect(dialog.getByText(TITLE)).toBeVisible({ timeout: 5_000 });
  await expect(dialog).toContainText('a.ts');

  // 取消:磁盘不变、仍只读
  await dialog.getByRole('button', { name: CANCEL }).click();
  await expect(dialog).toHaveCount(0);
  expect(await readFile(aPath, 'utf8')).toBe(original);
  expect((await stat(aPath)).mode & 0o222).toBe(0);

  // 再次保存 → 覆盖:写入,写保护被去掉(同 VSCode,不恢复)
  await editor.click();
  await window.keyboard.press('ControlOrMeta+s');
  await expect(dialog.getByText(TITLE)).toBeVisible({ timeout: 5_000 });
  await dialog.getByRole('button', { name: OVERWRITE }).click();
  await expect
    .poll(() => readFile(aPath, 'utf8'), { timeout: 5_000 })
    .toContain('// readonly-edit');
  expect((await stat(aPath)).mode & 0o200).toBe(0o200);
});
