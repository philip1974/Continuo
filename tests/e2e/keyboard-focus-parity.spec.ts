// 代码编辑器 Tab 缩进 / Esc+Tab 移出;F6 / ⇧F6 在 dock 组 / 状态栏 / 侧栏间循环(VSCode 同);弹出子窗关闭后编辑器获焦。
// BDD: src/__tests__/keyboard-focus-parity/
import { test, expect } from './fixtures/with-workspace';
import { DOCK_POPOUT } from './helpers/editor';

test('代码编辑器:Tab 缩进、⇧Tab 反缩进,焦点留在编辑器;Esc 后 Tab 移出编辑器', async ({ window }) => {
  await window.locator('text=src').first().click();
  await window.locator('text=a.ts').first().dblclick();
  const cm = window.locator('.cm-content');
  await expect(cm).toContainText('export const a', { timeout: 10_000 });
  await expect(cm).toBeFocused({ timeout: 5_000 });
  await window.keyboard.press('ControlOrMeta+Home');

  await window.keyboard.press('Tab');
  await expect(cm).toBeFocused();
  await expect(window.locator('.cm-line').first()).toHaveText(/^\s+export const a/);
  await window.keyboard.press('Shift+Tab');
  await expect(window.locator('.cm-line').first()).toHaveText(/^export const a/);

  await window.keyboard.press('Escape');
  await window.keyboard.press('Tab');
  await expect(cm).not.toBeFocused();
  await expect(window.locator('.cm-line').first()).toHaveText(/^export const a/);
});

test('编辑器里 F6 → 状态栏 → 侧栏(Explorer 树)→ 回编辑器;⇧F6 反向', async ({ window }) => {
  await window.locator('text=src').first().click();
  await window.locator('text=a.ts').first().dblclick();
  const cm = window.locator('.cm-content');
  await expect(cm).toContainText('export const a', { timeout: 10_000 });
  await expect(cm).toBeFocused({ timeout: 5_000 });

  const inPart = (part: string) =>
    window.evaluate((p) => Boolean(document.activeElement?.closest(`[data-workbench-part="${p}"]`)), part);

  await window.keyboard.press('F6');
  await expect.poll(() => inPart('statusbar')).toBe(true);
  await window.keyboard.press('F6');
  await expect.poll(() => inPart('sidebar')).toBe(true);
  await expect(window.locator(':focus')).toHaveAttribute('role', 'treeitem');
  await window.keyboard.press('F6');
  await expect(cm).toBeFocused();

  await window.keyboard.press('Shift+F6');
  await expect.poll(() => inPart('sidebar')).toBe(true);
  await window.keyboard.press('Shift+F6');
  await expect.poll(() => inPart('statusbar')).toBe(true);
  await window.keyboard.press('Shift+F6');
  await expect(cm).toBeFocused();
});

test('编辑器获焦时弹出到独立窗口,关掉子窗(BrowserWindow.close)→ 编辑器回主窗并获焦,可直接打字', async ({
  electronApp,
  window,
}) => {
  await window.locator('text=src').first().click();
  await window.locator('text=a.ts').first().dblclick();
  const cm = window.locator('.cm-content');
  await expect(cm).toContainText('export const a', { timeout: 10_000 });
  await expect(cm).toBeFocused({ timeout: 5_000 });

  const childOpened = electronApp.waitForEvent('window', { timeout: 10_000 });
  await window.getByRole('button', { name: DOCK_POPOUT }).first().click();
  const child = await childOpened;
  await expect(child.locator('.cm-content')).toContainText('export const a', { timeout: 10_000 });

  // 等价于点子窗关闭按钮(触发 beforeunload,dockview 据此收回面板);Playwright page.close() 不触发它。
  await electronApp.evaluate(({ BrowserWindow }) => {
    for (const w of BrowserWindow.getAllWindows()) if (w.webContents.getURL().includes('popout=1')) w.close();
  });
  await expect.poll(() => electronApp.windows().length).toBe(1);

  await expect(cm).toBeFocused({ timeout: 5_000 });
  await window.keyboard.press('ControlOrMeta+Home');
  await window.keyboard.type('X');
  await expect(window.locator('.cm-line').first()).toHaveText(/^Xexport const a/);
});

test('F6 到状态栏按钮:焦点环是 focus-ring 蓝(VSCode focusBorder),不是系统强调色', async ({ window }) => {
  await window.locator('text=src').first().click();
  await window.locator('text=a.ts').first().dblclick();
  await expect(window.locator('.cm-content')).toBeFocused({ timeout: 10_000 });

  await window.keyboard.press('F6');
  const focused = window.locator('footer[data-workbench-part="statusbar"] button:focus');
  await expect(focused).toHaveCount(1);
  // 按钮带 transition-colors(含 outline-color),轮询到过渡结束。
  await expect
    .poll(() =>
      focused.evaluate((el) => {
        const probe = document.createElement('span');
        probe.style.color = 'var(--md-focus-ring)';
        document.body.appendChild(probe);
        const ring = getComputedStyle(probe).color;
        probe.remove();
        const s = getComputedStyle(el);
        return `${s.outlineStyle} ${s.outlineColor}` === `solid ${ring}`;
      }),
    )
    .toBe(true);
});
