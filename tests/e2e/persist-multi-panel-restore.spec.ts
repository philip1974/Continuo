// 加 Terminal session + 重启 → Terminal 不作为 stale panel 恢复,Editor 仍恢复.
import { expect, test } from '@playwright/test';
import { DOCK_CLOSE_EDITOR, TERMINAL_INPUT } from './helpers/editor';
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

test('Editor + Terminal 使用后重启不恢复 stale terminal panel', async () => {
  const ud = mkdtempSync(path.join(tmpdir(), 'continuo-multi-restore-'));
  const workspaceRoot = mkdtempSync(
    path.join(tmpdir(), 'continuo-multi-restore-ws-'),
  );
  try {
    mkdirSync(path.join(workspaceRoot, 'src'), { recursive: true });
    writeFileSync(path.join(workspaceRoot, 'README.md'), '# Test Workspace\n');
    writeFileSync(path.join(workspaceRoot, 'src/a.ts'), 'export const a = 1;\n');
    writeFileSync(
      path.join(ud, 'explorer.json'),
      JSON.stringify({
        version: 1,
        workspace: {
          root: workspaceRoot,
          recentRoots: [workspaceRoot],
        },
        explorer: {
          activePath: null,
          expandedPaths: [workspaceRoot],
          sort: { by: 'name', reverse: false },
        },
        pinned: { paths: [] },
      }),
    );

    const app1 = await launchContinuo(ud);
    const win1 = await app1.firstWindow();
    await win1.waitForLoadState('domcontentloaded');

    // 加 Terminal session
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

    // 重启
    const app2 = await launchContinuo(ud);
    const win2 = await app2.firstWindow();
    await win2.waitForLoadState('domcontentloaded');
    // 先等应用就绪、Editor SharedTab 已渲染,再断言 Terminal 不从 dock layout 恢复
    await waitForAppReady(win2);
    await expect(
      win2.getByRole('button', { name: DOCK_CLOSE_EDITOR }),
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
