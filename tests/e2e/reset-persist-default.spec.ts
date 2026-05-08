// 改 → reset → 重启 → input 仍 default(13).
import { _electron as electron, expect, test } from '@playwright/test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../..');
const MAIN_ENTRY = path.join(REPO_ROOT, 'out/main/index.js');

test('改 → reset → 重启同 ud → fontSize input 仍 13', async () => {
  test.setTimeout(60_000);
  const ud = mkdtempSync(path.join(tmpdir(), 'continuo-rstp-'));
  try {
    const app1 = await electron.launch({
      args: [MAIN_ENTRY, `--user-data-dir=${ud}`],
      env: { ...process.env, ELECTRON_DISABLE_GPU: '1', CONTINUO_E2E: '1' },
    });
    const win1 = await app1.firstWindow();
    await win1.waitForLoadState('domcontentloaded');

    await win1.locator('button[title="设置"]').click();
    await win1
      .locator('nav[aria-label="设置分类"]')
      .getByRole('button', { name: '编辑器', exact: true })
      .click();

    const fi1 = win1.locator('input[type=number]').first();
    await fi1.fill('20');
    await win1.waitForTimeout(150);
    await win1.evaluate(() => {
      const btn = Array.from(
        document.querySelectorAll<HTMLButtonElement>(
          'button[aria-label="恢复默认"]',
        ),
      ).find((b) => !b.className.includes('invisible'));
      btn?.click();
    });
    await expect(fi1).toHaveValue('13');
    await win1.waitForTimeout(200);
    await app1.close();

    // reload
    const app2 = await electron.launch({
      args: [MAIN_ENTRY, `--user-data-dir=${ud}`],
      env: { ...process.env, ELECTRON_DISABLE_GPU: '1', CONTINUO_E2E: '1' },
    });
    const win2 = await app2.firstWindow();
    await win2.waitForLoadState('domcontentloaded');

    await win2.locator('button[title="设置"]').click();
    await win2
      .locator('nav[aria-label="设置分类"]')
      .getByRole('button', { name: '编辑器', exact: true })
      .click();
    await expect(win2.locator('input[type=number]').first()).toHaveValue('13');
    await app2.close();
  } finally {
    rmSync(ud, { recursive: true, force: true });
  }
});
