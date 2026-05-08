// indentSize 通过 Settings UI input 改 → 立即 + 重启同 ud 仍生效.
import { _electron as electron, expect, test } from '@playwright/test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../..');
const MAIN_ENTRY = path.join(REPO_ROOT, 'out/main/index.js');

test('Settings 改 indentSize=24 → 重启 → padding 同步', async () => {
  test.setTimeout(60_000);
  const ud = mkdtempSync(path.join(tmpdir(), 'continuo-isp-'));
  const ws = mkdtempSync(path.join(tmpdir(), 'continuo-isp-ws-'));
  try {
    mkdirSync(path.join(ws, 'src'), { recursive: true });
    writeFileSync(path.join(ws, 'src/a.ts'), 'export\n');
    writeFileSync(
      path.join(ud, 'explorer.json'),
      JSON.stringify({
        version: 1,
        workspace: { root: ws, recentRoots: [ws] },
        explorer: {
          activePath: null,
          expandedPaths: [ws],
          sort: { by: 'name', reverse: false },
        },
        pinned: { paths: [] },
      }),
    );

    // 第一次:改 setting
    const app1 = await electron.launch({
      args: [MAIN_ENTRY, `--user-data-dir=${ud}`],
      env: { ...process.env, ELECTRON_DISABLE_GPU: '1', CONTINUO_E2E: '1' },
    });
    const win1 = await app1.firstWindow();
    await win1.waitForLoadState('domcontentloaded');

    await win1.locator('button[title="设置"]').click();
    await win1
      .locator('nav[aria-label="设置分类"]')
      .getByRole('button', { name: '资源管理器', exact: true })
      .click();
    const indentInput = win1.locator('input[type=number]').first();
    await expect(indentInput).toHaveValue('16');
    await indentInput.fill('24');
    await win1.waitForTimeout(300);
    await app1.close();

    // 第二次:重启同 ud
    const app2 = await electron.launch({
      args: [MAIN_ENTRY, `--user-data-dir=${ud}`],
      env: { ...process.env, ELECTRON_DISABLE_GPU: '1', CONTINUO_E2E: '1' },
    });
    const win2 = await app2.firstWindow();
    await win2.waitForLoadState('domcontentloaded');

    await win2.locator('text=src').first().click();
    await expect(win2.locator('text=a.ts').first()).toBeVisible({
      timeout: 10_000,
    });

    // src/a.ts level=1 → paddingLeft = 4 + 24 = 28px
    const aRow = win2
      .locator('[role=treeitem]')
      .filter({ hasText: /^a\.ts$/ })
      .first();
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
