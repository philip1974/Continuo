// 安全 L1:页面内容不能借「打开新窗口」开出带完整 preload、以任意目录为根的应用窗口。
//  - renderer:Markdown 只读预览里中键点链接(Chromium 只发 auxclick,默认「后台标签打开」→ windowOpenHandler)
//    被 MilkdownEditor 吞掉,按左键语义交给 resolveLink;
//  - main:windowOpenHandler 只放行 query 恰好为 popout=1 的本应用入口,带 workspace / fresh / windowSeq 的拒绝。
// 真实 Chromium 行为(中键 → auxclick → window open 请求)只有 e2e 能覆盖。
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { test, expect } from './fixtures/with-workspace';
import { EDITOR_MODE_PREVIEW, editorModeButton, openWorkspaceFile } from './helpers/editor';

function hostileEntryUrl(appUrl: string): string {
  const u = new URL(appUrl);
  u.search = '?workspace=%2F&fresh=1&windowSeq=0';
  u.hash = '';
  return u.toString();
}

// popout-entry 是 main 会放行的形态(query 只有 popout=1):它不开窗才证明 renderer 一层独立生效;
// evil-entry 是攻击载荷本身(两层任一生效即不开窗)。
test('Preview:中键点指向本应用入口的链接不开新窗口,窗口也不被导航走', async ({
  window,
  electronApp,
  workspaceRoot,
}) => {
  await expect(window.locator('main')).toBeVisible({ timeout: 10_000 });
  const appUrl = window.url();
  const popoutEntry = new URL(appUrl);
  popoutEntry.search = '?popout=1';
  popoutEntry.hash = '';
  writeFileSync(
    path.join(workspaceRoot, 'mid.md'),
    `[evil-entry](${hostileEntryUrl(appUrl)})\n\n[popout-entry](${popoutEntry.toString()})\n`,
  );
  await openWorkspaceFile(window, ['mid.md']);
  await editorModeButton(window, EDITOR_MODE_PREVIEW).click();

  for (const text of ['evil-entry', 'popout-entry']) {
    const link = window.locator('main .milkdown a', { hasText: text });
    await expect(link).toBeVisible({ timeout: 10_000 });
    const box = (await link.boundingBox())!;
    const x = Math.round(box.x + box.width / 2);
    const y = Math.round(box.y + box.height / 2);
    await electronApp.evaluate(
      ({ BrowserWindow }, pos) => {
        const wc = BrowserWindow.getAllWindows()[0]!.webContents;
        wc.sendInputEvent({ type: 'mouseDown', x: pos.x, y: pos.y, button: 'middle', clickCount: 1 });
        wc.sendInputEvent({ type: 'mouseUp', x: pos.x, y: pos.y, button: 'middle', clickCount: 1 });
      },
      { x, y },
    );
    await window.waitForTimeout(1_000);
    expect(
      await electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length),
      text,
    ).toBe(1);
    expect(window.url()).toBe(appUrl);
  }
});

test('main 兜底:window.open 本应用入口带 workspace / fresh / windowSeq 被拒,纯 popout URL 照常放行', async ({
  window,
  electronApp,
}) => {
  await expect(window.locator('main')).toBeVisible({ timeout: 10_000 });
  const appUrl = window.url();
  const count = (): Promise<number> =>
    electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length);

  const opened = await window.evaluate((u) => self.open(u) !== null, hostileEntryUrl(appUrl));
  expect(opened).toBe(false);
  await window.waitForTimeout(500);
  expect(await count()).toBe(1);

  // 回归:popout 形态(query 恰好只有 popout=1)仍放行
  const popout = new URL(appUrl);
  popout.search = '?popout=1';
  popout.hash = '';
  const child = await window.evaluate((u) => {
    const w = self.open(u);
    (globalThis as unknown as { __child?: Window | null }).__child = w;
    return w !== null;
  }, popout.toString());
  expect(child).toBe(true);
  await expect.poll(count).toBe(2);
  await window.evaluate(() => (globalThis as unknown as { __child?: Window | null }).__child?.close());
  await expect.poll(count).toBe(1);
});
