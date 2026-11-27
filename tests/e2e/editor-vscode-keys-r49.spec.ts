// VSCode 迁移用户的常用键(第四十九轮审计 B 组 5 / 7 / 8):⌘J 切换终端、⇧⌘D 显示调试、⇧⌘U 显示输出(编辑器获焦时也生效)、
// ⇧⌘V Markdown 切换预览;⌥ 单击添加光标、⌘ 单击不加、⇧⌥ 拖动列选择;⌘I 触发建议;⇧⌥F 格式化 JSON / 其它语言提示;F12 提示。
// BDD: src/__tests__/workbench-vscode-default-keys/、src/__tests__/editor-mouse-multicursor/、src/__tests__/editor-language-commands/
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { EDITOR_MODE_PREVIEW, EDITOR_MODE_SOURCE, TERMINAL_PANEL_TAB, editorModeButton } from './helpers/editor';
import { openTreeItem } from './helpers/explorer';
import { closeDiscardingUnsaved } from './helpers/close-app';
import { launchContinuo } from './helpers/launch';
import { seedExplorerJson } from './helpers/seed-explorer';
import { OUTPUT_EMPTY } from './helpers/output';

const apps: Awaited<ReturnType<typeof launchContinuo>>[] = [];
const dirs: string[] = [];

test.afterEach(async () => {
  for (const app of apps.splice(0)) await closeDiscardingUnsaved(app).catch(() => undefined);
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function launch(): Promise<Page> {
  const ud = mkdtempSync(path.join(tmpdir(), 'ui138b-ud-'));
  const ws = mkdtempSync(path.join(tmpdir(), 'ui138b-ws-'));
  dirs.push(ud, ws);
  writeFileSync(path.join(ws, 'a.ts'), 'one\ntwo\nthree\n');
  writeFileSync(path.join(ws, 'b.json'), '{"a":1,"b":[true,{}],"c":1.0}\n');
  writeFileSync(path.join(ws, 'bad.json'), '{"a":1,}\n');
  writeFileSync(path.join(ws, 'c.md'), '# Title\n\nbody text\n');
  seedExplorerJson(ud, { root: ws });
  const app = await launchContinuo(ud);
  apps.push(app);
  const win = await app.firstWindow();
  await win.waitForLoadState('domcontentloaded');
  const cdp = await win.context().newCDPSession(win);
  await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: false });
  return win;
}

async function openCode(win: Page, name: RegExp, text: string): Promise<void> {
  await openTreeItem(win, name);
  await expect(win.locator('main .cm-content')).toContainText(text, { timeout: 10_000 });
  await win.locator('main .cm-content').click();
}

const lines = (win: Page): Promise<string[]> => win.locator('main .cm-content').first().locator('.cm-line').allTextContents();
const focusIn = (win: Page): Promise<'terminal' | 'editor' | 'other'> =>
  win.evaluate(() => {
    const el = document.activeElement;
    if (el?.closest('.xterm')) return 'terminal';
    if (el?.closest('.cm-editor')) return 'editor';
    return 'other';
  });
const cursorCount = (win: Page): Promise<number> => win.locator('main .cm-cursorLayer .cm-cursor').count();
const toast = (win: Page, text: RegExp) => win.locator('.toast').filter({ hasText: text });

test('⌘J 切换终端(编辑器 ↔ 终端);⇧⌘D 显示调试;编辑器获焦时 ⇧⌘U 显示输出', async () => {
  test.setTimeout(120_000);
  const win = await launch();
  await openCode(win, /^a\.ts$/, 'three');
  await win.keyboard.press('ControlOrMeta+j');
  await expect(win.getByRole('tab', { name: TERMINAL_PANEL_TAB })).toHaveCount(1, { timeout: 20_000 });
  await expect.poll(() => focusIn(win), { timeout: 15_000 }).toBe('terminal');
  await win.keyboard.press('ControlOrMeta+j');
  await expect.poll(() => focusIn(win)).toBe('editor');

  await win.keyboard.press('ControlOrMeta+Shift+d');
  await expect(win.getByRole('tab', { name: /^(调试|Debug|디버그)$/ })).toHaveCount(1, { timeout: 10_000 });

  // 调试面板与编辑器同组(遮住编辑器)→ 回到 a.ts,焦点在编辑器正文里按 ⇧⌘U(CodeMirror 原把它当「光标重做」吞掉)
  await openCode(win, /^a\.ts$/, 'three');
  await expect.poll(() => focusIn(win)).toBe('editor');
  await win.keyboard.press('ControlOrMeta+Shift+u');
  await expect(win.getByText(OUTPUT_EMPTY)).toBeVisible({ timeout: 10_000 });
});

