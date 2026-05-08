// dockview layout 持久化:加 Terminal panel → 关 → 重启 → Terminal 仍在.
import { _electron as electron, expect, test } from '@playwright/test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../..');
const MAIN_ENTRY = path.join(REPO_ROOT, 'out/main/index.js');

test('加 Terminal panel → 关 → 重启同 userData → Terminal panel 仍在', async () => {
  const ud = mkdtempSync(path.join(tmpdir(), 'continuo-dock-'));
  try {
    // ── 第一次启动:加 Terminal panel ──
    const app1 = await electron.launch({
      args: [MAIN_ENTRY, `--user-data-dir=${ud}`],
      env: { ...process.env, ELECTRON_DISABLE_GPU: '1', CONTINUO_E2E: '1' },
    });
    const win1 = await app1.firstWindow();
    await win1.waitForLoadState('domcontentloaded');

    // 等 testing hook 挂载
    await win1.waitForFunction(
      () =>
        Boolean(
          (window as unknown as { __continuoTest?: unknown })
            .__continuoTest,
        ),
      { timeout: 5_000 },
    );

    // 通过 testing hook 加 Terminal panel
    await win1.evaluate(() => {
      const helper = (
        window as unknown as {
          __continuoTest: {
            openOrFocusPanel: (id: string, c: string, t: string) => void;
          };
        }
      ).__continuoTest;
      helper.openOrFocusPanel('terminal', 'terminal', 'Terminal');
    });

    await expect(
      win1.locator('button[aria-label="新建终端"]'),
    ).toBeVisible({ timeout: 15_000 });

    // 等 layout-persist debounce 写盘(layout:write IPC,~300ms debounce)
    await win1.waitForTimeout(800);
    await app1.close();

    // ── 第二次启动:Terminal panel 仍在 ──
    const app2 = await electron.launch({
      args: [MAIN_ENTRY, `--user-data-dir=${ud}`],
      env: { ...process.env, ELECTRON_DISABLE_GPU: '1', CONTINUO_E2E: '1' },
    });
    const win2 = await app2.firstWindow();
    await win2.waitForLoadState('domcontentloaded');

    // Terminal panel UI 仍渲染
    await expect(
      win2.locator('button[aria-label="新建终端"]'),
    ).toBeVisible({ timeout: 15_000 });

    await app2.close();
  } finally {
    rmSync(ud, { recursive: true, force: true });
  }
});
