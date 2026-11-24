// EmptyWorkspace 「最近打开」list 点击 → setRoot → Explorer 切到 FolderTree.
import { expect, test } from '@playwright/test';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  EXPLORER_NO_FOLDER_OPEN_TEXT,
  EXPLORER_RECENT_TEXT,
} from './helpers/explorer';
import { launchContinuo } from './helpers/launch';

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

  const app = await launchContinuo(ud);
  try {
    const window = await app.firstWindow();
    await window.waitForLoadState('domcontentloaded');

    const explorerArea = window.locator('main aside').nth(1);
    await expect(explorerArea).toContainText(EXPLORER_NO_FOLDER_OPEN_TEXT);
    await expect(explorerArea).toContainText(EXPLORER_RECENT_TEXT);

    // 点击 ws basename 进入
    const wsName = path.basename(ws);
    // 只匹配「打开最近」按钮(同一条目右侧的「从最近打开中删除」× 的名字也含路径)
    await explorerArea
      .getByRole('button', { name: new RegExp(`^(打开最近|Open recent|최근 항목 열기)[::].*${wsName}$`) })
      .click();

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

// VSCode:「最近打开」项可删除 —— 点已不存在的目录 → 询问是否从列表删除;条目右侧 × 直接删除。
test('最近打开:点已不存在的目录 → 询问后从列表删除;× 删除另一项', async () => {
  test.setTimeout(60_000);

  const ud = mkdtempSync(path.join(tmpdir(), 'continuo-recent-remove-'));
  const ws = mkdtempSync(path.join(tmpdir(), 'continuo-recent-remove-ws-'));
  const gone = path.join(tmpdir(), `continuo-recent-gone-${process.pid}-${Date.now()}`);
  writeFileSync(
    path.join(ud, 'explorer.json'),
    JSON.stringify({
      version: 1,
      workspace: { root: null, recentRoots: [gone, ws] },
      explorer: { activePath: null, expandedPaths: [], sort: { by: 'name', reverse: false } },
      pinned: { paths: [] },
    }),
  );

  const app = await launchContinuo(ud);
  try {
    const window = await app.firstWindow();
    await window.waitForLoadState('domcontentloaded');
    const explorerArea = window.locator('main aside').nth(1);
    const list = explorerArea.getByRole('list');
    await expect(list.getByRole('listitem')).toHaveCount(2, { timeout: 10_000 });

    await list.getByRole('button', { name: new RegExp(`^(打开最近|Open recent|최근 항목 열기)[::].*${path.basename(gone)}$`) }).click();
    const dialog = window.getByRole('dialog');
    await expect(dialog).toBeVisible({ timeout: 5_000 });
    await expect(dialog).toContainText(gone);
    await dialog.getByRole('button', { name: /^(删除|Remove|제거)$/ }).click();
    await expect(dialog).toBeHidden();
    await expect(list.getByRole('listitem')).toHaveCount(1);

    const item = list.getByRole('listitem').first();
    await item.hover();
    await item.getByRole('button', { name: /(从最近打开中删除|Remove from Recently Opened|최근 열기에서 제거)/ }).click();
    await expect(explorerArea.getByRole('list')).toHaveCount(0);
    // 落盘:main 锁内移除后 explorer.json 不再含这两项
    await expect(async () => {
      const saved = JSON.parse(readFileSync(path.join(ud, 'explorer.json'), 'utf8')) as {
        workspace: { recentRoots: string[] };
      };
      expect(saved.workspace.recentRoots).toEqual([]);
    }).toPass({ timeout: 5_000 });
  } finally {
    await app.close();
    rmSync(ud, { recursive: true, force: true });
    rmSync(ws, { recursive: true, force: true });
  }
});