test('⇧⌘V:Markdown 源码 → 预览,再按回到源码', async () => {
  test.setTimeout(90_000);
  const win = await launch();
  await openTreeItem(win, /^c\.md$/);
  await editorModeButton(win, EDITOR_MODE_SOURCE).click();
  await expect(win.locator('main .cm-content')).toContainText('body text', { timeout: 10_000 });
  await win.locator('main .cm-content').click();
  await win.keyboard.press('ControlOrMeta+Shift+v');
  await expect(editorModeButton(win, EDITOR_MODE_PREVIEW)).toBeChecked({ timeout: 10_000 });
  await expect(win.locator('main .ProseMirror')).toContainText('body text', { timeout: 10_000 });
  // 焦点进入预览 → 再按一次切回
  await expect.poll(() => win.evaluate(() => document.activeElement?.closest('[data-co-markdown-editor]') !== null)).toBe(true);
  await win.keyboard.press('ControlOrMeta+Shift+v');
  await expect(editorModeButton(win, EDITOR_MODE_SOURCE)).toBeChecked({ timeout: 10_000 });
  await expect(win.locator('main .cm-content')).toContainText('body text');
});

test('⌥ 单击添加光标、⌘ 单击不加(只移动);⇧⌥ 拖动列选择', async () => {
  test.setTimeout(90_000);
  const win = await launch();
  await openCode(win, /^a\.ts$/, 'three');
  const line = (i: number) => win.locator('main .cm-content .cm-line').nth(i);
  await line(0).click();
  await win.keyboard.down('Alt');
  await line(2).click();
  await win.keyboard.up('Alt');
  await expect.poll(() => cursorCount(win)).toBe(2);
  await win.keyboard.type('X');
  await expect.poll(() => lines(win)).toEqual(['oneX', 'two', 'threeX', '']);

  await win.keyboard.down('Meta');
  await line(1).click();
  await win.keyboard.up('Meta');
  await expect.poll(() => cursorCount(win)).toBe(1);

  // ⇧⌥ 拖动:第 1 行行首 → 第 3 行第 2 列,三行各一个选区
  const a = await line(0).boundingBox();
  const c = await line(2).boundingBox();
  await win.keyboard.down('Shift');
  await win.keyboard.down('Alt');
  await win.mouse.move(a!.x + 1, a!.y + a!.height / 2);
  await win.mouse.down();
  await win.mouse.move(c!.x + 18, c!.y + c!.height / 2, { steps: 5 });
  await win.mouse.up();
  await win.keyboard.up('Alt');
  await win.keyboard.up('Shift');
  await win.keyboard.type('Y');
  await expect.poll(() => lines(win).then((l) => l.slice(0, 3).every((s) => s.startsWith('Y')))).toBe(true);
});

test('⌘I 触发建议(不再扩展选区)', async () => {
  test.setTimeout(90_000);
  const win = await launch();
  await openCode(win, /^a\.ts$/, 'three');
  // 光标在文末空行(不打字:打字会自动弹出补全,与 ⌘I 混淆;显式触发时空行也列出关键字)
  await win.keyboard.press('ControlOrMeta+End');
  await expect(win.locator('.cm-tooltip-autocomplete')).toHaveCount(0);
  await win.keyboard.press('ControlOrMeta+i');
  await expect(win.locator('.cm-tooltip-autocomplete')).toBeVisible({ timeout: 10_000 });
  // 不再是「扩展到父语法节点」:没有选区
  await expect(win.locator('main .cm-selectionBackground')).toHaveCount(0);
});

test('⇧⌥F:JSON 按缩进格式化(字面量不变),语法错误提示不改,其它语言提示没有格式化程序;F12 提示未找到定义', async () => {
  test.setTimeout(120_000);
  const win = await launch();
  await openCode(win, /^b\.json$/, '"c"');
  // 单行文档推断不出缩进 → 编辑器默认缩进(VSCode editor.tabSize 4、insertSpaces);格式化跟随当前缩进单位
  await win.keyboard.press('Shift+Alt+f');
  await expect
    .poll(() => lines(win))
    .toEqual(['{', '    "a": 1,', '    "b": [', '        true,', '        {}', '    ],', '    "c": 1.0', '}', '']);
  await win.keyboard.press('ControlOrMeta+z');
  await expect.poll(() => lines(win)).toEqual(['{"a":1,"b":[true,{}],"c":1.0}', '']);

  await openCode(win, /^bad\.json$/, '"a"');
  await win.keyboard.press('Shift+Alt+f');
  await expect(toast(win, /JSON/)).toBeVisible({ timeout: 5_000 });
  expect(await lines(win)).toEqual(['{"a":1,}', '']);

  await openCode(win, /^a\.ts$/, 'three');
  await win.keyboard.press('Shift+Alt+f');
  await expect(toast(win, /typescript/)).toBeVisible({ timeout: 5_000 });
  await win.keyboard.press('ControlOrMeta+Home');
  await win.keyboard.press('F12');
  await expect(toast(win, /one/)).toBeVisible({ timeout: 5_000 });
  expect(await lines(win)).toEqual(['one', 'two', 'three', '']);
});
