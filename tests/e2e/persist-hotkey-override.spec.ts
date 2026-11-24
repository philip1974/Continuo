import { SETTINGS_NAV } from './helpers/settings';
// keybindings overrides 持久化:override → 关 → 重启同 userData → 仍生效.
import { expect, test } from '@playwright/test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { dispatchModKey } from './helpers/hotkeys';
import { launchContinuo } from './helpers/launch';
import { waitForTestHooks } from './helpers/app-ready';

test('override settings.toggle=mod+shift+y → 关 → 重启 → 新组合仍触发', async () => {
  test.setTimeout(60_000);
  const ud = mkdtempSync(path.join(tmpdir(), 'continuo-kb-persist-'));
  try {
    // ── 第一次:override ──
    const app1 = await launchContinuo(ud);
    const win1 = await app1.firstWindow();
    await win1.waitForLoadState('domcontentloaded');
    await waitForTestHooks(win1)
    await win1.evaluate(() => {
      const t = (
        window as unknown as {
          __continuoTest: {
            setHotkey: (commandId: string, hotkey: string) => void;
          };
        }
      ).__continuoTest;
      t.setHotkey('settings.toggle', 'mod+shift+y');
    });
    await win1.waitForTimeout(200);
    await app1.close();

    // ── 第二次:重启 ──
    const app2 = await launchContinuo(ud);
    const win2 = await app2.firstWindow();
    await win2.waitForLoadState('domcontentloaded');
    await waitForTestHooks(win2)

    // 验证 override 已从 localStorage 恢复
    const restored = await win2.evaluate(() => {
      const raw = localStorage.getItem('continuo.keybindings.overrides');
      return raw ? (JSON.parse(raw) as Record<string, string>) : null;
    });
    expect(restored?.['settings.toggle']).toBe('mod+shift+y');

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

    await dispatchModKey(win2, 'y', { shift: true });

    await expect(win2.getByRole('navigation', { name: SETTINGS_NAV })).toBeVisible({
      timeout: 10_000,
    });

    await app2.close();
  } finally {
    rmSync(ud, { recursive: true, force: true });
  }
});
