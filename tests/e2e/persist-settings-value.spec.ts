// settings.values 持久化:setValue → 关 → 重启同 userData → getValue 仍是新值.
import { expect, test } from '@playwright/test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { launchContinuo } from './helpers/launch';
import { waitForTestHooks } from './helpers/app-ready';

test('autoSave.delayMs=1500 → 关 → 重启 → getSettingValue 仍 1500', async () => {
  test.setTimeout(60_000);
  const ud = mkdtempSync(path.join(tmpdir(), 'continuo-settings-persist-'));
  try {
    // ── 第一次:setValue ──
    const app1 = await launchContinuo(ud);
    const win1 = await app1.firstWindow();
    await win1.waitForLoadState('domcontentloaded');
    await waitForTestHooks(win1);
    await win1.evaluate(() => {
      const t = globalThis.__continuoTest!;
      t.setSettingValue('autoSave.delayMs', 1500);
    });
    // 等 localStorage flush
    await win1.waitForTimeout(200);
    const stored = await win1.evaluate(() => localStorage.getItem('continuo.settings.values'));
    expect(stored).toContain('"autoSave.delayMs":1500');
    await app1.close();

    // ── 第二次:重启 ──
    const app2 = await launchContinuo(ud);
    const win2 = await app2.firstWindow();
    await win2.waitForLoadState('domcontentloaded');
    await waitForTestHooks(win2);

    const restored = await win2.evaluate(() => {
      const t = globalThis.__continuoTest!;
      return t.getSettingValue('autoSave.delayMs');
    });
    expect(restored).toBe(1500);

    await app2.close();
  } finally {
    rmSync(ud, { recursive: true, force: true });
  }
});
