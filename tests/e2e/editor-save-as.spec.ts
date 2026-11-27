// 另存为 / 新建无标题文件 / 保存失败提示的「另存为… / 重试」(BDD: src/__tests__/editor-save-as/)。原生保存对话框换成桩
//(同 terminal-new-no-workspace 对打开文件夹对话框的做法):记录默认位置,返回测试给定的路径。
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { mkdir, readFile, rename } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { ElectronApplication, Page } from '@playwright/test';
import { test, expect } from './fixtures/with-workspace';
import { editorModeButton, editorTab, openWorkspaceFile } from './helpers/editor';

const SAVE_AS_BUTTON = /^(Save As…|另存为…|다른 이름으로 저장…)$/;
const RETRY_BUTTON = /^(Retry|重试|다시 시도)$/;
const UNTITLED_1 = /^(Untitled-1|无标题-1|제목 없음-1)/;

/** 保存对话框桩:每次返回 picked(null = 取消),记下 defaultPath。 */
async function stubSaveDialog(app: ElectronApplication, picked: string | null): Promise<void> {
  await app.evaluate(({ dialog }, picked) => {
    const g = globalThis as unknown as { __saveDialogDefaults: string[] };
    g.__saveDialogDefaults = [];
    dialog.showSaveDialog = (async (...args: unknown[]) => {
      const opts = args[args.length - 1] as { defaultPath?: string };
      g.__saveDialogDefaults.push(opts.defaultPath ?? '');
      return picked === null ? { canceled: true, filePath: '' } : { canceled: false, filePath: picked };
    }) as typeof dialog.showSaveDialog;
  }, picked);
}

const dialogDefaults = (app: ElectronApplication): Promise<string[]> =>
  app.evaluate(() => (globalThis as unknown as { __saveDialogDefaults: string[] }).__saveDialogDefaults);

async function typeAtEnd(window: Page, text: string): Promise<void> {
  const editor = window.locator('.cm-content').first();
  await editor.click();
  await window.keyboard.press('ControlOrMeta+End');
  await window.keyboard.type(text);
}

test('⇧⌘S 另存为:默认位置 = 原路径;写到选定路径,原 tab 换成新文件,原文件不变', async ({ electronApp, window, workspaceRoot }) => {
  const a = path.join(workspaceRoot, 'src/a.ts');
  const copy = path.join(workspaceRoot, 'copy.ts');
  await stubSaveDialog(electronApp, copy);
  await openWorkspaceFile(window, ['src', 'a.ts']);
  await typeAtEnd(window, '\n// saved-as');
  await window.keyboard.press('ControlOrMeta+Shift+S');

  await expect.poll(() => (existsSync(copy) ? readFile(copy, 'utf8') : ''), { timeout: 10_000 }).toContain('// saved-as');
  expect(await dialogDefaults(electronApp)).toEqual([a]);
  expect(await readFile(a, 'utf8')).toBe('export const a = 1;\n');
  await expect(editorTab(window, /^copy\.ts/)).toBeVisible();
  await expect(editorTab(window, /^a\.ts/)).toHaveCount(0);
});

test('⌘N 新建无标题文件 → 输入 → ⌘S 走另存为(默认 = 工作区根 + 首行名字)', async ({ electronApp, window, workspaceRoot }) => {
  const target = path.join(workspaceRoot, 'notes.txt');
  await stubSaveDialog(electronApp, target);
  await expect(window.getByRole('treeitem', { name: /^README\.md$/ })).toBeVisible({ timeout: 15_000 });
  await window.keyboard.press('ControlOrMeta+n');
  await expect(editorTab(window, UNTITLED_1)).toBeVisible({ timeout: 10_000 });
  await typeAtEnd(window, 'hello world\nsecond line');
  await window.keyboard.press('ControlOrMeta+s');

  await expect.poll(() => (existsSync(target) ? readFile(target, 'utf8') : ''), { timeout: 10_000 }).toBe(
    'hello world\nsecond line',
  );
  expect(await dialogDefaults(electronApp)).toEqual([path.join(workspaceRoot, 'hello world.txt')]);
  await expect(editorTab(window, /^notes\.txt/)).toBeVisible();
  await expect(editorTab(window, UNTITLED_1)).toHaveCount(0);
});

test('无标题文件在对话框取消 → 仍是无标题 tab,什么都不写', async ({ electronApp, window }) => {
  await stubSaveDialog(electronApp, null);
  await expect(window.getByRole('treeitem', { name: /^README\.md$/ })).toBeVisible({ timeout: 15_000 });
  await window.keyboard.press('ControlOrMeta+n');
  await typeAtEnd(window, 'draft');
  await window.keyboard.press('ControlOrMeta+s');
  await expect.poll(async () => (await dialogDefaults(electronApp)).length).toBe(1);
  await expect(editorTab(window, UNTITLED_1)).toBeVisible();
});

