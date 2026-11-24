// Markdown 编辑器(Milkdown)与代码编辑器的计算样式接设计 token / 设置(单测只能钉声明,层叠在这里验)。
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { test, expect } from './fixtures/with-workspace';
import { EDITOR_MODE_EDIT, EDITOR_MODE_SOURCE, editorModeButton, openWorkspaceFile } from './helpers/editor';
import { waitForTestHooks } from './helpers/app-ready';

const DOC = [
  '# Title',
  '',
  'Body text.',
  '',
  '```js',
  'const a = 1;',
  '```',
  '',
  '| Col A | Col B | A very long column header text |',
  '| --- | --- | --- |',
  '| 1 | two | three three three three three three |',
  '',
].join('\n');

async function setWidth(electronApp: import('@playwright/test').ElectronApplication, width: number) {
  await electronApp.evaluate(({ BrowserWindow }, w) => {
    const win = BrowserWindow.getAllWindows().find((x) => !x.isDestroyed() && x.isVisible()) ?? BrowserWindow.getAllWindows()[0];
    win?.setSize(w, 900);
  }, width);
}

test('Edit:字体取 token、字号跟随 editor.fontSize、窄宽内边距收缩、表头不断词', async ({
  electronApp,
  window,
  workspaceRoot,
}) => {
  writeFileSync(path.join(workspaceRoot, 'style.md'), DOC);
  await openWorkspaceFile(window, ['style.md']);
  await editorModeButton(window, EDITOR_MODE_EDIT).click();
  const pm = window.locator('main .milkdown .ProseMirror');
  await expect(pm.locator('h1')).toContainText('Title', { timeout: 10_000 });

  const styles = await pm.evaluate((el) => {
    const root = getComputedStyle(document.documentElement);
    const h1 = el.querySelector('h1')!;
    return {
      sans: root.getPropertyValue('--wm-font-sans').trim(),
      body: getComputedStyle(el).fontFamily,
      title: getComputedStyle(h1).fontFamily,
    };
  });
  expect(styles.body).not.toMatch(/Noto Sans/);
  expect(styles.title).not.toMatch(/Noto Serif/);
  expect(styles.body).toMatch(/Manrope/);
  expect(styles.title).toMatch(/Manrope/);

  await waitForTestHooks(window);
  await window.evaluate(() => globalThis.__continuoTest!.setSettingValue('editor.fontSize', 20));
  await expect
    .poll(() => window.locator('main .milkdown').first().evaluate((el) => getComputedStyle(el).fontSize))
    .toBe('20px');
  // 代码块占位层(CodeMirror 懒创建前 / 回收后显示)按 --crepe-base-font-size 算字号,须同样跟随设置
  expect(
    await window
      .locator('main .milkdown')
      .first()
      .evaluate((el) => getComputedStyle(el).getPropertyValue('--crepe-base-font-size').trim()),
  ).toBe('20px');

  await setWidth(electronApp, 800);
  await expect
    .poll(() => pm.evaluate((el) => parseFloat(getComputedStyle(el).paddingRight)))
    .toBeLessThan(120);

  // 窄宽下悬停段落,块手柄仍在段落左侧且不超出编辑区左边界
  await pm.locator('p', { hasText: 'Body text.' }).hover();
  const handle = window.locator('main .milkdown .milkdown-block-handle');
  await expect(handle).toHaveAttribute('data-show', 'true');
  const pos = await pm.evaluate((el) => {
    const h = el.closest('.milkdown')!.querySelector('.milkdown-block-handle')!.getBoundingClientRect();
    const p = [...el.querySelectorAll('p')].find((x) => x.textContent === 'Body text.')!.getBoundingClientRect();
    const scroller = el.closest('.overflow-auto')!.getBoundingClientRect();
    return { handleLeft: h.left, handleRight: h.right, pLeft: p.left, scrollerLeft: scroller.left };
  });
  expect(pos.handleRight).toBeLessThanOrEqual(pos.pLeft);
  expect(pos.handleLeft).toBeGreaterThanOrEqual(pos.scrollerLeft);

  // 表头每个单词都完整落在一行内:单元格内容宽度 ≥ 最长单词宽度
  const fits = await pm.locator('th').evaluateAll((ths) =>
    ths.every((th) => {
      const cs = getComputedStyle(th);
      const ctx = document.createElement('canvas').getContext('2d')!;
      ctx.font = `${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
      const longest = Math.max(...(th.textContent ?? '').split(/\s+/).map((w) => ctx.measureText(w).width));
      const inner = th.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
      return inner + 0.5 >= longest;
    }),
  );
  expect(fits).toBe(true);
});

test('Source / 代码编辑器:底色与画布同为 --md-surface,字体取 --wm-font-mono', async ({ window }) => {
  await openWorkspaceFile(window, ['README.md']);
  await editorModeButton(window, EDITOR_MODE_SOURCE).click();
  const cm = window.locator('main .cm-editor').first();
  await expect(cm).toBeVisible({ timeout: 10_000 });
  const s = await cm.evaluate((el) => {
    const probe = document.createElement('div');
    probe.style.background = 'var(--md-surface)';
    probe.style.fontFamily = 'var(--wm-font-mono)';
    document.body.append(probe);
    const want = { bg: getComputedStyle(probe).backgroundColor, font: getComputedStyle(probe).fontFamily };
    probe.remove();
    const scroller = el.querySelector('.cm-scroller')!;
    const gutters = el.querySelector('.cm-gutters');
    return {
      want,
      bg: getComputedStyle(el).backgroundColor,
      gutterBg: gutters ? getComputedStyle(gutters).backgroundColor : want.bg,
      font: getComputedStyle(scroller).fontFamily,
    };
  });
  expect(s.bg).toBe(s.want.bg);
  expect(s.gutterBg).toBe(s.want.bg);
  expect(s.font).toBe(s.want.font);
});

// Crepe 序号盒固定 32px,只在 16px 时与首行文字对齐;覆写为随字号计算后,任意字号下序号与首行文字同一行。
test('Edit:有序列表序号与首行文字对齐(10 / 13 / 28px)', async ({ window, workspaceRoot }) => {
  writeFileSync(path.join(workspaceRoot, 'list.md'), '1. first item\n2. second item\n');
  await openWorkspaceFile(window, ['list.md']);
  await editorModeButton(window, EDITOR_MODE_EDIT).click();
  const pm = window.locator('main .milkdown .ProseMirror');
  await expect(pm.locator('li p').first()).toContainText('first item', { timeout: 10_000 });
  await waitForTestHooks(window);
  for (const size of [10, 13, 28]) {
    await window.evaluate((s) => globalThis.__continuoTest!.setSettingValue('editor.fontSize', s), size);
    await expect
      .poll(() => window.locator('main .milkdown').first().evaluate((el) => getComputedStyle(el).fontSize))
      .toBe(`${size}px`);
    // 序号文字与段落首行文字的行盒上缘之差(同字号同行高时为 0)
    const delta = await pm.evaluate((el) => {
      const textTop = (node: Element): number => {
        const r = document.createRange();
        r.selectNodeContents(node);
        return r.getClientRects()[0]!.top;
      };
      const li = el.querySelector('li')!;
      return textTop(li.querySelector('.label')!) - textTop(li.querySelector('p')!);
    });
    expect(Math.abs(delta), `fontSize ${size}px`).toBeLessThan(1);
  }
});
