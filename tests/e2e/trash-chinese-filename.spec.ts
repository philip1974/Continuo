// 中文文件名 trash → 文件被移走.
import { expect, test } from '@playwright/test';
import { EXPLORER_TRASH, confirmExplorerTrash } from './helpers/explorer';
import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { launchContinuo } from './helpers/launch';
import { seedExplorerJson } from './helpers/seed-explorer';

test('右键 中文文件 → trash → 不在', async () => {
  test.setTimeout(30_000);
  const ud = mkdtempSync(path.join(tmpdir(), 'continuo-trash-zh-'));
  const ws = mkdtempSync(path.join(tmpdir(), 'continuo-trash-zh-ws-'));
  try {
    writeFileSync(path.join(ws, '测试.txt'), 'x');
    seedExplorerJson(ud, { root: ws });

    const app = await launchContinuo(ud);
    const win = await app.firstWindow();
    await win.waitForLoadState('domcontentloaded');

    await win
      .locator('text=测试.txt')
      .first()
      .click({ button: 'right' });
    await win.getByRole('menuitem', { name: EXPLORER_TRASH }).click();
    await confirmExplorerTrash(win);

    await expect(async () => {
      let exists = true;
      try {
        statSync(path.join(ws, '测试.txt'));
      } catch {
        exists = false;
      }
      expect(exists).toBe(false);
    }).toPass({ timeout: 5_000 });

    await app.close();
  } finally {
    rmSync(ws, { recursive: true, force: true });
    rmSync(ud, { recursive: true, force: true });
  }
});
