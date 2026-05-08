// settings.values 持久化:setValue → 关 → 重启同 userData → getValue 仍是新值.
import { _electron as electron, expect, test } from '@playwright/test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../..');
const MAIN_ENTRY = path.join(REPO_ROOT, 'out/main/index.js');

test('autoSave.delayMs=42 → 关 → 重启 → getSettingValue 仍 42', async () => {
  test.setTimeout(60_000);
  const ud = mkdtempSync(path.join(tmpdir(), 'continuo-settings-persist-'));
  try {
    // ── 第一次:setValue ──
    const app1 = await electron.launch({
      args: [MAIN_ENTRY, `--user-data-dir=${ud}`],
      env: { ...process.env, ELECTRON_DISABLE_GPU: '1', CONTINUO_E2E: '1' },
    });
    const win1 = await app1.firstWindow();
    await win1.waitForLoadState('domcontentloaded');
    await win1.waitForFunction(
      () =>
        Boolean(
          (window as unknown as { __continuoTest?: unknown }).__continuoTest,
        ),
      { timeout: 5_000 },
    );
    await win1.evaluate(() => {
      const t = (
        window as unknown as {
          __continuoTest: {
            setSettingValue: (id: string, v: number) => void;
          };
        }
      ).__continuoTest;
      t.setSettingValue('autoSave.delayMs', 42);
    });
    // 等 localStorage flush
    await win1.waitForTimeout(200);
    const stored = await win1.evaluate(() =>
      localStorage.getItem('continuo.settings.values'),
    );
    expect(stored).toContain('"autoSave.delayMs":42');
    await app1.close();

    // ── 第二次:重启 ──
    const app2 = await electron.launch({
      args: [MAIN_ENTRY, `--user-data-dir=${ud}`],
      env: { ...process.env, ELECTRON_DISABLE_GPU: '1', CONTINUO_E2E: '1' },
    });
    const win2 = await app2.firstWindow();
    await win2.waitForLoadState('domcontentloaded');
    await win2.waitForFunction(
      () =>
        Boolean(
          (window as unknown as { __continuoTest?: unknown }).__continuoTest,
        ),
      { timeout: 5_000 },
    );

    const restored = await win2.evaluate(() => {
      const t = (
        window as unknown as {
          __continuoTest: { getSettingValue: (id: string) => unknown };
        }
      ).__continuoTest;
      return t.getSettingValue('autoSave.delayMs');
    });
    expect(restored).toBe(42);

    await app2.close();
  } finally {
    rmSync(ud, { recursive: true, force: true });
  }
});
