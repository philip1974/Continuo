import { EDITOR_TAB, SETTINGS, SETTINGS_NAV } from './helpers/settings';
// lineNumbers UI toggle off → 重启同 ud → CM 含 cm-no-gutters.
import { expect, test } from '@playwright/test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openWorkspaceFile } from './helpers/editor';
import { launchContinuo } from './helpers/launch';
import { seedExplorerJson } from './helpers/seed-explorer';

function writeExplorerSeed(userDataDir: string, workspaceRoot: string): void {
  seedExplorerJson(userDataDir, { root: workspaceRoot });
}

test('toggle lineNumbers off → 重启 → CM 仍 cm-no-gutters', async () => {
  test.setTimeout(60_000);
  const ud = mkdtempSync(path.join(tmpdir(), 'continuo-lnp-'));
  const ws = mkdtempSync(path.join(tmpdir(), 'continuo-lnp-ws-'));
  try {
    mkdirSync(path.join(ws, 'src'), { recursive: true });
    writeFileSync(path.join(ws, 'src/a.ts'), 'export\n');
    writeExplorerSeed(ud, ws);

    // 第一次:toggle off
    const app1 = await launchContinuo(ud);
    const win1 = await app1.firstWindow();
    await win1.waitForLoadState('domcontentloaded');

    await win1.getByRole('button', { name: SETTINGS }).click();
    await win1
      .getByRole('navigation', { name: SETTINGS_NAV })
      .getByRole('button', { name: EDITOR_TAB })
      .click();
    const toggle = win1.locator('button[role=switch]').first();
    await expect(toggle).toHaveAttribute('aria-checked', 'true');
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-checked', 'false');
    await win1.waitForTimeout(200);
    await app1.close();
    writeExplorerSeed(ud, ws);

    // 第二次:reload
    const app2 = await launchContinuo(ud);
    const win2 = await app2.firstWindow();
    await win2.waitForLoadState('domcontentloaded');

    await openWorkspaceFile(win2, ['src', 'a.ts']);
    const cm = win2.locator('.cm-editor').first();
    await expect(cm).toBeVisible({ timeout: 10_000 });
    await expect(cm).toHaveClass(/cm-no-gutters/);

    await app2.close();
  } finally {
    rmSync(ws, { recursive: true, force: true });
    rmSync(ud, { recursive: true, force: true });
  }
});
