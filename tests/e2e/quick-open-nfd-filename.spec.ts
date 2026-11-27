// ⌘P:磁盘上 NFD 编码的韩文文件名(`회의록-NFD.md`),键入 NFC 的 `회의록` 能搜到、列表显示 NFC 名,回车打开磁盘上的原文件。
// BDD: src/__tests__/filename-unicode-normalization/
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { closeDiscardingUnsaved } from './helpers/close-app';
import { launchContinuo } from './helpers/launch';
import { seedExplorerJson } from './helpers/seed-explorer';
import { openQuickOpen, quickOpenInput } from './helpers/palette';

const NFC_STEM = '회의록';
const NFD_NAME = `${NFC_STEM.normalize('NFD')}-NFD.md`;

test('NFD 韩文文件名:⌘P 输入 회의록 命中并能打开', async () => {
  test.setTimeout(90_000);
  const ud = mkdtempSync(path.join(tmpdir(), 'qnfd-ud-'));
  const ws = mkdtempSync(path.join(tmpdir(), 'qnfd-ws-'));
  const app = await (async () => {
    writeFileSync(path.join(ws, NFD_NAME), 'NFD-BODY-MARKER\n');
    writeFileSync(path.join(ws, 'other.md'), 'other\n');
    expect(readdirSync(ws)).toContain(NFD_NAME); // 磁盘上确实是 NFD
    seedExplorerJson(ud, { root: ws });
    return launchContinuo(ud);
  })();
  try {
    const win = await app.firstWindow();
    await win.waitForLoadState('domcontentloaded');
    const cdp = await win.context().newCDPSession(win);
    await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: false });

    await openQuickOpen(win); // 先等 shell 就绪再按 ⌘P(冷启动时快捷键尚未注册)
    const input = quickOpenInput(win);
    await expect(win.getByRole('option')).toHaveCount(2, { timeout: 10_000 });
    await input.fill(NFC_STEM);
    const option = win.getByRole('option');
    await expect(option).toHaveCount(1);
    // 列表显示 NFC 名
    const shown = (await option.first().textContent()) ?? '';
    expect(shown).toContain(`${NFC_STEM}-NFD.md`);

    await win.keyboard.press('Enter');
    await expect(input).toBeHidden({ timeout: 5_000 });
    await expect(win.getByText('NFD-BODY-MARKER').first()).toBeVisible({ timeout: 10_000 });
  } finally {
    await closeDiscardingUnsaved(app).catch(() => undefined);
    rmSync(ws, { recursive: true, force: true });
    rmSync(ud, { recursive: true, force: true });
  }
});
