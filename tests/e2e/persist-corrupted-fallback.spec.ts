// explorer.json 损坏 / 不合 schema → 启动时 fallback 默认 store(EmptyWorkspace).  @edge
// 用户不丢信任,UI 仍可用.
import { _electron as electron, expect, test } from '@playwright/test';
import { EXPLORER_NO_FOLDER_OPEN } from './helpers/explorer';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../..');
const MAIN_ENTRY = path.join(REPO_ROOT, 'out/main/index.js');

async function launchAndAssertEmpty(ud: string): Promise<void> {
  const app = await electron.launch({
    args: [MAIN_ENTRY, `--user-data-dir=${ud}`],
    env: { ...process.env, ELECTRON_DISABLE_GPU: '1', CONTINUO_E2E: '1' },
  });
  const win = await app.firstWindow();
  await win.waitForLoadState('domcontentloaded');

  // EmptyWorkspace 渲染
  await expect(win.getByText(EXPLORER_NO_FOLDER_OPEN)).toBeVisible({
    timeout: 10_000,
  });

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
