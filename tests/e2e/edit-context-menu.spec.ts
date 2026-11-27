// 代码编辑器(CodeMirror)右键 → main 弹出原生菜单:VSCode 编辑器右键菜单(更改所有匹配项 / 格式化文档 / 剪切 / 复制 / 粘贴 / 命令面板)。
// Playwright 看不到原生菜单:在 main 里把 Menu.prototype.popup 换成记录器(不真正弹出),再验证记录的菜单项。
// BDD 见 src/__tests__/edit-context-menu/。
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import type { ElectronApplication } from '@playwright/test';
import { test, expect } from './fixtures/with-workspace';
import { cmSelection } from './helpers/codemirror';

/** 把 Menu.prototype.popup 换成记录器(不真正弹出):记下菜单项(id ?? role ?? type)与菜单本身(供点击)。 */
async function recordMenus(app: ElectronApplication): Promise<void> {
  await app.evaluate(({ Menu }) => {
    const g = globalThis as { __ctxMenuRoles?: string[][]; __ctxMenus?: Electron.Menu[] };
    g.__ctxMenuRoles = [];
    g.__ctxMenus = [];
    Menu.prototype.popup = function (this: Electron.Menu) {
      g.__ctxMenus!.push(this);
      g.__ctxMenuRoles!.push(this.items.map((i) => (i.id && !/^\d+$/.test(i.id) ? i.id : (i.role ?? i.type))));
    };
  });
}

const recorded = (app: ElectronApplication) =>
  app.evaluate(() => (globalThis as { __ctxMenuRoles?: string[][] }).__ctxMenuRoles);

test('代码编辑器右键:更改所有匹配项 / ─ / 剪切 / 复制 / 粘贴 / ─ / 命令面板(VSCode 编辑器右键菜单,无全选)', async ({ window, electronApp }) => {
  await recordMenus(electronApp);
  await window.locator('text=src').first().click();
  await window.locator('text=a.ts').first().click();
  const cm = window.locator('.cm-content');
  await expect(cm).toBeVisible({ timeout: 10_000 });
  await cm.click({ button: 'right' });

  await expect.poll(() => recorded(electronApp)).toEqual([
    ['editor.action.changeAll', 'separator', 'cut', 'copy', 'paste', 'separator', 'workbench.action.showCommands'],
  ]);
});

test('JSON 文件右键多出「格式化文档」;点「更改所有匹配项」选中光标处单词的所有匹配', async ({ window, electronApp, workspaceRoot }) => {
  writeFileSync(path.join(workspaceRoot, 'data.json'), '{"foo": 1, "bar": "foo", "foo2": 3}');
  await recordMenus(electronApp);
  await window.locator('text=data.json').first().click();
  const cm = window.locator('.cm-content');
  await expect(cm).toContainText('"bar"', { timeout: 10_000 });
  // 右键落在第一个 foo 上(右键按下把光标移到该处)
  const foo = cm.getByText('"foo"', { exact: true }).first();
  await foo.click({ button: 'right' });
  await expect.poll(() => recorded(electronApp)).toEqual([
    [
      'editor.action.changeAll',
      'editor.action.formatDocument',
      'separator',
      'cut',
      'copy',
      'paste',
      'separator',
      'workbench.action.showCommands',
    ],
  ]);
  // 点菜单项(走 main 的菜单命令 → renderer 执行)
  await electronApp.evaluate(() => {
    const g = globalThis as { __ctxMenus?: Electron.Menu[] };
    g.__ctxMenus!.at(-1)!.items.find((i) => i.id === 'editor.action.changeAll')!.click();
  });
  await expect.poll(async () => (await cmSelection(cm)).ranges).toBeGreaterThanOrEqual(2);
  expect((await cmSelection(cm)).text).toBe('foo');
});

// 渲染层自定义菜单(Explorer 行 Radix ContextMenu)对 contextmenu 调 preventDefault → webContents 不再发 'context-menu',
// main 不弹原生菜单,不出双菜单。直接数 'context-menu' 事件(而非弹出次数:非可编辑无选区时本就不弹,数弹出区分不了)。
test('Explorer 行右键只出自定义菜单,main 收不到 context-menu 事件', async ({ window, electronApp }) => {
  await electronApp.evaluate(({ BrowserWindow }) => {
    const g = globalThis as { __ctxEvents?: number };
    g.__ctxEvents = 0;
    BrowserWindow.getAllWindows()[0]!.webContents.on('context-menu', () => {
      g.__ctxEvents! += 1;
    });
  });
  const ctxEvents = () =>
    electronApp.evaluate(() => (globalThis as { __ctxEvents?: number }).__ctxEvents);

  await window.locator('text=src').first().click({ button: 'right' });
  await expect(window.getByRole('menu')).toBeVisible({ timeout: 5_000 });
  await window.waitForTimeout(300);
  expect(await ctxEvents()).toBe(0);

  // 对照:不接管右键的区域(面板空白处)事件照常到达 main。
  await window.keyboard.press('Escape');
  await window.locator('main').first().click({ button: 'right', position: { x: 5, y: 5 } });
  await expect.poll(ctxEvents).toBe(1);
});
