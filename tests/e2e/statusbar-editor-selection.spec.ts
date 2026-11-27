// 状态栏光标位置「行 X，列 Y」(VSCode status.editor.selection):真实鼠标点进正文 / 拖选 / ⌥ 单击加光标后状态栏文案随之变化,
// 列按 tab 展开;点击该项打开转到行(Quick Open 预填 `:`);Markdown 编辑模式不显示、源码模式显示。
// BDD: src/__tests__/statusbar-editor-selection/
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { test, expect } from './fixtures/with-workspace';
import { editorModeButton, EDITOR_MODE_EDIT, EDITOR_MODE_SOURCE, openWorkspaceFile } from './helpers/editor';
import { QUICK_OPEN_SEARCH } from './helpers/palette';

test.use({
  // eslint-disable-next-line no-empty-pattern -- Playwright 夹具要求对象解构参数
  workspaceRoot: async ({}, use) => {
    const root = mkdtempSync(path.join(tmpdir(), 'ui150-sel-ws-'));
    writeFileSync(path.join(root, 'tabs.ts'), 'const a = 1;\n\tlet bb = 2;\nlast\n');
    writeFileSync(path.join(root, 'note.md'), '# Title\n\nbody text\n');
    await use(root);
    rmSync(root, { recursive: true, force: true });
  },
});

const item = (window: Page) => window.locator('footer [data-statusbar-selection]');
const POS = (line: number, col: number) => new RegExp(`^(Ln ${line}, Col ${col}|行 ${line}，列 ${col}|줄 ${line}, 열 ${col})$`);
const POS_SEL = (line: number, col: number, n: number) =>
  new RegExp(`^(Ln ${line}, Col ${col} \\(${n} selected\\)|行 ${line}，列 ${col}（已选择${n}）|줄 ${line}, 열 ${col}\\(${n} 선택됨\\))$`);
const MULTI = (n: number) => new RegExp(`^(${n} selections|${n} 选择|${n} 선택 항목)$`);

/** 正文第 line 行第 offset 个字符前的屏幕坐标(从该行文字的包围盒按等宽字符推算)。 */
async function pointAt(window: Page, line: number, offset: number): Promise<{ x: number; y: number }> {
  return window.locator('.cm-content').first().evaluate(
    (el, [l, o]) => {
      const view = (el as unknown as { cmTile: { root: { view: { state: { doc: { line(n: number): { from: number } } } ; coordsAtPos(p: number): { left: number; top: number; bottom: number } | null } } } }).cmTile.root.view;
      const c = view.coordsAtPos(view.state.doc.line(l).from + o)!;
      return { x: c.left + 1, y: (c.top + c.bottom) / 2 };
    },
    [line, offset] as const,
  );
}

test('点击 / 拖选 / ⌥ 单击加光标 → 状态栏位置随之更新(tab 按 4 列展开);点击该项打开转到行', async ({ window }) => {
  await openWorkspaceFile(window, ['tabs.ts']);
  await expect(window.locator('.cm-content').first()).toContainText('let bb');
  await expect(item(window)).toHaveText(POS(1, 1));

  // 点到第 2 行「\tl|et」:tab 占 4 列 → 列 6
  const p = await pointAt(window, 2, 2);
  await window.mouse.click(p.x, p.y);
  await expect(item(window)).toHaveText(POS(2, 6));

  // 从第 1 行行首拖到第 1 行第 5 个字符 → 「行 1，列 6 (已选择 5)」
  const a = await pointAt(window, 1, 0);
  const b = await pointAt(window, 1, 5);
  await window.mouse.move(a.x, a.y);
  await window.mouse.down();
  await window.mouse.move(b.x, b.y, { steps: 5 });
  await window.mouse.up();
  await expect(item(window)).toHaveText(POS_SEL(1, 6, 5));

  // ⌥ 单击第 3 行 → 两个光标
  await window.mouse.click(p.x, p.y);
  const c = await pointAt(window, 3, 1);
  await window.keyboard.down('Alt');
  await window.mouse.click(c.x, c.y);
  await window.keyboard.up('Alt');
  await expect(item(window)).toHaveText(MULTI(2));

  // 悬停有提示「转到行/列」,点击 → Quick Open 预填 `:`
  await expect(item(window)).toHaveAttribute('title', /^(Go to Line\/Column|转到行\/列|줄\/열로 이동)$/);
  await item(window).click();
  const input = window.getByRole('combobox', { name: QUICK_OPEN_SEARCH });
  await expect(input).toBeVisible();
  await expect(input).toHaveValue(':');
  await window.keyboard.press('Escape');
});

test('Markdown:编辑模式(Milkdown)不显示位置项,源码模式显示', async ({ window }) => {
  await openWorkspaceFile(window, ['note.md']);
  await editorModeButton(window, EDITOR_MODE_EDIT).click();
  await expect(window.locator('.milkdown')).toBeVisible();
  await expect(item(window)).toHaveCount(0);
  await editorModeButton(window, EDITOR_MODE_SOURCE).click();
  await expect(window.locator('.cm-content').first()).toContainText('body text');
  await expect(item(window)).toBeVisible();
  const p = await pointAt(window, 3, 4);
  await window.mouse.click(p.x, p.y);
  await expect(item(window)).toHaveText(POS(3, 5));
});
