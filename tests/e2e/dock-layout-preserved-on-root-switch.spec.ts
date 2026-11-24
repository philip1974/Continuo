// 切 workspace root → dock 中已开 panel 不被重置.
import { expect, test } from '@playwright/test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { explorerMoreActionsButton } from './helpers/explorer';
import { OUTPUT_EMPTY } from './helpers/output';
import { launchContinuo } from './helpers/launch';
import { seedExplorerJson } from './helpers/seed-explorer';
import { waitForTestHooks } from './helpers/app-ready';

test('打开 Output → 切 root → Output panel 仍在', async () => {
  test.setTimeout(60_000);
  const ud = mkdtempSync(path.join(tmpdir(), 'continuo-dock-rs-'));
  const ws1 = mkdtempSync(path.join(tmpdir(), 'continuo-dock-rs-ws1-'));
  const ws2 = mkdtempSync(path.join(tmpdir(), 'continuo-dock-rs-ws2-'));
  try {
    writeFileSync(path.join(ws1, 'README.md'), '# 1\n');
    writeFileSync(path.join(ws2, 'README.md'), '# 2\n');
    seedExplorerJson(ud, { root: ws1, recentRoots: [ws1, ws2] });

    const app = await launchContinuo(ud);
    const win = await app.firstWindow();
    await win.waitForLoadState('domcontentloaded');
    await expect(explorerMoreActionsButton(win)).toBeVisible({
      timeout: 10_000,
    });

    // 打开 Output panel
    await waitForTestHooks(win);
    // testing hook 可能先于 dock 就绪暴露(openOrFocusPanel 此时 no-op):重试到面板出现
    await expect(async () => {
      await win.evaluate(() => {
        const t = globalThis.__continuoTest!;
        t.openOrFocusPanel('output', 'output', 'Output');
      });
      await expect(win.getByText(OUTPUT_EMPTY)).toBeVisible({ timeout: 2_000 });
    }).toPass({ timeout: 20_000 });

    // 切 root
    const wsName2 = path.basename(ws2);
    await explorerMoreActionsButton(win).click();
    await win.getByRole('menuitem', { name: wsName2, exact: false }).click();

    // 先确认 root 真的切到 ws2(Explorer 显示 ws2 名),再确认 Output panel 仍在
    await expect(
      win.locator('main aside').nth(1).getByText(wsName2).first(),
    ).toBeVisible({ timeout: 10_000 });
    await expect(win.getByText(OUTPUT_EMPTY)).toBeVisible({
      timeout: 5_000,
    });

    await app.close();
  } finally {
    rmSync(ws1, { recursive: true, force: true });
    rmSync(ws2, { recursive: true, force: true });
    rmSync(ud, { recursive: true, force: true });
  }
});
