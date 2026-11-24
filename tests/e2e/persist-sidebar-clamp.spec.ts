// sidebarWidth 超出 [200, 500] → clamp 到边界(由 explorer-persist hydrate 时
// clampWidth 处理).
import { expect, test } from '@playwright/test';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { launchContinuo } from './helpers/launch';

async function setupAndCheck(
  storedWidth: number,
  expectedWidth: string,
): Promise<void> {
  const ud = mkdtempSync(path.join(tmpdir(), 'continuo-sb-clamp-'));
  const ws = mkdtempSync(path.join(tmpdir(), 'continuo-sb-clamp-ws-'));
  try {
    mkdirSync(path.join(ws, 'src'), { recursive: true });
    writeFileSync(path.join(ws, 'README.md'), '# x\n');
    writeFileSync(
      path.join(ud, 'explorer.json'),
      JSON.stringify({
        version: 1,
        workspace: { root: ws, recentRoots: [ws] },
        explorer: {
          activePath: null,
          expandedPaths: [ws],
          sort: { by: 'name', reverse: false },
        },
        pinned: { paths: [] },
        layoutUi: { sidebarOpen: true, sidebarWidth: storedWidth },
      }),
    );

    const app = await launchContinuo(ud);
    const win = await app.firstWindow();
    await win.waitForLoadState('domcontentloaded');

    const sidebar = win.locator('main aside').nth(1);
    await expect(sidebar).toBeVisible();
    await expect
      .poll(async () =>
        sidebar.evaluate((el: HTMLElement) => el.style.width),
      )
      .toBe(expectedWidth);

    await app.close();
  } finally {
    rmSync(ws, { recursive: true, force: true });
    rmSync(ud, { recursive: true, force: true });
  }
}

test('sidebarWidth=99999 → clamp 到 max=500', async () => {
  await setupAndCheck(99999, '500px');
});

test('sidebarWidth=10 → clamp 到 min=200', async () => {
  await setupAndCheck(10, '200px');
});

test('sidebarWidth=300(范围内)→ 保留', async () => {
  await setupAndCheck(300, '300px');
});
