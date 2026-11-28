import { EXPLORER_TAB, SETTINGS, SETTINGS_NAV, settingNumberInput } from './helpers/settings';
// indentSize 通过 Settings UI input 改 → 立即 + 重启同 ud 仍生效.
import { expect, test } from '@playwright/test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openWorkspaceFile } from './helpers/editor';
import { explorerTreeItem } from './helpers/explorer';
import { launchContinuo } from './helpers/launch';
import { seedExplorerJson } from './helpers/seed-explorer';

function writeExplorerSeed(userDataDir: string, workspaceRoot: string): void {
  seedExplorerJson(userDataDir, { root: workspaceRoot });
}

test('Settings 改 indentSize=24 → 重启 → padding 同步', async () => {
  test.setTimeout(60_000);
  const ud = mkdtempSync(path.join(tmpdir(), 'continuo-isp-'));
  const ws = mkdtempSync(path.join(tmpdir(), 'continuo-isp-ws-'));
  try {
    mkdirSync(path.join(ws, 'src'), { recursive: true });
    writeFileSync(path.join(ws, 'src/a.ts'), 'export\n');
    writeExplorerSeed(ud, ws);

    // 第一次:改 setting
    const app1 = await launchContinuo(ud);
    const win1 = await app1.firstWindow();
    await win1.waitForLoadState('domcontentloaded');

    await win1.getByRole('button', { name: SETTINGS }).click();
    await win1
      .getByRole('navigation', { name: SETTINGS_NAV })
      .getByRole('button', { name: EXPLORER_TAB })
      .click();
    const indentInput = settingNumberInput(win1, 'explorer.indentSize');
    await expect(indentInput).toHaveValue('16');
    await indentInput.fill('24');
    await win1.waitForTimeout(300);
    await app1.close();
    writeExplorerSeed(ud, ws);

    // 第二次:重启同 ud
    const app2 = await launchContinuo(ud);
    const win2 = await app2.firstWindow();
    await win2.waitForLoadState('domcontentloaded');

    await openWorkspaceFile(win2, ['src', 'a.ts']);

    // src/a.ts level=1 → paddingLeft = 4 + 24 = 28px
    const aRow = explorerTreeItem(win2, /^a\.ts$/);
    const paddingLeft = await aRow.evaluate((el) => {
      const inner = el.querySelector<HTMLElement>('[style*="padding-left"]');
      return inner ? inner.style.paddingLeft : (el as HTMLElement).style.paddingLeft;
    });
    expect(paddingLeft).toBe('28px');

    await app2.close();
  } finally {
    rmSync(ws, { recursive: true, force: true });
    rmSync(ud, { recursive: true, force: true });
  }
});
