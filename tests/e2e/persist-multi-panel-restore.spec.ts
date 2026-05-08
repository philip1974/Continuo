// 加 Terminal panel + 重启 → Editor + Terminal 都恢复(layout.json 包含两个 panel).
import { _electron as electron, expect, test } from '@playwright/test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../..');
const MAIN_ENTRY = path.join(REPO_ROOT, 'out/main/index.js');

test('Editor + Terminal 双 panel 重启复原', async () => {
  const ud = mkdtempSync(path.join(tmpdir(), 'continuo-multi-restore-'));
  try {
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

    // 加 Terminal panel
    await win1.evaluate(() => {
      const t = (
        window as unknown as {
          __continuoTest: {
            openOrFocusPanel: (id: string, c: string, t: string) => void;
          };
        }
      ).__continuoTest;
      t.openOrFocusPanel('terminal', 'terminal', 'Terminal');
    });
    await expect(
      win1.locator('button[aria-label="新建终端"]'),
    ).toBeVisible({ timeout: 15_000 });

    // 等 layout.json 写盘
    await win1.waitForTimeout(800);
    await app1.close();

    // 重启
    const app2 = await electron.launch({
      args: [MAIN_ENTRY, `--user-data-dir=${ud}`],
      env: { ...process.env, ELECTRON_DISABLE_GPU: '1', CONTINUO_E2E: '1' },
    });
    const win2 = await app2.firstWindow();
    await win2.waitForLoadState('domcontentloaded');

    // Editor + Terminal 都仍在(close × 按钮 ≥ 2)
    await expect(
      win2.locator('button[aria-label^="Close"]'),
    ).toHaveCount(3, { timeout: 15_000 }); // 2 panel + 1 terminal session tab
    // Terminal panel UI 仍渲染
    await expect(
      win2.locator('button[aria-label="新建终端"]'),
    ).toBeVisible();
    // Editor SharedTab 仍在
    await expect(
      win2.locator('button[aria-label="Close Editor"]'),
    ).toBeVisible();

    await app2.close();
  } finally {
    rmSync(ud, { recursive: true, force: true });
  }
});
