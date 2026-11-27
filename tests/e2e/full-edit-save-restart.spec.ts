// 综合流:workspace + 编辑 + Cmd+S + 关 → 重启 → workspace 还原 + 磁盘内容仍是新值.
import { expect, test } from '@playwright/test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { EDITOR_UNSAVED_CHANGES_SELECTOR, openWorkspaceFile } from './helpers/editor';
import { launchContinuo } from './helpers/launch';
import { seedExplorerJson } from './helpers/seed-explorer';

test('编辑 a.ts + Cmd+S + 关 → 重启同 ud + ws → 磁盘新值在', async () => {
  test.setTimeout(60_000);
  const ud = mkdtempSync(path.join(tmpdir(), 'continuo-full-'));
  const ws = mkdtempSync(path.join(tmpdir(), 'continuo-full-ws-'));
  try {
    mkdirSync(path.join(ws, 'src'), { recursive: true });
    writeFileSync(path.join(ws, 'src/a.ts'), 'export const a = 1;\n');
    seedExplorerJson(ud, { root: ws, expandedPaths: [ws, path.join(ws, 'src')] });

    // 第一次启
    const app1 = await launchContinuo(ud);
    const win1 = await app1.firstWindow();
    await win1.waitForLoadState('domcontentloaded');

    await openWorkspaceFile(win1, ['src', 'a.ts']);
    const cm1 = win1.locator('.cm-content');
    await expect(cm1).toBeVisible({ timeout: 10_000 });
    await cm1.click();
    await cm1.press('ControlOrMeta+End');
    await win1.keyboard.type(' // saved-full');
    await cm1.press('ControlOrMeta+KeyS');

    // 等磁盘
    await expect(async () => {
      const c = readFileSync(path.join(ws, 'src/a.ts'), 'utf8');
      expect(c).toContain('saved-full');
    }).toPass({ timeout: 5_000 });
    // 磁盘出现新内容 ≠ 保存已完成:已有文件原地写(b07031dd)先把超出原长度的尾部追加到文件末尾,
    // 本例新内容恰是「原内容 + 追加」,所以写到一半磁盘就已是最终内容,之后还有覆盖 + fsync,
    // 保存返回后 tab 才变干净。此时关窗 main 仍记为有未保存修改 → 弹原生确认框(e2e 无人应答,close 永远等)。
    // 等未保存标记消失再关:这里要测的是「保存完成后关闭重启」。
    await expect(win1.locator(EDITOR_UNSAVED_CHANGES_SELECTOR)).toHaveCount(0, { timeout: 5_000 });

    await app1.close();

    // 第二次启 → 磁盘内容仍在
    const app2 = await launchContinuo(ud);
    const win2 = await app2.firstWindow();
    await win2.waitForLoadState('domcontentloaded');

    // workspace 还原
    const wsName = path.basename(ws);
    await expect(win2.locator('main aside').nth(1).getByText(wsName).first()).toBeVisible({
      timeout: 10_000,
    });

    // 磁盘读:重启前已确认写盘,这里只覆盖「app2 启动不回写旧内容」
    const after = readFileSync(path.join(ws, 'src/a.ts'), 'utf8');
    expect(after).toContain('saved-full');

    await app2.close();
  } finally {
    rmSync(ws, { recursive: true, force: true });
    rmSync(ud, { recursive: true, force: true });
  }
});
