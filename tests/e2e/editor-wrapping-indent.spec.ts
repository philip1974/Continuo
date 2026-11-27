// 自动换行的续行缩进(VSCode editor.wrappingIndent 默认 same):真实渲染下续行首字与首行缩进对齐、缩进参考线在续行文字左侧、
// 点击 / 选区定位正确;缩进放不下时退回不缩进。BDD: src/__tests__/editor-wrapping-indent/
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { test, expect } from './fixtures/with-workspace';
import { openWorkspaceFile } from './helpers/editor';
import { waitForTestHooks } from './helpers/app-ready';

const WORDS = Array.from({ length: 60 }, (_, i) => `word${i}`).join(' ');
const SRC =
  `function f() {\n    if (x) {\n        const s = '${WORDS}';\n    }\n}\n` +
  `function g() {\n\tif (y) {\n\t\tconst t = '${WORDS}';\n\t}\n}\n` +
  `${' '.repeat(400)}const deep = '${WORDS}';\n`;

test.use({
  // eslint-disable-next-line no-empty-pattern -- Playwright 夹具要求对象解构参数
  workspaceRoot: async ({}, use) => {
    const root = mkdtempSync(path.join(tmpdir(), 'ui161-wi-ws-'));
    writeFileSync(path.join(root, 'w.ts'), SRC);
    await use(root);
    rmSync(root, { recursive: true, force: true });
  },
});

interface Measure {
  /** 首行首个非空白字符的 x */
  firstLeft: number;
  /** 续行(第二个视觉行)首字的文档位置与 x / y */
  contPos: number;
  contLeft: number;
  contTop: number;
  contBottom: number;
  /** 该行各条参考线的 x */
  guides: number[];
}

/** 第 n 行(1 起)的续行测量。 */
function measure(window: Page, n: number): Promise<Measure | null> {
  return window.locator('.cm-content').first().evaluate((content, line) => {
    type Rect = { left: number; top: number; bottom: number };
    type View = {
      state: { doc: { line(n: number): { from: number; to: number; text: string } } };
      coordsAtPos(pos: number, side?: number): Rect | null;
    };
    const view = (content as unknown as { cmTile: { root: { view: View } } }).cmTile.root.view;
    const l = view.state.doc.line(line);
    const first = l.from + (l.text.length - l.text.trimStart().length);
    const firstRect = view.coordsAtPos(first, 1)!;
    let contPos = -1;
    for (let p = first + 1; p < l.to; p++) {
      const r = view.coordsAtPos(p, 1);
      if (r && r.top > firstRect.bottom - 1) {
        contPos = p;
        break;
      }
    }
    if (contPos < 0) return null;
    const cont = view.coordsAtPos(contPos, 1)!;
    const el = content.querySelectorAll<HTMLElement>('.cm-line')[line - 1]!;
    const before = getComputedStyle(el, '::before');
    const base = el.getBoundingClientRect().left + parseFloat(before.left);
    const guides =
      before.content === 'none' ? [] : before.backgroundPositionX.split(',').map((v) => base + parseFloat(v));
    return { firstLeft: firstRect.left, contPos, contLeft: cont.left, contTop: cont.top, contBottom: cont.bottom, guides };
  }, n);
}

const head = (window: Page) =>
  window.locator('.cm-content').first().evaluate((content) => {
    const view = (content as unknown as { cmTile: { root: { view: { state: { selection: { main: { head: number } } } } } } })
      .cmTile.root.view;
    return view.state.selection.main.head;
  });

test('续行与首行缩进对齐,参考线落在续行文字左侧;点击 / 选区定位正确;缩进放不下退回不缩进', async ({ window }) => {
  await openWorkspaceFile(window, ['w.ts']);
  await expect(window.locator('.cm-content').first()).toContainText('word0');
  await waitForTestHooks(window);
  await window.evaluate(() => globalThis.__continuoTest!.setSettingValue('editor.wordWrap', true));
  await expect(window.locator('.cm-line').nth(2)).toHaveClass(/cm-wrap-indent/);

  for (const n of [3, 8]) {
    // 空格缩进(第 3 行)与 tab 缩进(第 8 行,tabSize 4)都是两级 = 8 列
    const m = (await measure(window, n))!;
    expect(m, `第 ${n} 行应折行`).not.toBeNull();
    expect(Math.abs(m.contLeft - m.firstLeft), `第 ${n} 行续行与首行缩进对齐`).toBeLessThanOrEqual(1);
    expect(m.guides.length).toBeGreaterThan(0);
    for (const x of m.guides) expect(x).toBeLessThan(m.contLeft - 2);
  }

  // 点击续行首字左侧的缩进空白 → 光标落到续行开头;点击续行首字中间 → 落到它前后
  const m = (await measure(window, 3))!;
  const y = (m.contTop + m.contBottom) / 2;
  await window.mouse.click(m.contLeft - 20, y);
  expect(await head(window)).toBe(m.contPos);
  await window.mouse.click(m.contLeft + 2, y);
  expect([m.contPos, m.contPos + 1]).toContain(await head(window));

  // 选区:从续行开头选 5 个字符,画出的选区矩形左边与续行首字对齐
  await window.locator('.cm-content').first().evaluate((content, pos) => {
    const view = (content as unknown as { cmTile: { root: { view: { dispatch(s: unknown): void } } } }).cmTile.root.view;
    view.dispatch({ selection: { anchor: pos, head: pos + 5 } });
  }, m.contPos);
  await expect
    .poll(() =>
      window.evaluate(() =>
        [...document.querySelectorAll('.cm-selectionBackground')].map((el) => el.getBoundingClientRect().left),
      ),
    )
    .toHaveLength(1);
  const selLeft = await window.evaluate(() => document.querySelector('.cm-selectionBackground')!.getBoundingClientRect().left);
  expect(Math.abs(selLeft - m.contLeft)).toBeLessThanOrEqual(1);

  // 400 列缩进:缩进 + 一个全角字符放不下一个视觉行 → 退回不缩进
  await expect(window.locator('.cm-line').nth(10)).not.toHaveClass(/cm-wrap-indent/);

  // 关自动换行 → 去掉
  await window.evaluate(() => globalThis.__continuoTest!.setSettingValue('editor.wordWrap', false));
  await expect(window.locator('.cm-wrap-indent')).toHaveCount(0);
});
