// 主题切换持久化:set light → 关 app → 同 userDataDir 重启 → 仍 light.
//
// 默认 fixture 每个 spec 启全新 app + 用 afterEach 删 userDataDir。
// 这里手动管 userDataDir + 启两次 Electron,验证 theme 持久化.

import { _electron as electron, expect, test } from '@playwright/test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../..');
const MAIN_ENTRY = path.join(REPO_ROOT, 'out/main/index.js');

test('theme=light 持久化:重启同 userData 仍 light', async () => {
  const ud = mkdtempSync(path.join(tmpdir(), 'continuo-theme-persist-'));
  try {
    // ── 第一次启动 ──
    const app1 = await electron.launch({
      args: [MAIN_ENTRY, `--user-data-dir=${ud}`],
      env: { ...process.env, ELECTRON_DISABLE_GPU: '1', CONTINUO_E2E: '1' },
    });
    const win1 = await app1.firstWindow();
    await win1.waitForLoadState('domcontentloaded');

    // 默认 dark
    await expect(win1.locator('html')).toHaveClass(/dark/);

    // 改成 light(通过 SettingsPanel)
    await win1.locator('button[title="设置"]').click();
    await expect(win1.locator('nav[aria-label="设置分类"]')).toBeVisible({
      timeout: 10_000,
    });
    const lightBtn = win1
      .locator('button, [role=tab]')
      .filter({ hasText: /^Light$/i });
    await lightBtn.first().click();
    await expect(win1.locator('html')).not.toHaveClass(/dark/);

    // localStorage 通常 main 进程关闭前已 sync flush;给 Chromium 一点时间
    await win1.waitForTimeout(300);

    await app1.close();

    // ── 第二次启动同 userData ──
    const app2 = await electron.launch({
      args: [MAIN_ENTRY, `--user-data-dir=${ud}`],
      env: { ...process.env, ELECTRON_DISABLE_GPU: '1', CONTINUO_E2E: '1' },
    });
    const win2 = await app2.firstWindow();
    await win2.waitForLoadState('domcontentloaded');

    // 重启后仍 light
    await expect(win2.locator('html')).not.toHaveClass(/dark/);

    await app2.close();
  } finally {
    try {
      rmSync(ud, { recursive: true, force: true });
    } catch {
      /* */
    }
  }
});
