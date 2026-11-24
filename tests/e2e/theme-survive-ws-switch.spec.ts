// theme=light + 切 ws → html 仍不含 dark.
import { expect, test } from '@playwright/test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { explorerMoreActionsButton } from './helpers/explorer';
import { launchContinuo } from './helpers/launch';
import { seedExplorerJson } from './helpers/seed-explorer';
import { waitForTestHooks } from './helpers/app-ready';

test('theme=light + 切 ws → 仍 light', async () => {
  test.setTimeout(30_000);
  const ud = mkdtempSync(path.join(tmpdir(), 'continuo-tws-'));
  const ws1 = mkdtempSync(path.join(tmpdir(), 'continuo-tws-ws1-'));
  const ws2 = mkdtempSync(path.join(tmpdir(), 'continuo-tws-ws2-'));
  try {
    writeFileSync(path.join(ws1, 'a.md'), '# 1\n');
    writeFileSync(path.join(ws2, 'b.md'), '# 2\n');
    seedExplorerJson(ud, { root: ws1, recentRoots: [ws1, ws2] });

    const app = await launchContinuo(ud);
    const win = await app.firstWindow();
    await win.waitForLoadState('domcontentloaded');

    await waitForTestHooks(win);

    await win.evaluate(() => {
      const t = globalThis.__continuoTest!;
      t.setSettingValue('general.theme', 'light');
    });
    await expect(win.locator('html')).not.toHaveClass(/dark/, {
      timeout: 5_000,
    });

    // 切 ws
    await explorerMoreActionsButton(win).click();
    const ws2Name = path.basename(ws2);
    await win
      .getByRole('menu')
      .getByRole('menuitem', { name: ws2Name, exact: false })
      .click();
    // 确认 root 真的切到 ws2(否则后面「状态不变」的断言恒过)
    await expect(win.locator('main aside').nth(1).getByText(ws2Name).first()).toBeVisible({
      timeout: 10_000,
    });

    await expect(win.locator('html')).not.toHaveClass(/dark/);

    await app.close();
  } finally {
    rmSync(ws1, { recursive: true, force: true });
    rmSync(ws2, { recursive: true, force: true });
    rmSync(ud, { recursive: true, force: true });
  }
});
