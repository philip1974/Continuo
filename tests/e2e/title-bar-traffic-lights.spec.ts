// macOS 标题栏红绿灯留位(BDD: src/__tests__/title-bar/ 红绿灯留位):400 宽窗口的长标题左侧留足 80px,不进红绿灯区;
// 全屏(红绿灯隐藏)回到 48px,退出全屏恢复。
import { test, expect } from './fixtures/with-workspace';
import { openWorkspaceFile } from './helpers/editor';
import { writeFileSync } from 'node:fs';
import path from 'node:path';

test.skip(process.platform !== 'darwin', 'macOS 红绿灯');

test('400 宽长标题不压红绿灯;全屏 → 48px,退出 → 80px', async ({ window, electronApp, workspaceRoot }) => {
  test.setTimeout(60_000);
  const name = `${'AnExtremelyLongComponentFileName'.repeat(3)}.ts`;
  writeFileSync(path.join(workspaceRoot, name), 'x\n');
  await openWorkspaceFile(window, [name]);
  await electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setSize(400, 600));
  const title = window.locator('header [data-title-text]');
  const metrics = () =>
    title.evaluate((el) => ({
      padLeft: parseFloat(getComputedStyle(el).paddingLeft),
      padRight: parseFloat(getComputedStyle(el).paddingRight),
      left: el.getBoundingClientRect().left,
      truncated: el.scrollWidth > el.clientWidth,
    }));
  await expect.poll(async () => (await metrics()).padLeft).toBe(80);
  const m = await metrics();
  expect(m.padRight).toBe(80);
  expect(m.left + m.padLeft).toBeGreaterThanOrEqual(80);
  expect(m.truncated).toBe(true);

  await electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setFullScreen(true));
  await expect.poll(async () => (await metrics()).padLeft, { timeout: 15_000 }).toBe(48);
  await electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setFullScreen(false));
  await expect.poll(async () => (await metrics()).padLeft, { timeout: 15_000 }).toBe(80);
});
