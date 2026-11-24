// IconSidebar Explorer 按钮 + 状态栏 hidden hint + 重启持久化.
//
// 同样的开关也应该可以通过命令面板 / hotkey 触发?查 commands 注册.
// ExplorerSidebar 有命令 explorer.toggleSidebar(mod+b);本用例测:点击 → toggle → 重启状态保留
// (layoutUi.sidebarOpen).
import { expect, test } from '@playwright/test';
import {
  EXPLORER_HIDE,
  EXPLORER_SHOW,
  SIDEBAR_HIDDEN_TEXT,
} from './helpers/explorer';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { launchContinuo } from './helpers/launch';

test('点 Explorer 关闭 sidebar → 关 → 重启 → sidebar 仍关', async () => {
  const ud = mkdtempSync(path.join(tmpdir(), 'continuo-sb-toggle-'));
  try {
    const app1 = await launchContinuo(ud);
    const win1 = await app1.firstWindow();
    await win1.waitForLoadState('domcontentloaded');

    // 默认 sidebar 开 → 「隐藏资源管理器」按钮可见
    await win1.getByRole('button', { name: EXPLORER_HIDE }).click();
    // 等 explorer-persist debounce 写盘
    await win1.waitForTimeout(500);
    await app1.close();

    // 重启
    const app2 = await launchContinuo(ud);
    const win2 = await app2.firstWindow();
    await win2.waitForLoadState('domcontentloaded');

    // sidebar 关 → IconSidebar 显 show label + StatusBar 显 hidden hint.
    await expect(
      win2.getByRole('button', { name: EXPLORER_SHOW }),
    ).toBeVisible();
    await expect(win2.locator('footer')).toContainText(SIDEBAR_HIDDEN_TEXT);

    await app2.close();
  } finally {
    rmSync(ud, { recursive: true, force: true });
  }
});
