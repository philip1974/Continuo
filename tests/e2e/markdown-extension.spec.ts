// .markdown 扩展也启 markdown 模式(SegmentedControl 显).
import { expect, test } from '@playwright/test';
import {
  EDITOR_MODE_EDIT,
  EDITOR_MODE_PREVIEW,
  EDITOR_MODE_SOURCE,
} from './helpers/editor';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { launchContinuo } from './helpers/launch';

test('打开 .markdown 文件 → SegmentedControl Edit/Source/Preview 显', async () => {
  test.setTimeout(30_000);
  const ud = mkdtempSync(path.join(tmpdir(), 'continuo-md-ext-'));
  const ws = mkdtempSync(path.join(tmpdir(), 'continuo-md-ext-ws-'));
  try {
    writeFileSync(path.join(ws, 'doc.markdown'), '# extension test\n');
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

    await win.locator('text=doc.markdown').first().click();
    await expect(win.locator('header').first()).toContainText(
      'doc.markdown',
      { timeout: 10_000 },
    );

    const main = win.locator('main');
    await expect(
      main.locator('button').filter({ hasText: EDITOR_MODE_EDIT }),
    ).toBeVisible();
    await expect(
      main.locator('button').filter({ hasText: EDITOR_MODE_SOURCE }),
    ).toBeVisible();
    await expect(
      main.locator('button').filter({ hasText: EDITOR_MODE_PREVIEW }),
    ).toBeVisible();

    await app.close();
  } finally {
    rmSync(ws, { recursive: true, force: true });
    rmSync(ud, { recursive: true, force: true });
  }
});
