// keybindings overrides 持久化:override → 关 → 重启同 userData → 仍生效.
import { _electron as electron, expect, test } from '@playwright/test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../..');
const MAIN_ENTRY = path.join(REPO_ROOT, 'out/main/index.js');

test('override settings.open=mod+shift+y → 关 → 重启 → 新组合仍触发', async () => {
  test.setTimeout(60_000);
  const ud = mkdtempSync(path.join(tmpdir(), 'continuo-kb-persist-'));
  try {
    // ── 第一次:override ──
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
            setHotkey: (commandId: string, hotkey: string) => void;
          };
        }
      ).__continuoTest;
      t.setHotkey('settings.open', 'mod+shift+y');
    });
    await win1.waitForTimeout(200);
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

    // 验证 override 已从 localStorage 恢复
    const restored = await win2.evaluate(() => {
      const raw = localStorage.getItem('continuo.keybindings.overrides');
      return raw ? (JSON.parse(raw) as Record<string, string>) : null;
    });
    expect(restored?.['settings.open']).toBe('mod+shift+y');

    // 给 plugin 注册一些时间(commands 注册可能异步)
    await win2.waitForTimeout(1_000);
    const cmdCount = await win2.evaluate(() => {
      const t = (
        window as unknown as {
          __continuoTest?: { commandCount?: () => number };
        }
      ).__continuoTest;
      return t?.commandCount ? t.commandCount() : -1;
    });
    expect(cmdCount).toBeGreaterThan(0);

    // 按新 hotkey
    await win2.evaluate(() => {
      document.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'y',
          ctrlKey: true,
          shiftKey: true,
          bubbles: true,
          cancelable: true,
        }),
      );
    });

    await expect(win2.locator('nav[aria-label="设置分类"]')).toBeVisible({
      timeout: 10_000,
    });

    await app2.close();
  } finally {
    rmSync(ud, { recursive: true, force: true });
  }
});
