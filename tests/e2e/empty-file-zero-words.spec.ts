// 空 file → footer 「0 词」.
import { statusWords } from './helpers/status-bar';
import { expect, test } from '@playwright/test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { launchContinuo } from './helpers/launch';

test('empty file → footer 显「0 词」', async () => {
  test.setTimeout(30_000);
  const ud = mkdtempSync(path.join(tmpdir(), 'continuo-zw-'));
  const ws = mkdtempSync(path.join(tmpdir(), 'continuo-zw-ws-'));
  try {
    writeFileSync(path.join(ws, 'empty2.txt'), '');
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
      }),
    );

    const app = await launchContinuo(ud);
    const win = await app.firstWindow();
    await win.waitForLoadState('domcontentloaded');

    await win.locator('text=empty2.txt').first().click();
    await expect(win.locator('header').first()).toContainText('empty2.txt', {
      timeout: 10_000,
    });

    await expect(win.locator('footer')).toContainText(statusWords(0));

    await app.close();
  } finally {
    rmSync(ws, { recursive: true, force: true });
    rmSync(ud, { recursive: true, force: true });
  }
});
