// EmptyWorkspace 「最近打开」list 点击 → setRoot → Explorer 切到 FolderTree.
import { _electron as electron, expect, test } from '@playwright/test';
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  EXPLORER_NO_FOLDER_OPEN_TEXT,
  EXPLORER_RECENT_TEXT,
} from './helpers/explorer';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../..');
const MAIN_ENTRY = path.join(REPO_ROOT, 'out/main/index.js');

test('explorer.json: root=null + recentRoots=[ws] → 点击 ws 项 → 切 FolderTree', async () => {
  test.setTimeout(60_000);

  const ud = mkdtempSync(path.join(tmpdir(), 'continuo-empty-recent-'));
  const ws = mkdtempSync(path.join(tmpdir(), 'continuo-empty-recent-ws-'));
  mkdirSync(path.join(ws, 'sub'), { recursive: true });
  writeFileSync(path.join(ws, 'README.md'), '# recent click ws\n');

  // explorer.json: 无 root,recentRoots=[ws]
  const explorerJson = {
    version: 1,
    workspace: {
      root: null,
      recentRoots: [ws],
    },
    explorer: {
      activePath: null,
      expandedPaths: [],
      sort: { by: 'name' as const, reverse: false },
    },
    pinned: { paths: [] },
  };
  writeFileSync(
    path.join(ud, 'explorer.json'),
    JSON.stringify(explorerJson),
  );

  const app = await electron.launch({
    args: [MAIN_ENTRY, `--user-data-dir=${ud}`],
    env: { ...process.env, ELECTRON_DISABLE_GPU: '1', CONTINUO_E2E: '1' },
  });
  try {
    const window = await app.firstWindow();
    await window.waitForLoadState('domcontentloaded');

    const explorerArea = window.locator('main aside').nth(1);
    await expect(explorerArea).toContainText(EXPLORER_NO_FOLDER_OPEN_TEXT);
    await expect(explorerArea).toContainText(EXPLORER_RECENT_TEXT);

    // 点击 ws basename 进入
    const wsName = path.basename(ws);
    await explorerArea.getByRole('button', { name: new RegExp(wsName) }).click();

    // FolderTree 出现 → 渲染 README.md 文件
    await expect(window.locator('text=README.md')).toBeVisible({
      timeout: 10_000,
    });
  } finally {
    await app.close();
    rmSync(ud, { recursive: true, force: true });
    rmSync(ws, { recursive: true, force: true });
  }
});
