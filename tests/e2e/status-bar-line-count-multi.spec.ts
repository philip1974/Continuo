// 含多行的 file → footer 行数 = 实际行数.
import { expect, test } from '@playwright/test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openTreeItem } from './helpers/explorer';
import { statusLines } from './helpers/status-bar';
import { launchContinuo } from './helpers/launch';
import { seedExplorerJson } from './helpers/seed-explorer';

test('多行 file → footer N 行计数正确', async () => {
  test.setTimeout(30_000);
  const ud = mkdtempSync(path.join(tmpdir(), 'continuo-lc-'));
  const ws = mkdtempSync(path.join(tmpdir(), 'continuo-lc-ws-'));
  try {
    // 5 行(4 个 \n + 末尾 \n)
    writeFileSync(path.join(ws, 'multi.txt'), 'a\nb\nc\nd\ne\n');
    seedExplorerJson(ud, { root: ws });

    const app = await launchContinuo(ud);
    const win = await app.firstWindow();
    await win.waitForLoadState('domcontentloaded');

    await openTreeItem(win, /^multi\.txt$/);
    await expect(win.locator('header').first()).toContainText('multi.txt', {
      timeout: 10_000,
    });

    // computeTextStats 的 lines = 换行数 + 1,与 split('\n').length 等价。'a\nb\nc\nd\ne\n'.split('\n') = 6 段(末尾 \n 后空段)
    const footer = win.locator('footer');
    await expect(footer).toContainText(statusLines(6));

    await app.close();
  } finally {
    rmSync(ws, { recursive: true, force: true });
    rmSync(ud, { recursive: true, force: true });
  }
});
