// Quick Open walk 列出所有文件类型(.md / .ts / 无扩展等).
import { expect, test } from '@playwright/test';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openQuickOpen, quickOpenInput } from './helpers/palette';
import { launchContinuo } from './helpers/launch';
import { seedExplorerJson } from './helpers/seed-explorer';

test('walk 列出 .md / .ts / Makefile(无扩展)三种文件', async () => {
  const ud = mkdtempSync(path.join(tmpdir(), 'continuo-qo-mix-'));
  const ws = mkdtempSync(path.join(tmpdir(), 'continuo-qo-mix-ws-'));
  try {
    mkdirSync(path.join(ws, 'src'), { recursive: true });
    writeFileSync(path.join(ws, 'doc.md'), '# x');
    writeFileSync(path.join(ws, 'src/lib.ts'), '');
    writeFileSync(path.join(ws, 'Makefile'), 'all:\n');
    seedExplorerJson(ud, { root: ws });

    const app = await launchContinuo(ud);
    const win = await app.firstWindow();
    await win.waitForLoadState('domcontentloaded');

    await openQuickOpen(win);
    const input = quickOpenInput(win);
    await expect(input).toBeVisible();

    await expect(win.locator('.wm-modal-content')).toContainText('doc.md', {
      timeout: 10_000,
    });
    await expect(win.locator('.wm-modal-content')).toContainText('lib.ts');
    await expect(win.locator('.wm-modal-content')).toContainText('Makefile');

    await app.close();
  } finally {
    rmSync(ws, { recursive: true, force: true });
    rmSync(ud, { recursive: true, force: true });
  }
});
