// 空 workspace + Cmd+P → 模态打开 + 列表 0 项.
import { expect, test } from '@playwright/test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openQuickOpen, quickOpenInput } from './helpers/palette';
import { launchContinuo } from './helpers/launch';
import { seedExplorerJson } from './helpers/seed-explorer';

const QO_EMPTY = /(工作区无文件|No files in workspace|워크스페이스에 파일이 없습니다)/;
const QO_NO_WORKSPACE = /(请先在资源管理器中打开工作区|Please open a workspace in Explorer first|먼저 탐색기에서 워크스페이스를 여세요)/;

test('空 ws + Cmd+P → modal 显占位 + 0 li', async () => {
  test.setTimeout(30_000);
  const ud = mkdtempSync(path.join(tmpdir(), 'continuo-qo-empty-'));
  const ws = mkdtempSync(path.join(tmpdir(), 'continuo-qo-empty-ws-'));
  try {
    seedExplorerJson(ud, { root: ws });

    const app = await launchContinuo(ud);
    const win = await app.firstWindow();
    await win.waitForLoadState('domcontentloaded');

    await openQuickOpen(win);
    const input = quickOpenInput(win);
    await expect(input).toBeVisible({ timeout: 5_000 });

    // 显示「工作区无文件」(而非「请先打开工作区」:后者是 root 尚未恢复时的占位),再断言 0 li
    await expect(win.locator('.wm-modal-content')).toContainText(QO_EMPTY, { timeout: 10_000 });
    await expect(win.locator('.wm-modal-content')).not.toContainText(QO_NO_WORKSPACE);
    await expect(win.locator('.wm-modal-content li')).toHaveCount(0);

    await app.close();
  } finally {
    rmSync(ws, { recursive: true, force: true });
    rmSync(ud, { recursive: true, force: true });
  }
});
