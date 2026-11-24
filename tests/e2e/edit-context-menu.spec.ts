// 代码编辑器(CodeMirror)右键 → main 弹出原生编辑菜单(剪切 / 复制 / 粘贴 / 全选)。
// Playwright 看不到原生菜单:在 main 里把 Menu.prototype.popup 换成记录器(不真正弹出),再验证记录的菜单项。
// BDD 见 src/__tests__/edit-context-menu/。
import { test, expect } from './fixtures/with-workspace';

test('代码编辑器右键出现剪切 / 复制 / 粘贴 / 全选菜单', async ({ window, electronApp }) => {
  await electronApp.evaluate(({ Menu }) => {
    const g = globalThis as { __ctxMenuRoles?: string[][] };
    g.__ctxMenuRoles = [];
    Menu.prototype.popup = function (this: Electron.Menu) {
      g.__ctxMenuRoles!.push(this.items.map((i) => i.role ?? i.type));
    };
  });

  await window.locator('text=src').first().click();
  await window.locator('text=a.ts').first().click();
  const cm = window.locator('.cm-content');
  await expect(cm).toBeVisible({ timeout: 10_000 });
  await cm.click({ button: 'right' });

  await expect
    .poll(() =>
      electronApp.evaluate(() => (globalThis as { __ctxMenuRoles?: string[][] }).__ctxMenuRoles),
    )
    .toEqual([['cut', 'copy', 'paste', 'separator', 'selectall']]);
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
