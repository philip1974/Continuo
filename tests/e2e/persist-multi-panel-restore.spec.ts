// 加 Terminal session + 重启 → Terminal 不作为 stale panel 恢复,Editor 仍恢复.
import { _electron as electron, expect, test } from '@playwright/test';
import { DOCK_CLOSE_EDITOR, TERMINAL_INPUT } from './helpers/editor';
import { dockHeaderMoreActionsButton } from './helpers/explorer';
import { TERMINAL_TAB } from './helpers/settings';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../..');
const MAIN_ENTRY = path.join(REPO_ROOT, 'out/main/index.js');

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

    const app1 = await electron.launch({
      args: [MAIN_ENTRY, `--user-data-dir=${ud}`],
      env: { ...process.env, ELECTRON_DISABLE_GPU: '1', CONTINUO_E2E: '1' },
    });
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

    // 等 layout.json 写盘
    await win1.waitForTimeout(800);
    const layoutPath = path.join(ud, 'layout.json');
    if (existsSync(layoutPath)) {
      const raw = readFileSync(layoutPath, 'utf8');
      expect(raw).not.toContain('"contentComponent":"terminal"');
    }
    await app1.close();

    // 重启
    const app2 = await electron.launch({
      args: [MAIN_ENTRY, `--user-data-dir=${ud}`],
      env: { ...process.env, ELECTRON_DISABLE_GPU: '1', CONTINUO_E2E: '1' },
    });
    const win2 = await app2.firstWindow();
    await win2.waitForLoadState('domcontentloaded');
    await win2.waitForTimeout(800);

    // Terminal 不从 dock layout 恢复
    await expect(
      win2.getByRole('textbox', { name: TERMINAL_INPUT }),
    ).toHaveCount(0);
    // Editor SharedTab 仍在
    await expect(
      win2.getByRole('button', { name: DOCK_CLOSE_EDITOR }),
    ).toBeVisible();

    await app2.close();
  } finally {
    rmSync(ud, { recursive: true, force: true });
    rmSync(workspaceRoot, { recursive: true, force: true });
  }
});
