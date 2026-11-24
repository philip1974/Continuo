// 空 workspace 根 → FolderTree 显「读取中或空目录」placeholder.
import { expect, test } from '@playwright/test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { EXPLORER_LOADING_OR_EMPTY } from './helpers/explorer';
import { launchContinuo } from './helpers/launch';
import { seedExplorerJson } from './helpers/seed-explorer';

test('空 ws → 显「读取中或空目录」', async () => {
  test.setTimeout(30_000);
  const ud = mkdtempSync(path.join(tmpdir(), 'continuo-empty-place-'));
  const ws = mkdtempSync(path.join(tmpdir(), 'continuo-empty-place-ws-'));
  try {
    seedExplorerJson(ud, { root: ws });

    const app = await launchContinuo(ud);
    const win = await app.firstWindow();
    await win.waitForLoadState('domcontentloaded');

    await expect(win.getByText(EXPLORER_LOADING_OR_EMPTY)).toBeVisible({
      timeout: 10_000,
    });

    await app.close();
  } finally {
    rmSync(ws, { recursive: true, force: true });
    rmSync(ud, { recursive: true, force: true });
  }
});
