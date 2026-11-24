// dockview layout 持久化:Terminal session 不写入 layout,重启只恢复非 terminal panel.
import { expect, test } from '@playwright/test';
import { TERMINAL_INPUT } from './helpers/editor';
import { dockHeaderMoreActionsButton } from './helpers/explorer';
import { TERMINAL_TAB } from './helpers/settings';
import { persistedPanelComponents } from './helpers/persisted-layout';
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { waitForAppReady } from './helpers/app-ready';
import { launchContinuo } from './helpers/launch';

test('加 Terminal session → 关 → 重启同 userData → 不恢复 stale terminal panel', async () => {
  const ud = mkdtempSync(path.join(tmpdir(), 'continuo-dock-'));
  const workspaceRoot = mkdtempSync(path.join(tmpdir(), 'continuo-dock-ws-'));
  try {
    mkdirSync(path.join(workspaceRoot, 'src'), { recursive: true });
    writeFileSync(path.join(workspaceRoot, 'README.md'), '# Test Workspace\n');
    writeFileSync(
      path.join(ud, 'explorer.json'),
      JSON.stringify({
        version: 1,
        workspace: { root: workspaceRoot, recentRoots: [workspaceRoot] },
        explorer: {
          activePath: null,
          expandedPaths: [workspaceRoot],
          sort: { by: 'name', reverse: false },
        },
        pinned: { paths: [] },
      }),
    );

    // ── 第一次启动:加 Terminal panel ──
    const app1 = await launchContinuo(ud);
    const win1 = await app1.firstWindow();
    await win1.waitForLoadState('domcontentloaded');

    await dockHeaderMoreActionsButton(win1).click();
    await win1
      .getByRole('menu')
      .last()
      .getByRole('menuitem', { name: TERMINAL_TAB })
      .click();
    await expect(
      win1.getByRole('textbox', { name: TERMINAL_INPUT }),
    ).toBeVisible({ timeout: 15_000 });

    await app1.close();
    // 关窗 flush 握手确定性写入最终布局快照:此时读到的就是加终端之后的布局。
    expect(persistedPanelComponents(ud)).toContain('editor');
    expect(persistedPanelComponents(ud)).not.toContain('terminal');

    // ── 第二次启动:不恢复 stale Terminal panel ──
    const app2 = await launchContinuo(ud);
    const win2 = await app2.firstWindow();
    await win2.waitForLoadState('domcontentloaded');
    // 先等应用就绪、dock 已渲染(Editor 默认 panel 可见),再断言 Terminal session 不从 dock layout 恢复.
    await waitForAppReady(win2);
    await expect(
      win2.getByRole('tab').filter({ hasText: /Editor|编辑器|편집기/ }),
    ).toBeVisible();
    await expect(
      win2.getByRole('textbox', { name: TERMINAL_INPUT }),
    ).toHaveCount(0);

    await app2.close();
  } finally {
    rmSync(ud, { recursive: true, force: true });
    rmSync(workspaceRoot, { recursive: true, force: true });
  }
});
