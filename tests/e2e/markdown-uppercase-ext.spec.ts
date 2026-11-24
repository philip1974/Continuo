// 大写 README.MD 扩展也走 markdown 模式(case-insensitive).
import { expect, test } from '@playwright/test';
import { EDITOR_MODE_PREVIEW } from './helpers/editor';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { launchContinuo } from './helpers/launch';
import { seedExplorerJson } from './helpers/seed-explorer';

test('NOTES.MD → SegmentedControl 显(大小写不敏感)', async () => {
  test.setTimeout(30_000);
  const ud = mkdtempSync(path.join(tmpdir(), 'continuo-mdup-'));
  const ws = mkdtempSync(path.join(tmpdir(), 'continuo-mdup-ws-'));
  try {
    writeFileSync(path.join(ws, 'NOTES.MD'), '# upper\n');
    seedExplorerJson(ud, { root: ws });

    const app = await launchContinuo(ud);
    const win = await app.firstWindow();
    await win.waitForLoadState('domcontentloaded');

    await win.locator('text=NOTES.MD').first().click();
    await expect(win.locator('header').first()).toContainText('NOTES.MD', {
      timeout: 10_000,
    });
    await expect(
      win.locator('main').locator('button').filter({ hasText: EDITOR_MODE_PREVIEW }),
    ).toBeVisible();

    await app.close();
  } finally {
    rmSync(ws, { recursive: true, force: true });
    rmSync(ud, { recursive: true, force: true });
  }
});