test.describe('保存失败提示的按钮', () => {
  /** 打开 src/a.ts 改一行,再把 src 目录移走 → ⌘S 失败(父目录不存在),等出现带按钮的提示。 */
  async function failSave(window: Page, workspaceRoot: string): Promise<void> {
    await openWorkspaceFile(window, ['src', 'a.ts']);
    await typeAtEnd(window, '\n// rescued');
    await rename(path.join(workspaceRoot, 'src'), path.join(workspaceRoot, 'src-moved'));
    await window.locator('.cm-content').first().click();
    await window.keyboard.press('ControlOrMeta+s');
    await expect(window.locator('.toast').getByRole('button', { name: RETRY_BUTTON })).toBeVisible({ timeout: 10_000 });
  }

  test('「重试」:恢复目录后重试 → 保存到原路径', async ({ window, workspaceRoot }) => {
    await failSave(window, workspaceRoot);
    await mkdir(path.join(workspaceRoot, 'src'));
    await window.locator('.toast').getByRole('button', { name: RETRY_BUTTON }).click();
    const a = path.join(workspaceRoot, 'src/a.ts');
    await expect.poll(() => (existsSync(a) ? readFile(a, 'utf8') : ''), { timeout: 10_000 }).toContain('// rescued');
    await expect(window.locator('.toast').getByRole('button', { name: RETRY_BUTTON })).toHaveCount(0);
  });

  test('「另存为…」:选新位置 → 写到那里,tab 换成新文件', async ({ electronApp, window, workspaceRoot }) => {
    const rescued = path.join(workspaceRoot, 'rescued.ts');
    await stubSaveDialog(electronApp, rescued);
    await failSave(window, workspaceRoot);
    await window.locator('.toast').getByRole('button', { name: SAVE_AS_BUTTON }).click();
    await expect.poll(() => (existsSync(rescued) ? readFile(rescued, 'utf8') : ''), { timeout: 10_000 }).toContain(
      '// rescued',
    );
    expect(await dialogDefaults(electronApp)).toEqual([path.join(workspaceRoot, 'src/a.ts')]);
    await expect(editorTab(window, /^rescued\.ts/)).toBeVisible();
  });
});

test('Markdown 另存为:内容原样写入,编辑器模式不变', async ({ electronApp, window, workspaceRoot }) => {
  const copy = path.join(workspaceRoot, 'docs-copy.md');
  await stubSaveDialog(electronApp, copy);
  await openWorkspaceFile(window, ['README.md']);
  await expect(window.locator('main').getByText('Test Workspace').first()).toBeVisible({ timeout: 10_000 });
  const checkedMode = async () =>
    window.locator('main').getByRole('radio', { checked: true }).first().textContent();
  const before = await checkedMode();
  await window.keyboard.press('ControlOrMeta+Shift+S');
  await expect.poll(() => (existsSync(copy) ? readFile(copy, 'utf8') : null), { timeout: 10_000 }).toBe('# Test Workspace\n');
  await expect(editorTab(window, /^docs-copy\.md/)).toBeVisible();
  expect(await checkedMode()).toBe(before);
  await expect(editorModeButton(window, before ?? '')).toBeChecked();
});

test.describe('非 UTF-8 编码', () => {
  // UTF-16 LE 带 BOM、CRLF 行尾的文件(打开自动识别,见 editor-text-encoding)
  const LE_BYTES = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('第一行\r\nsecond\r\n', 'utf16le')]);
  test.use({
    // eslint-disable-next-line no-empty-pattern -- Playwright 夹具要求对象解构参数
    workspaceRoot: async ({}, use) => {
      const root = mkdtempSync(path.join(tmpdir(), 'ui124a-enc-ws-'));
      mkdirSync(path.join(root, 'src'));
      writeFileSync(path.join(root, 'le.txt'), LE_BYTES);
      await use(root);
      rmSync(root, { recursive: true, force: true });
    },
  });

  test('UTF-16 LE(BOM + CRLF)另存为:新文件与原文件字节完全一致,新 tab 仍是 UTF-16 LE', async ({
    electronApp,
    window,
    workspaceRoot,
  }) => {
    const copy = path.join(workspaceRoot, 'le-copy.txt');
    await stubSaveDialog(electronApp, copy);
    await openWorkspaceFile(window, ['le.txt']);
    // 编辑器面板就绪(内容已显示)后再按键
    await expect(window.locator('.cm-content').first()).toContainText('第一行', { timeout: 10_000 });
    await window.keyboard.press('ControlOrMeta+Shift+S');
    await expect.poll(() => (existsSync(copy) ? [...(readFileSync(copy) as Buffer)] : null), { timeout: 10_000 }).toEqual([
      ...LE_BYTES,
    ]);
    await expect(editorTab(window, /^le-copy\.txt/)).toBeVisible();
    await expect(window.locator('footer [data-statusbar-encoding]')).toHaveText(/UTF-16 LE/);
    await expect(window.locator('footer [data-statusbar-eol]')).toHaveText(/CRLF/);
  });
});
