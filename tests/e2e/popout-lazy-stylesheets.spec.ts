// popout 子窗打开后才首次加载的懒加载 chunk 样式同样作用于子窗(VSCode auxiliaryWindowService.applyCSS)。此前 dockview 只在
// 开窗时抄一次主窗样式:子窗里首次切 Markdown「编辑」→ 标题不加粗不放大,Crepe 浮动工具栏 / 链接浮层 / 斜杠菜单平铺在文档下方。
// BDD: src/__tests__/popout-stylesheets/
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { openTreeItem } from './helpers/explorer';
import { closeDiscardingUnsaved } from './helpers/close-app';
import { launchContinuo } from './helpers/launch';
import { seedExplorerJson } from './helpers/seed-explorer';
import { waitForAppReady, waitForTestHooks } from './helpers/app-ready';
import { EDITOR_MODE_EDIT, TERMINAL_PANEL_TAB } from './helpers/editor';

const apps: ElectronApplication[] = [];
const dirs: string[] = [];

test.afterEach(async () => {
  for (const app of apps.splice(0)) await closeDiscardingUnsaved(app).catch(() => undefined);
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const lazyCssLinks = (page: Page, chunk: string): Promise<number> =>
  page.evaluate(
    (name) => [...document.querySelectorAll<HTMLLinkElement>('link[rel~="stylesheet"]')].filter((l) => l.href.includes(name)).length,
    chunk,
  );

test('子窗里首次进入 Markdown 编辑模式:标题放大、Crepe 浮层隐藏;主窗随后加载的终端样式也进子窗', async () => {
  test.setTimeout(120_000);
  const ud = mkdtempSync(path.join(tmpdir(), 'ui166-ud-'));
  const ws = mkdtempSync(path.join(tmpdir(), 'ui166-ws-'));
  dirs.push(ud, ws);
  writeFileSync(path.join(ws, 'file-0.ts'), 'export const zero = 0;\n');
  writeFileSync(path.join(ws, 'doc.md'), '# Heading One\n\nSome [link](https://example.com) text.\n');
  seedExplorerJson(ud, { root: ws });
  const app = await launchContinuo(ud);
  apps.push(app);
  const win = await app.firstWindow();
  await waitForAppReady(win);
  await waitForTestHooks(win);

  await openTreeItem(win, /^file-0\.ts$/);
  await expect(win.locator('[data-editor-panel-root] .cm-content')).toContainText('export const zero', { timeout: 10_000 });
  await win.evaluate(() => globalThis.__continuoTest!.executeCommand('workbench.action.moveEditorGroupToNewWindow'));
  await expect.poll(() => app.windows().length, { timeout: 15_000 }).toBe(2);
  const child = app.windows().find((w) => w !== win)!;
  await child.waitForLoadState('domcontentloaded');
  // 前提:开窗时 Milkdown 与终端的 chunk 都还没加载(dockview 开窗时没法抄到它们的样式)
  expect(await lazyCssLinks(win, 'MilkdownEditor-')).toBe(0);
  expect(await lazyCssLinks(win, 'TerminalPanelView-')).toBe(0);

  // 子窗 ⌘P 打开 doc.md(源码模式)→ 切「编辑」
  await child.bringToFront();
  await child.keyboard.press('ControlOrMeta+KeyP');
  const qo = child.getByRole('combobox');
  await expect(qo).toBeVisible({ timeout: 5_000 });
  await qo.fill('doc.md');
  await expect(child.getByRole('option').first()).toContainText('doc.md', { timeout: 10_000 });
  await child.keyboard.press('Enter');
  await expect(child.locator('[data-editor-panel-root] .cm-content')).toContainText('Heading One', { timeout: 10_000 });
  // 子窗没有 <main>(editorModeButton 限定主窗),按面板内的模式切换取
  await child.locator('[data-editor-panel-root]').getByRole('radio', { name: EDITOR_MODE_EDIT }).first().click();
  const h1 = child.locator('.milkdown h1');
  await expect(h1).toContainText('Heading One', { timeout: 15_000 });

  await expect
    .poll(() =>
      h1.evaluate((el) => {
        // Crepe:h1 2.625em(字重 400 是 Crepe 标题字体的设计值);无样式时 Tailwind preflight 让 h1 继承正文字号
        const cs = getComputedStyle(el);
        const p = el.parentElement!.querySelector('p');
        const bodySize = parseFloat(getComputedStyle(p ?? el.parentElement!).fontSize);
        return parseFloat(cs.fontSize) / bodySize;
      }),
    )
    .toBeGreaterThan(2);
  // Crepe 浮层(选区工具栏 / 链接浮层 / 斜杠菜单)未触发时不占位、不可见
  for (const sel of ['.milkdown-toolbar', '.milkdown-link-preview', '.milkdown-link-edit', '.milkdown-slash-menu']) {
    const els = child.locator(sel);
    const n = await els.count();
    for (let i = 0; i < n; i += 1) await expect(els.nth(i)).toBeHidden();
  }
  expect(await child.locator('.milkdown-toolbar, .milkdown-slash-menu').count()).toBeGreaterThan(0);
  await expect.poll(() => lazyCssLinks(child, 'MilkdownEditor-'), { timeout: 10_000 }).toBe(1);

  // 主窗随后首次加载终端 chunk → 其样式也进已打开的子窗(子窗里之后的终端不再无样式)
  await win.bringToFront();
  expect(await win.evaluate(() => globalThis.__continuoTest!.executeCommand('terminal.new'))).toBe(true);
  await expect(win.getByRole('tab', { name: TERMINAL_PANEL_TAB })).toHaveCount(1, { timeout: 15_000 });
  await expect.poll(() => lazyCssLinks(win, 'TerminalPanelView-'), { timeout: 10_000 }).toBeGreaterThan(0);
  await expect.poll(() => lazyCssLinks(child, 'TerminalPanelView-'), { timeout: 10_000 }).toBe(1);
  // 不重复:每个懒加载样式在子窗只有一份
  expect(await lazyCssLinks(child, 'MilkdownEditor-')).toBe(1);
});
