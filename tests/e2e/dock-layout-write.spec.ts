// dockview layout 写盘:加 panel → debounce 300ms → layout.json 验证.
import { _electron as electron, expect, test } from '@playwright/test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../..');
const MAIN_ENTRY = path.join(REPO_ROOT, 'out/main/index.js');

test('加 Terminal panel → 等 debounce → layout.json 含 terminal panel id', async () => {
  const ud = mkdtempSync(path.join(tmpdir(), 'continuo-layout-write-'));
  try {
    const app = await electron.launch({
      args: [MAIN_ENTRY, `--user-data-dir=${ud}`],
      env: { ...process.env, ELECTRON_DISABLE_GPU: '1', CONTINUO_E2E: '1' },
    });
    const win = await app.firstWindow();
    await win.waitForLoadState('domcontentloaded');

    // 通过 testing hook 加 Terminal panel
    await win.waitForFunction(
      () =>
        Boolean(
          (window as unknown as { __continuoTest?: unknown }).__continuoTest,
        ),
      { timeout: 5_000 },
    );
    await win.evaluate(() => {
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
      win.locator('button[aria-label="新建终端"]'),
    ).toBeVisible({ timeout: 15_000 });

    await win.waitForTimeout(800);

    const raw = readFileSync(path.join(ud, 'layout.json'), 'utf8');
    expect(raw).toContain('terminal');
    expect(raw).toContain('editor');

    await app.close();
  } finally {
    rmSync(ud, { recursive: true, force: true });
  }
});
