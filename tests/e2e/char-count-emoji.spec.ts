// computeTextStats().chars 用 s.length(UTF-16 code unit)→ '🌍' = 2 字符.
import { statusChars } from './helpers/status-bar';
import { expect, test } from '@playwright/test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { launchContinuo } from './helpers/launch';

test('🌍 file → footer 显 2 chars(UTF-16 代码单元)', async () => {
  test.setTimeout(30_000);
  const ud = mkdtempSync(path.join(tmpdir(), 'continuo-emoji-'));
  const ws = mkdtempSync(path.join(tmpdir(), 'continuo-emoji-ws-'));
  try {
    writeFileSync(path.join(ws, 'emoji.txt'), '🌍');
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

    await win.locator('text=emoji.txt').first().click();
    await expect(win.locator('header').first()).toContainText('emoji.txt', {
      timeout: 10_000,
    });

    const footer = win.locator('footer');
    // '🌍'.length === 2(UTF-16)
    await expect(footer).toContainText(statusChars(2));

    await app.close();
  } finally {
    rmSync(ws, { recursive: true, force: true });
    rmSync(ud, { recursive: true, force: true });
  }
});
