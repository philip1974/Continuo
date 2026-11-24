// explorer.json version=99(未来版本/损坏)→ schema 校验失败 → fallback EmptyWorkspace.
import { expect, test } from '@playwright/test';
import { EXPLORER_NO_FOLDER_OPEN } from './helpers/explorer';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { waitForAppReady } from './helpers/app-ready';
import { launchContinuo } from './helpers/launch';

test('version=99 → fallback EmptyWorkspace + 不抛', async () => {
  const ud = mkdtempSync(path.join(tmpdir(), 'continuo-v99-'));
  try {
    writeFileSync(
      path.join(ud, 'explorer.json'),
      JSON.stringify({
        version: 99,
        workspace: { root: '/whatever', recentRoots: [] },
        explorer: {
          activePath: null,
          expandedPaths: [],
          sort: { by: 'name', reverse: false },
        },
        pinned: { paths: [] },
      }),
    );

    const app = await launchContinuo(ud);
    const win = await app.firstWindow();
    const pageErrors: string[] = [];
    win.on('pageerror', (err) => pageErrors.push(err.message));
    await win.waitForLoadState('domcontentloaded');

    // 就绪屏障放行后再断言空态(首帧 root=null 的空态在读盘前就可见,不能直接断言)
    await waitForAppReady(win);
    await expect(win.getByText(EXPLORER_NO_FOLDER_OPEN)).toBeVisible({
      timeout: 10_000,
    });
    expect(pageErrors).toEqual([]);
    await app.close();
  } finally {
    rmSync(ud, { recursive: true, force: true });
  }
});
