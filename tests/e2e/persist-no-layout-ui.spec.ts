// 老版本 explorer.json 缺 layoutUi 字段(向下兼容)→ 用 store 默认值
// (sidebarOpen=true, sidebarWidth=280).
import { expect, test } from '@playwright/test';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { waitForAppReady } from './helpers/app-ready';
import { explorerTreeItem } from './helpers/explorer';
import { launchContinuo } from './helpers/launch';
import { seedExplorerJson } from './helpers/seed-explorer';

test('explorer.json 缺 layoutUi → sidebarOpen=true + width=280(默认)', async () => {
  const ud = mkdtempSync(path.join(tmpdir(), 'continuo-no-lui-'));
  const ws = mkdtempSync(path.join(tmpdir(), 'continuo-no-lui-ws-'));
  try {
    mkdirSync(path.join(ws, 'src'), { recursive: true });
    writeFileSync(path.join(ws, 'README.md'), '# x\n');
    // 不写 layoutUi 字段
    seedExplorerJson(ud, { root: ws });

    const app = await launchContinuo(ud);
    const win = await app.firstWindow();
    await win.waitForLoadState('domcontentloaded');

    // 先等就绪并等 README.md 出现(hydrate 已把 root / layoutUi 兼容分支落到 store),再断言默认值;
    // 否则 store 初值本身就是 open + 280,首帧即恒真。
    await waitForAppReady(win);
    await expect(explorerTreeItem(win, /^README\.md$/)).toBeVisible({ timeout: 10_000 });
    // sidebar 默认 open + width 280
    const sidebar = win.locator('main aside').nth(1);
    await expect(sidebar).toBeVisible();
    await expect
      .poll(async () =>
        sidebar.evaluate((el: HTMLElement) => el.style.width),
      )
      .toBe('280px');

    await app.close();
  } finally {
    rmSync(ws, { recursive: true, force: true });
    rmSync(ud, { recursive: true, force: true });
  }
});
