// BOM(﻿)开头的 file → 打开不崩.  @edge
import { expect, test } from '@playwright/test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { launchContinuo } from './helpers/launch';

test('BOM file → 打开 + CodeMirror 渲', async () => {
  test.setTimeout(30_000);
  const ud = mkdtempSync(path.join(tmpdir(), 'continuo-bom-'));
  const ws = mkdtempSync(path.join(tmpdir(), 'continuo-bom-ws-'));
  try {
    writeFileSync(path.join(ws, 'bom.txt'), '﻿hello\n');
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

    await win.locator('text=bom.txt').first().click();
    await expect(win.locator('header').first()).toContainText('bom.txt', {
      timeout: 10_000,
    });
    await expect(win.locator('.cm-content').first()).toBeVisible();
    await expect(win.locator('.cm-content').first()).toContainText('hello');

    await app.close();
  } finally {
    rmSync(ws, { recursive: true, force: true });
    rmSync(ud, { recursive: true, force: true });
  }
});
