// 长 workspace 名 → ExplorerHeader 标题元素 class 含 truncate.
import { expect, test } from '@playwright/test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { launchContinuo } from './helpers/launch';

test('长 workspace 名 → ExplorerHeader 标题 class 含 truncate', async () => {
  test.setTimeout(30_000);
  const ud = mkdtempSync(path.join(tmpdir(), 'continuo-long-'));
  // 超长名:80+ 字符
  const longName = 'this-is-a-very-very-very-long-workspace-folder-name-for-truncate-testing';
  const ws = mkdtempSync(path.join(tmpdir(), `continuo-${longName}-`));
  try {
    writeFileSync(path.join(ws, 'README.md'), '# x\n');
    writeFileSync(
      path.join(ud, 'explorer.json'),
      JSON.stringify({
        version: 1,
        workspace: { root: ws, recentRoots: [ws] },
        explorer: {
          activePath: null,
          expandedPaths: [ws],
          sort: { by: 'name', reverse: false },
        },
        pinned: { paths: [] },
      }),
    );

    const app = await launchContinuo(ud);
    const win = await app.firstWindow();
    await win.waitForLoadState('domcontentloaded');

    // ExplorerHeader 标题 span:title=root(完整路径),文本为 basename
    const aside = win.locator('main aside').nth(1);
    const titleSpan = aside.getByTitle(ws, { exact: true });
    await expect(titleSpan).toBeVisible({ timeout: 10_000 });
    await expect(titleSpan).toHaveText(path.basename(ws));
    await expect(titleSpan).toHaveClass(/(^|\s)truncate(\s|$)/);

    await app.close();
  } finally {
    rmSync(ws, { recursive: true, force: true });
    rmSync(ud, { recursive: true, force: true });
  }
});
