// 在文件中查找(⇧⌘F,src/__tests__/workspace-search):搜索出结果、点击跳转行列、正则 / 大小写、非法正则提示、
// 包含 / 排除、新查询取代旧查询、编辑器选区带入。走真实 main 搜索 worker。
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { test, expect } from './fixtures/with-workspace';
import { waitForTestHooks } from './helpers/app-ready';
import { EDITOR_MODE_EDIT, editorModeButton, openWorkspaceFile } from './helpers/editor';

const QUERY = /^(搜索|Search|검색)$/;
const STATUS = '[data-testid=search-panel] [role=status]';
const summary = (files: number, results: number) =>
  new RegExp(`(${files} 个文件中有 ${results} 个结果|${results} results? in ${files} files?|파일 ${files}개에서 결과 ${results}개)`);
const NO_RESULTS = /(未找到结果|No results found|결과 없음)/;
const resultsTree = (window: Page) => window.getByRole('tree', { name: /^(搜索结果|Search results|검색 결과)$/ });

async function openSearch(window: Page) {
  await waitForTestHooks(window);
  await window.locator('body').click({ position: { x: 1, y: 1 } }).catch(() => {});
  await window.keyboard.press('ControlOrMeta+Shift+KeyF');
  const input = window.getByRole('textbox', { name: QUERY });
  await expect(input).toBeFocused({ timeout: 10_000 });
  return input;
}

const toggle = (window: Page, name: RegExp) =>
  window.locator('[data-testid=search-panel]').getByRole('button', { name });

/** 编辑器光标所在行文本与列偏移(0 起)。 */
const caret = (window: Page) =>
  window.evaluate(() => {
    const sel = document.getSelection();
    const line = sel?.anchorNode?.parentElement?.closest('.cm-line') ?? (sel?.anchorNode as Element | null)?.closest?.('.cm-line');
    if (!sel?.anchorNode || !line) return null;
    const r = document.createRange();
    r.setStart(line, 0);
    r.setEnd(sel.anchorNode, sel.anchorOffset);
    return `${line.textContent}|${r.toString().length}`;
  });

test('⇧⌘F 搜索出结果(按文件分组 + 计数),点击匹配行打开并定位行列', async ({ window, workspaceRoot }) => {
  writeFileSync(path.join(workspaceRoot, 'src', 'c.ts'), 'line1\n    const needle = 3;\nneedle();\n');
  const input = await openSearch(window);
  await input.fill('needle');
  await expect(window.locator(STATUS)).toHaveText(summary(1, 2), { timeout: 10_000 });
  const tree = resultsTree(window);
  await expect(tree.getByRole('treeitem')).toHaveCount(3);
  await expect(tree.getByRole('treeitem').first()).toContainText('c.ts');
  await expect(tree.locator('mark').first()).toHaveText('needle');

  await tree.getByRole('treeitem').nth(1).click();
  await expect
    .poll(() => window.evaluate(() => globalThis.__continuoTest!.getEditorActiveTabId()), { timeout: 10_000 })
    .toMatch(/c\.ts$/);
  await expect.poll(() => caret(window), { timeout: 10_000 }).toBe('    const needle = 3;|10');
  // 选中匹配范围(VSCode 同),不只放光标
  await expect.poll(() => window.evaluate(() => document.getSelection()?.toString())).toBe('needle');
});

test('Markdown 编辑模式:点击结果定位并选中匹配、焦点进编辑区、匹配滚入视图', async ({ window, workspaceRoot }) => {
  const parts = ['# Long doc', ''];
  for (let i = 0; i < 80; i++) parts.push(`Paragraph ${i} ${i === 70 ? 'has the **zebra** word' : 'is filler text'}.`, '');
  writeFileSync(path.join(workspaceRoot, 'long.md'), parts.join('\n'));
  await openWorkspaceFile(window, ['long.md']);
  await editorModeButton(window, EDITOR_MODE_EDIT).click();
  const pm = window.locator('main .milkdown .ProseMirror');
  await expect(pm.locator('h1')).toHaveText('Long doc', { timeout: 10_000 });

  const input = await openSearch(window);
  await input.fill('zebra');
  await expect(window.locator(STATUS)).toHaveText(summary(1, 1), { timeout: 10_000 });
  await resultsTree(window).getByRole('treeitem').nth(1).click();
  await expect.poll(() => window.evaluate(() => document.getSelection()?.toString()), { timeout: 10_000 }).toBe('zebra');
  await expect.poll(() => pm.evaluate((el) => el.contains(document.activeElement))).toBe(true);
  const scroller = window.locator('main .milkdown').locator('xpath=ancestor::div[contains(@class,"overflow-auto")][1]');
  await expect(async () => {
    const m = (await pm.locator('strong', { hasText: 'zebra' }).boundingBox())!;
    const s = (await scroller.boundingBox())!;
    expect(m.y).toBeGreaterThanOrEqual(s.y);
    expect(m.y + m.height).toBeLessThanOrEqual(s.y + s.height);
  }).toPass({ timeout: 3_000 });
  await window.screenshot({ path: test.info().outputPath('search-open-markdown.png') });
});

