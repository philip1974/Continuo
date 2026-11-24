// workspace path 含空格 → 加载 + tree + Cmd+P 都正常.  @edge
import { expect, test } from '@playwright/test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openQuickOpen, quickOpenInput } from './helpers/palette';
import { launchContinuo } from './helpers/launch';

test('ws path 含空格 → 正常', async () => {
  test.setTimeout(30_000);
  const ud = mkdtempSync(path.join(tmpdir(), 'continuo-sp-'));
  // path with space
  const parent = mkdtempSync(path.join(tmpdir(), 'continuo-sp-parent-'));
  const ws = path.join(parent, 'with space ws');
  mkdirSync(ws, { recursive: true });
  try {
    writeFileSync(path.join(ws, 'README.md'), '# x\n');
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

    // tree 渲
    await expect(win.locator('text=README.md').first()).toBeVisible({
      timeout: 10_000,
    });

    await openQuickOpen(win);
    await expect(quickOpenInput(win)).toBeVisible();
    await expect(win.locator('.wm-modal-content')).toContainText(
      'README.md',
      { timeout: 10_000 },
    );

    await app.close();
  } finally {
    rmSync(parent, { recursive: true, force: true });
    rmSync(ud, { recursive: true, force: true });
  }
});
