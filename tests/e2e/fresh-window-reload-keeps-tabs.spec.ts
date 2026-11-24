// fresh 是一次性启动参数:用户显式开出的新窗口(URL 带 fresh=1)刷新后按本窗段恢复,
// 不再被当成新窗口覆盖本窗段(编辑器 tab 全丢、root 回退)。
// 真实链路:open-file → openWorkspaceWindowWith(fresh)→ renderer 消费后 replaceState 去掉 fresh →
// webContents.reload()(View → Reload 确认 + flush 后的最后一步)→ 按去参后的 URL 重新加载。
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test, expect } from './fixtures/with-workspace';
import { waitForAppReady } from './helpers/app-ready';
import { editorTab, openWorkspaceFile } from './helpers/editor';

test('fresh 开的新窗口开文件后刷新,编辑器 tab 仍在', async ({
  window,
  electronApp,
  workspaceRoot,
  userDataDir,
}) => {
  test.setTimeout(60_000);
  await waitForAppReady(window);

  const newWindow = electronApp.waitForEvent('window');
  // e2e 下应用菜单被禁用(见 main whenReady),走同为 fresh 开窗的 macOS open-file(拖文件夹到 Dock)入口。
  await electronApp.evaluate(({ app }, dir) => {
    app.emit('open-file', { preventDefault: () => {} }, dir);
  }, workspaceRoot);
  const page = await newWindow;
  await page.waitForLoadState('domcontentloaded');
  await waitForAppReady(page);

  // renderer 消费后 fresh 已不在地址里,windowSeq / workspace 保留。
  const params = new URL(page.url()).searchParams;
  expect(params.has('fresh')).toBe(false);
  expect(params.get('workspace')).toBe(workspaceRoot);
  const windowSeq = params.get('windowSeq');
  expect(windowSeq).not.toBeNull();

  await openWorkspaceFile(page, ['src', 'a.ts']);
  await expect(editorTab(page, 'a.ts')).toBeVisible({ timeout: 10_000 });

  // 旧文档打标记(刷新后消失),用于确认刷新真正发生。
  await page.evaluate(() => {
    (window as unknown as { __beforeReload?: boolean }).__beforeReload = true;
  });
  // 菜单 Reload 在刷新前 flush;e2e 无菜单,改为等防抖写盘把本窗段(含 a.ts)落盘后直接 reload。
  await expect
    .poll(
      () => {
        try {
          const snap = JSON.parse(readFileSync(path.join(userDataDir, 'explorer.json'), 'utf8')) as {
            windows?: { windowSeq: number; editor?: { openFilePaths?: string[] } }[];
          };
          const mine = snap.windows?.find((w) => String(w.windowSeq) === windowSeq);
          return mine?.editor?.openFilePaths ?? [];
        } catch {
          return [];
        }
      },
      { timeout: 10_000 },
    )
    .toContain(path.join(workspaceRoot, 'src', 'a.ts'));
  await electronApp.evaluate(({ BrowserWindow }, seq) => {
    const win = BrowserWindow.getAllWindows().find(
      (w) => new URL(w.webContents.getURL()).searchParams.get('windowSeq') === seq,
    );
    if (!win) throw new Error('new window not found');
    win.webContents.reload();
  }, windowSeq!);

  // 等刷新真正发生:旧文档的标记消失后再断言恢复结果。
  await page.waitForFunction(
    () => !(window as unknown as { __beforeReload?: boolean }).__beforeReload,
    undefined,
    { timeout: 15_000 },
  );
  await page.waitForLoadState('domcontentloaded');
  await waitForAppReady(page);

  expect(new URL(page.url()).searchParams.has('fresh')).toBe(false);
  await expect(editorTab(page, 'a.ts')).toBeVisible({ timeout: 10_000 });
});
