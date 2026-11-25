// 编辑器状态跨重启 / 切 tab 保持(VSCode:编辑器视图状态、Markdown 预览、图片预览缩放随会话恢复)。
// BDD: src/__tests__/editor-state-restart/
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { crc32, deflateSync } from 'node:zlib';
import { expect, test, type Page } from '@playwright/test';
import { EDITOR_MODE_PREVIEW, editorModeButton, editorTab, openWorkspaceFile } from './helpers/editor';
import { closeDiscardingUnsaved } from './helpers/close-app';
import { launchContinuo } from './helpers/launch';
import { seedExplorerJson } from './helpers/seed-explorer';

/** w×h 纯色不透明 RGB PNG。 */
function solidPng(w: number, h: number): Buffer {
  const chunk = (type: string, data: Buffer): Buffer => {
    const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(td));
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 2; // RGB
  const raw = Buffer.alloc(h * (1 + w * 3), 0x80);
  for (let y = 0; y < h; y++) raw[y * (1 + w * 3)] = 0; // filter byte
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const LINES = 300;
const LONG = Array.from({ length: LINES }, (_, i) => `const line${i + 1} = ${i + 1};`).join('\n') + '\n';
const IMAGE_VIEWER = '[data-image-viewer]';

async function launch(ud: string): Promise<Page> {
  const app = await launchContinuo(ud);
  apps.push(app);
  const win = await app.firstWindow();
  await win.waitForLoadState('domcontentloaded');
  return win;
}
const apps: Awaited<ReturnType<typeof launchContinuo>>[] = [];

/** 图片视图右下角的比例文字(例:「64x48 · 1.2KB · 150%」)。 */
const zoomText = (win: Page) => win.locator(IMAGE_VIEWER).locator('xpath=following-sibling::div').first();

test.afterEach(async () => {
  for (const app of apps.splice(0)) await closeDiscardingUnsaved(app).catch(() => undefined);
});

test('图片缩放:放大后切到别的 tab 再切回 → 比例保留', async () => {
  const ud = mkdtempSync(path.join(tmpdir(), 'continuo-state-ud-'));
  const ws = mkdtempSync(path.join(tmpdir(), 'continuo-state-ws-'));
  try {
    writeFileSync(path.join(ws, 'pic.png'), solidPng(64, 48));
    writeFileSync(path.join(ws, 'a.ts'), 'export const a = 1;\n');
    seedExplorerJson(ud, { root: ws });
    const win = await launch(ud);
    await openWorkspaceFile(win, ['pic.png']);
    const viewer = win.locator(IMAGE_VIEWER);
    await expect(win.locator(`${IMAGE_VIEWER} img`)).toBeVisible({ timeout: 10_000 });
    await viewer.focus();
    await win.keyboard.press('+'); // 100%(小图适应 = 原始尺寸)→ 150%
    await expect(zoomText(win)).toContainText('150%');

    await openWorkspaceFile(win, ['a.ts']);
    await expect(win.locator('.cm-content')).toBeVisible();
    await editorTab(win, 'pic.png').click();
    await expect(win.locator(`${IMAGE_VIEWER} img`)).toBeVisible({ timeout: 10_000 });
    await expect(zoomText(win)).toContainText('150%');
  } finally {
    rmSync(ws, { recursive: true, force: true });
    rmSync(ud, { recursive: true, force: true });
  }
});

test('重启:光标与滚动位置、Markdown 预览模式、图片缩放都恢复', async () => {
  test.setTimeout(90_000);
  const ud = mkdtempSync(path.join(tmpdir(), 'continuo-state-ud-'));
  const ws = mkdtempSync(path.join(tmpdir(), 'continuo-state-ws-'));
  try {
    writeFileSync(path.join(ws, 'long.ts'), LONG);
    writeFileSync(path.join(ws, 'README.md'), '# Title\n\nbody\n');
    writeFileSync(path.join(ws, 'pic.png'), solidPng(64, 48));
    seedExplorerJson(ud, { root: ws });

    const win1 = await launch(ud);
    // Markdown → 预览(非默认模式)
    await openWorkspaceFile(win1, ['README.md']);
    await editorModeButton(win1, EDITOR_MODE_PREVIEW).click();
    await expect(editorModeButton(win1, EDITOR_MODE_PREVIEW)).toHaveAttribute('aria-checked', 'true');
    // 图片放大一档
    await openWorkspaceFile(win1, ['pic.png']);
    await expect(win1.locator(`${IMAGE_VIEWER} img`)).toBeVisible({ timeout: 10_000 });
    await win1.locator(IMAGE_VIEWER).focus();
    await win1.keyboard.press('+');
    await expect(zoomText(win1)).toContainText('150%');
    // 长文件:光标到末尾(视图随之滚到底部),作为活动 tab 退出
    await openWorkspaceFile(win1, ['long.ts']);
    const cm1 = win1.locator('.cm-content');
    await cm1.click();
    await win1.keyboard.press('ControlOrMeta+End');
    await expect(win1.locator('.cm-line', { hasText: `line${LINES} =` })).toBeVisible();
    await closeDiscardingUnsaved(apps.pop()!);

    const win2 = await launch(ud);
    await expect(win2.locator('header').first()).toContainText('long.ts', { timeout: 15_000 });
    // 滚动:末尾行在视口内,开头行已滚出(CodeMirror 只渲染视口附近的行)
    await expect(win2.locator('.cm-line', { hasText: `line${LINES} =` })).toBeVisible({ timeout: 10_000 });
    await expect(win2.locator('.cm-line', { hasText: /^const line1 = 1;$/ })).toHaveCount(0);
    expect(await win2.locator('.cm-scroller').evaluate((el) => el.scrollTop)).toBeGreaterThan(0);
    // 光标:聚焦(不点击,不改选区)后输入落在原光标处(文件末尾)
    await win2.locator('.cm-content').focus();
    await win2.keyboard.type('// tail');
    await expect(win2.locator('.cm-line').last()).toContainText('// tail');

    await editorTab(win2, 'README.md').click();
    await expect(editorModeButton(win2, EDITOR_MODE_PREVIEW)).toHaveAttribute('aria-checked', 'true');

    await editorTab(win2, 'pic.png').click();
    await expect(win2.locator(`${IMAGE_VIEWER} img`)).toBeVisible({ timeout: 10_000 });
    await expect(zoomText(win2)).toContainText('150%');
  } finally {
    rmSync(ws, { recursive: true, force: true });
    rmSync(ud, { recursive: true, force: true });
  }
});
