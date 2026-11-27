// 关闭时直接保存(files.autoSave = onFocusChange,BDD: src/__tests__/files-auto-save/ 第 6 条):
//  - 第五十一轮审计 A1:Markdown 编辑模式 ⌘W 后保存写盘尚未完成时接着打字(编辑器延迟回写还没进 store)→ 保存完先回写再判定,仍脏 →
//    tab 不关、弹「是否保存」确认框,新打的字不丢;选「保存」后才关闭。主进程的写盘处理用测试钩子挂起,模拟慢盘。
//  - 第五十一轮审计 A5:磁盘已被外部修改 → 不 toast(此前弹主进程的英文原文与完整路径),改弹确认框;选「保存」走覆盖确认框
import { readFile } from 'node:fs/promises';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import type { ElectronApplication, Page } from '@playwright/test';
import { test, expect } from './fixtures/with-workspace';
import { waitForTestHooks } from './helpers/app-ready';
import { EDITOR_MODE_EDIT, editorModeButton, editorTab, openWorkspaceFile } from './helpers/editor';

const PM = 'main .milkdown .ProseMirror';
const SAVE_CHANGES = /^(是否要保存对「.+」的更改？|Do you want to save the changes you made to .+\?|.+의 변경 내용을 저장하시겠습니까\?)$/;
const SAVE_BUTTON = /^(保存|Save|저장)$/;

async function setSetting(window: Page, id: string, value: string | boolean): Promise<void> {
  await window.evaluate(({ id, value }) => globalThis.__continuoTest!.setSettingValue(id, value), { id, value });
}

/** 挂起主进程对 `name` 的写盘(fs:write-file invoke 处理,Electron ipcMain 内部表;只在本测试进程内生效,不改产品代码)。 */
async function holdWrites(app: ElectronApplication, name: string): Promise<void> {
  const ok = await app.evaluate(({ ipcMain }, name) => {
    const table = (ipcMain as unknown as { _invokeHandlers?: Map<string, (...a: unknown[]) => unknown> })._invokeHandlers;
    const orig = table?.get('fs:write-file');
    if (table === undefined || orig === undefined) return false;
    const g = globalThis as { __e2eHeld?: number; __e2eRelease?: () => void };
    g.__e2eHeld = 0;
    table.set('fs:write-file', async (...args: unknown[]) => {
      if (JSON.stringify(args.slice(1)).includes(name) && g.__e2eRelease === undefined) {
        g.__e2eHeld = (g.__e2eHeld ?? 0) + 1;
        await new Promise<void>((resolve) => {
          g.__e2eRelease = resolve;
        });
      }
      return orig(...args);
    });
    return true;
  }, name);
  expect(ok).toBe(true);
}

const heldWrites = (app: ElectronApplication): Promise<number> =>
  app.evaluate(() => (globalThis as { __e2eHeld?: number }).__e2eHeld ?? 0);
const releaseWrites = (app: ElectronApplication): Promise<void> =>
  app.evaluate(() => {
    const g = globalThis as { __e2eRelease?: () => void };
    g.__e2eRelease?.();
    g.__e2eRelease = () => {}; // 之后的写盘不再挂起
  });

test('Markdown 编辑模式 ⌘W:保存写盘期间接着打字 → tab 不关、弹确认框,新打的字不丢', async ({
  electronApp,
  window,
  workspaceRoot,
}) => {
  test.setTimeout(90_000);
  await waitForTestHooks(window);
  await setSetting(window, 'files.autoSave', 'onFocusChange');
  await setSetting(window, 'autoSave.markdown.enabled', false);
  const file = path.join(workspaceRoot, 'note.md');
  writeFileSync(file, 'Hello\n');
  await openWorkspaceFile(window, ['note.md']);
  await editorModeButton(window, EDITOR_MODE_EDIT).click();
  await expect(window.locator(PM)).toBeVisible({ timeout: 10_000 });
  await window.locator(PM).getByText('Hello').click();
  await window.keyboard.press('End');
  await window.keyboard.type(' one');
  await holdWrites(electronApp, 'note.md');

  await window.keyboard.press('ControlOrMeta+w');
  await expect.poll(() => heldWrites(electronApp), { timeout: 5_000 }).toBe(1);
  // 写盘挂起中接着打字,随即放行写盘(编辑器的延迟回写 200ms 起,此时还没进 store)
  await window.keyboard.type(' two');
  await releaseWrites(electronApp);

  await expect(window.getByText(SAVE_CHANGES)).toBeVisible({ timeout: 5_000 });
  await expect(editorTab(window, 'note.md')).toHaveCount(1);
  expect(await readFile(file, 'utf8')).toBe('Hello one\n');
  await window.getByRole('button', { name: SAVE_BUTTON }).click();
  await expect(editorTab(window, 'note.md')).toHaveCount(0, { timeout: 5_000 });
  expect(await readFile(file, 'utf8')).toBe('Hello one two\n');
});

test('⌘W 直接保存遇磁盘已被外部修改:不 toast 英文原文 / 完整路径,改弹确认框;选「保存」→ 覆盖确认框', async ({
  window,
  workspaceRoot,
}) => {
  test.setTimeout(90_000);
  await waitForTestHooks(window);
  await setSetting(window, 'files.autoSave', 'onFocusChange');
  await openWorkspaceFile(window, ['src', 'a.ts']);
  const cm = window.locator('.cm-content').first();
  await expect(cm).toBeVisible({ timeout: 10_000 });
  await cm.click();
  await window.keyboard.press('ControlOrMeta+End');
  await window.keyboard.type(' // mine');
  writeFileSync(path.join(workspaceRoot, 'src/a.ts'), 'export const a = 42;\n');

  await window.keyboard.press('ControlOrMeta+w');
  await expect(window.getByText(SAVE_CHANGES)).toBeVisible({ timeout: 5_000 });
  await expect(editorTab(window, 'a.ts')).toHaveCount(1);
  await window.waitForTimeout(500);
  await expect(window.locator('.toast')).toHaveCount(0);
  await window.getByRole('button', { name: SAVE_BUTTON }).click();
  await expect(window.getByText(/^(文件已在磁盘上更改|File changed on disk|디스크의 파일이 변경됨)$/)).toBeVisible({ timeout: 5_000 });
  await expect(window.locator('.toast')).toHaveCount(0);
  expect(await readFile(path.join(workspaceRoot, 'src/a.ts'), 'utf8')).toBe('export const a = 42;\n');
  // 收尾:放弃更改并重新加载(否则这个自动保存失败的脏 tab 使关窗中止,teardown 挂住)
  await window.getByRole('button', { name: /^(放弃更改并重新加载|Discard Changes and Reload|변경 내용 취소 후 다시 로드)$/ }).click();
  await expect(editorTab(window, 'a.ts')).toHaveCount(0, { timeout: 5_000 });
});
