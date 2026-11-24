// explorer.json 损坏 / 不合 schema → 启动时 fallback 默认 store(EmptyWorkspace).  @edge
// 用户不丢信任,UI 仍可用(无 pageerror)。UI 在持久化读完前即以 root=null 渲染空态,故先等就绪屏障
// (Splash 消失)再断言;另有合法文件的对照用例证明同一路径能恢复出文件树。
import { expect, test } from '@playwright/test';
import { EXPLORER_NO_FOLDER_OPEN, explorerTreeItem } from './helpers/explorer';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { waitForAppReady } from './helpers/app-ready';
import { launchContinuo } from './helpers/launch';
import { seedExplorerJson } from './helpers/seed-explorer';

async function launchAndAssertEmpty(ud: string): Promise<void> {
  const app = await launchContinuo(ud);
  const win = await app.firstWindow();
  const pageErrors: string[] = [];
  win.on('pageerror', (err) => pageErrors.push(err.message));
  await win.waitForLoadState('domcontentloaded');

  // 就绪屏障放行(Splash 已挂上又撤除;正常路径下意味着持久化已读完、root 已恢复,旁路见 helpers/app-ready)
  // 后再断言空态,避免首帧 root=null 的空态恒真。合法工作区对照用例证明同一屏障后会恢复出文件树。
  await waitForAppReady(win);
  await expect(win.getByText(EXPLORER_NO_FOLDER_OPEN)).toBeVisible({
    timeout: 10_000,
  });
  expect(pageErrors).toEqual([]);

  await app.close();
}

test('explorer.json 是非 JSON 文本 → fallback EmptyWorkspace', async () => {
  const ud = mkdtempSync(path.join(tmpdir(), 'continuo-corrupt-'));
  try {
    writeFileSync(path.join(ud, 'explorer.json'), 'not json {{{');
    await launchAndAssertEmpty(ud);
  } finally {
    rmSync(ud, { recursive: true, force: true });
  }
});

test('explorer.json 缺 version → fallback', async () => {
  const ud = mkdtempSync(path.join(tmpdir(), 'continuo-corrupt2-'));
  try {
    writeFileSync(
      path.join(ud, 'explorer.json'),
      JSON.stringify({
        // 缺 version 字段
        workspace: { root: '/nonexistent', recentRoots: [] },
        explorer: {
          activePath: null,
          expandedPaths: [],
          sort: { by: 'name', reverse: false },
        },
        pinned: { paths: [] },
      }),
    );
    await launchAndAssertEmpty(ud);
  } finally {
    rmSync(ud, { recursive: true, force: true });
  }
});

test('explorer.json 是数组(整个根错类型) → fallback', async () => {
  const ud = mkdtempSync(path.join(tmpdir(), 'continuo-corrupt3-'));
  try {
    writeFileSync(path.join(ud, 'explorer.json'), JSON.stringify([1, 2, 3]));
    await launchAndAssertEmpty(ud);
  } finally {
    rmSync(ud, { recursive: true, force: true });
  }
});

test('对照:合法 explorer.json(v1 + 存在的 ws)→ 恢复出文件树(证明同一路径能区分)', async () => {
  const ud = mkdtempSync(path.join(tmpdir(), 'continuo-corrupt-ctrl-'));
  const ws = mkdtempSync(path.join(tmpdir(), 'continuo-corrupt-ctrl-ws-'));
  try {
    mkdirSync(path.join(ws, 'src'), { recursive: true });
    writeFileSync(path.join(ws, 'restored.txt'), 'x\n');
    seedExplorerJson(ud, { root: ws });
    const app = await launchContinuo(ud);
    const win = await app.firstWindow();
    await win.waitForLoadState('domcontentloaded');
    await waitForAppReady(win);
    await expect(explorerTreeItem(win, /^restored\.txt$/)).toBeVisible({ timeout: 10_000 });
    await expect(win.getByText(EXPLORER_NO_FOLDER_OPEN)).toHaveCount(0);
    await app.close();
  } finally {
    rmSync(ws, { recursive: true, force: true });
    rmSync(ud, { recursive: true, force: true });
  }
});
