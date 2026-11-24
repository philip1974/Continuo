// 切 root → recentRoots 写盘 + 顺序(LRU 最新在前).
import { expect, test } from '@playwright/test';
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
  mkdirSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { explorerMoreActionsButton } from './helpers/explorer';
import { launchContinuo } from './helpers/launch';
import { seedExplorerJson } from './helpers/seed-explorer';

test('从 ws1 → 通过菜单切到 ws2 → recentRoots = [ws2, ws1]', async () => {
  const ud = mkdtempSync(path.join(tmpdir(), 'continuo-rr-'));
  const ws1 = mkdtempSync(path.join(tmpdir(), 'continuo-rr-ws1-'));
  const ws2 = mkdtempSync(path.join(tmpdir(), 'continuo-rr-ws2-'));
  try {
    mkdirSync(path.join(ws1, 'src'), { recursive: true });
    writeFileSync(path.join(ws1, 'README.md'), '# x\n');
    writeFileSync(path.join(ws2, 'README.md'), '# y\n');
    seedExplorerJson(ud, { root: ws1, recentRoots: [ws1, ws2] });

    const app = await launchContinuo(ud);
    const win = await app.firstWindow();
    await win.waitForLoadState('domcontentloaded');

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

    // 轮询到 explorer-persist debounce 写盘:窗口段 root = ws2,recentRoots 第一项 = ws2(LRU 最新在前)
    type Persisted = {
      workspace: { root?: string; recentRoots: string[] };
      windows?: Array<{
        windowSeq: number;
        workspace: { root: string | null };
      }>;
    };
    const read = (): { root: string | null | undefined; firstRecent: string | undefined } => {
      try {
        const data = JSON.parse(readFileSync(path.join(ud, 'explorer.json'), 'utf8')) as Persisted;
        return {
          root:
            data.windows?.find((entry) => entry.windowSeq === 0)?.workspace.root ??
            data.workspace.root,
          firstRecent: data.workspace.recentRoots[0],
        };
      } catch {
        return { root: undefined, firstRecent: undefined };
      }
    };
    await expect.poll(read, { timeout: 5_000 }).toEqual({ root: ws2, firstRecent: ws2 });

    await app.close();
  } finally {
    rmSync(ws1, { recursive: true, force: true });
    rmSync(ws2, { recursive: true, force: true });
    rmSync(ud, { recursive: true, force: true });
  }
});
