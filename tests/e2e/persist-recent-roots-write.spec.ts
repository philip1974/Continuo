// 切 root → recentRoots 写盘 + 顺序(LRU 最新在前).
import { _electron as electron, expect, test } from '@playwright/test';
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
  mkdirSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { explorerMoreActionsButton } from './helpers/explorer';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../..');
const MAIN_ENTRY = path.join(REPO_ROOT, 'out/main/index.js');

test('从 ws1 → 通过菜单切到 ws2 → recentRoots = [ws2, ws1]', async () => {
  const ud = mkdtempSync(path.join(tmpdir(), 'continuo-rr-'));
  const ws1 = mkdtempSync(path.join(tmpdir(), 'continuo-rr-ws1-'));
  const ws2 = mkdtempSync(path.join(tmpdir(), 'continuo-rr-ws2-'));
  try {
    mkdirSync(path.join(ws1, 'src'), { recursive: true });
    writeFileSync(path.join(ws1, 'README.md'), '# x\n');
    writeFileSync(path.join(ws2, 'README.md'), '# y\n');
    writeFileSync(
      path.join(ud, 'explorer.json'),
      JSON.stringify({
        version: 1,
        workspace: { root: ws1, recentRoots: [ws1, ws2] },
        explorer: {
          activePath: null,
          expandedPaths: [ws1],
          sort: { by: 'name', reverse: false },
        },
        pinned: { paths: [] },
      }),
    );

    const app = await electron.launch({
      args: [MAIN_ENTRY, `--user-data-dir=${ud}`],
      env: { ...process.env, ELECTRON_DISABLE_GPU: '1', CONTINUO_E2E: '1' },
    });
    const win = await app.firstWindow();
    await win.waitForLoadState('domcontentloaded');

    // 用 testing hook 直接 setRoot(ws2)— 比 ⋯ 菜单稳
    await win.waitForFunction(
      () =>
        Boolean(
          (window as unknown as { __continuoTest?: unknown })
            .__continuoTest,
        ),
      { timeout: 5_000 },
    );
    // 通过 evaluate 触发 useWorkspaceStore.getState().setRoot(ws2)
    // 没暴露 store,改用 ⋯ 菜单(尝试):
    await explorerMoreActionsButton(win).click();
    const ws2Name = path.basename(ws2);
    const menuItem = win
      .getByRole('menu')
      .getByRole('menuitem', { name: ws2Name, exact: false });
    await menuItem.click();

    // 等 explorer-persist debounce 写盘
    await win.waitForTimeout(800);

    const raw = readFileSync(path.join(ud, 'explorer.json'), 'utf8');
    const data = JSON.parse(raw) as {
      workspace: { root?: string; recentRoots: string[] };
      windows?: Array<{
        windowSeq: number;
        workspace: { root: string | null };
      }>;
    };
    const windowRoot =
      data.windows?.find((entry) => entry.windowSeq === 0)?.workspace.root ??
      data.workspace.root;
    expect(windowRoot).toBe(ws2);
    // recentRoots 第一项是 ws2(LRU 最新在前)
    expect(data.workspace.recentRoots[0]).toBe(ws2);

    await app.close();
  } finally {
    rmSync(ws1, { recursive: true, force: true });
    rmSync(ws2, { recursive: true, force: true });
    rmSync(ud, { recursive: true, force: true });
  }
});
