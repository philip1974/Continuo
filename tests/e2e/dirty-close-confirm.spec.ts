// 真实 Electron 下的关窗未保存确认(单元规范见 src/__tests__/dirty-close-confirm/,那里 electron 全 mock)。
// 原生 messageBox 无法由 Playwright 点击 → 在 main 里替换 dialog.showMessageBox 记录调用并按需应答:
//   1. 改脏 a.ts → 关窗 → 确认框被调用(1 个脏文件时标题写文件名),选「取消」→ 窗口保持打开、tab 仍 dirty
//   2. 再关窗选「不保存」→ 窗口关闭

import { test, expect } from './fixtures/with-workspace';
import { EDITOR_UNSAVED_CHANGES_SELECTOR } from './helpers/editor';

test('改脏 a.ts → 关窗弹确认:取消保持打开,不保存则关闭', async ({ electronApp, window }) => {
  await window.locator('text=src').first().click();
  await window.locator('text=a.ts').first().click();
  const cm = window.locator('.cm-content');
  await expect(cm).toBeVisible({ timeout: 10_000 });
  await cm.click();
  await window.keyboard.type(' // dirty');
  await expect(window.locator(EDITOR_UNSAVED_CHANGES_SELECTOR)).toBeVisible({ timeout: 5_000 });

  // 按钮下标:0 保存 / 1 不保存 / 2 取消(electron/main/dirty-close-confirm.ts)。
  const stubDialog = (response: number) =>
    electronApp.evaluate(({ dialog }, r) => {
      const g = globalThis as unknown as { __dirtyCloseCalls?: string[] };
      g.__dirtyCloseCalls = [];
      dialog.showMessageBox = (async (...args: unknown[]) => {
        const opts = args.find((a) => a && typeof a === 'object' && 'buttons' in (a as object)) as
          | { message?: string; detail?: string }
          | undefined;
        g.__dirtyCloseCalls!.push(`${opts?.message ?? ''}\n${opts?.detail ?? ''}`);
        return { response: r, checkboxChecked: false };
      }) as unknown as typeof dialog.showMessageBox;
    }, response);
  const calls = () =>
    electronApp.evaluate(
      () => (globalThis as unknown as { __dirtyCloseCalls?: string[] }).__dirtyCloseCalls ?? [],
    );
  const closeWindow = () =>
    electronApp.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0]?.close();
    });
  const windowCount = () =>
    electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length);

  // 脏态上报是异步 IPC:等它到达 main 再关窗(否则 main 认为无脏文件直接关)。
  await stubDialog(2);
  await expect
    .poll(
      async () => {
        await closeWindow();
        return (await calls()).length;
      },
      { timeout: 10_000 },
    )
    .toBeGreaterThan(0);
  // 只有 1 个脏文件 → 标题写文件名(panels.editor.save_changes_title 三语)
  expect((await calls())[0]).toMatch(/(对「a\.ts」|made to a\.ts\?|a\.ts의)/);
  // 取消 → 窗口仍在、内容仍 dirty。
  expect(await windowCount()).toBe(1);
  await expect(window.locator(EDITOR_UNSAVED_CHANGES_SELECTOR)).toBeVisible();

  // 不保存 → 窗口关闭。
  await stubDialog(1);
  await closeWindow();
  await expect.poll(windowCount, { timeout: 15_000 }).toBe(0);
});
