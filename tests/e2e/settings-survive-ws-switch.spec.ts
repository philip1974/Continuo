// settings 是全局 localStorage,不随 ws 切重置.
import { expect, test } from '@playwright/test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { explorerMoreActionsButton } from './helpers/explorer';
import { launchContinuo } from './helpers/launch';
import { seedExplorerJson } from './helpers/seed-explorer';
import { waitForTestHooks } from './helpers/app-ready';

test('改 fontSize=18 + 切 ws → fontSize 仍 18', async () => {
  test.setTimeout(30_000);
  const ud = mkdtempSync(path.join(tmpdir(), 'continuo-sws-'));
  const ws1 = mkdtempSync(path.join(tmpdir(), 'continuo-sws-ws1-'));
  const ws2 = mkdtempSync(path.join(tmpdir(), 'continuo-sws-ws2-'));
  try {
    writeFileSync(path.join(ws1, 'README.md'), '# 1\n');
    writeFileSync(path.join(ws2, 'README.md'), '# 2\n');
    seedExplorerJson(ud, { root: ws1, recentRoots: [ws1, ws2] });

    const app = await launchContinuo(ud);
    const win = await app.firstWindow();
    await win.waitForLoadState('domcontentloaded');

    await waitForTestHooks(win);

    // 改 fontSize=18
    await win.evaluate(() => {
      const t = globalThis.__continuoTest!;
      t.setSettingValue('editor.fontSize', 18);
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

    // fontSize 仍 18
    const v = await win.evaluate(
      () =>
        globalThis.__continuoTest!.getSettingValue('editor.fontSize'),
    );
    expect(v).toBe(18);

    await app.close();
  } finally {
    rmSync(ws1, { recursive: true, force: true });
    rmSync(ws2, { recursive: true, force: true });
    rmSync(ud, { recursive: true, force: true });
  }
});