test('区分大小写 / 正则开关;非法正则提示', async ({ window, workspaceRoot }) => {
  writeFileSync(path.join(workspaceRoot, 'notes.md'), 'Alpha\nalpha beta\n');
  const input = await openSearch(window);
  await input.fill('ALPHA');
  await expect(window.locator(STATUS)).toHaveText(summary(1, 2), { timeout: 10_000 });
  await toggle(window, /^(区分大小写|Match case|대소문자 구분)$/).click();
  await expect(window.locator(STATUS)).toHaveText(NO_RESULTS, { timeout: 10_000 });
  await toggle(window, /^(区分大小写|Match case|대소문자 구분)$/).click();

  await toggle(window, /^(使用正则表达式|Use regular expression|정규식 사용)$/).click();
  await input.fill('al(pha|x) be');
  await expect(window.locator(STATUS)).toHaveText(summary(1, 1), { timeout: 10_000 });
  await input.fill('a(');
  await expect(window.locator(STATUS)).toHaveText(/(正则表达式无效|Invalid regular expression|잘못된 정규식)/i);
  await expect(input).toHaveAttribute('aria-invalid', 'true');
});

test('包含 / 排除的文件', async ({ window }) => {
  const input = await openSearch(window);
  await input.fill('export const');
  await expect(window.locator(STATUS)).toHaveText(summary(2, 2), { timeout: 10_000 });
  await window.getByRole('button', { name: /(切换搜索详细信息|Toggle Search Details|검색 세부 정보)/ }).click();
  const include = window.getByRole('textbox', { name: /(包含的文件|files to include|포함할 파일)/ });
  const exclude = window.getByRole('textbox', { name: /(排除的文件|files to exclude|제외할 파일)/ });
  await include.fill('b.ts');
  await expect(window.locator(STATUS)).toHaveText(summary(1, 1), { timeout: 10_000 });
  await expect(resultsTree(window).getByRole('treeitem').first()).toContainText('b.ts');
  await include.fill('src');
  await exclude.fill('a.ts');
  await expect(window.locator(STATUS)).toHaveText(summary(1, 1), { timeout: 10_000 });
  await exclude.fill('*.ts');
  await expect(window.locator(STATUS)).toHaveText(NO_RESULTS, { timeout: 10_000 });
});

test('新查询取代在途查询:只显示最后一次查询的结果', async ({ window, workspaceRoot }) => {
  for (let i = 0; i < 300; i += 1) writeFileSync(path.join(workspaceRoot, `f${i}.txt`), `first-${i}\nsecond-${i}\n`);
  const input = await openSearch(window);
  await input.fill('first');
  await input.press('Enter');
  await input.fill('second-7');
  await input.press('Enter');
  // second-7 / second-70..79 / second-700? 只有 0..299:second-7, second-70..79 = 11 个文件
  await expect(window.locator(STATUS)).toHaveText(summary(11, 11), { timeout: 15_000 });
  await window.waitForTimeout(500);
  await expect(window.locator(STATUS)).toHaveText(summary(11, 11));
  await expect(resultsTree(window).locator('mark').filter({ hasText: /^first/ })).toHaveCount(0);
});

test('编辑器单行选区带入查询框', async ({ window }) => {
  await openWorkspaceFile(window, ['src', 'a.ts']);
  const line = window.locator('.cm-content .cm-line').first();
  await expect(line).toHaveText('export const a = 1;', { timeout: 10_000 });
  await line.getByText('export const a = 1;').dblclick({ position: { x: 5, y: 5 } });
  await expect.poll(() => window.evaluate(() => document.getSelection()?.toString())).toBe('export');
  await window.keyboard.press('ControlOrMeta+Shift+KeyF');
  const input = window.getByRole('textbox', { name: QUERY });
  await expect(input).toBeFocused({ timeout: 10_000 });
  await expect(input).toHaveValue('export');
  await expect(window.locator(STATUS)).toHaveText(summary(2, 2), { timeout: 10_000 });
});

test('已打开编辑器的未保存修改也能搜到(VSCode:内存内容覆盖磁盘结果)', async ({ window, workspaceRoot }) => {
  await openWorkspaceFile(window, ['src', 'a.ts']);
  const line = window.locator('.cm-content .cm-line').first();
  await expect(line).toHaveText('export const a = 1;', { timeout: 10_000 });
  await line.click();
  await window.keyboard.press('End');
  await window.keyboard.type(' // unsavedZebra');
  await expect(line).toHaveText('export const a = 1; // unsavedZebra');
  const input = await openSearch(window);
  await input.fill('unsavedZebra');
  await expect(window.locator(STATUS)).toHaveText(summary(1, 1), { timeout: 10_000 });
  await expect(resultsTree(window).getByRole('treeitem').first()).toContainText('a.ts');
  // 磁盘上仍是旧内容(.ts 不自动保存)—— 结果来自内存
  expect(readFileSync(path.join(workspaceRoot, 'src', 'a.ts'), 'utf8')).not.toContain('unsavedZebra');
});
