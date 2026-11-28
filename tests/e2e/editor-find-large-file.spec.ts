// 大文件开着查找条时按键不卡(对齐 VSCode findModel:装饰 / 计数延迟更新,上限内用装饰跳转)。10 万行 / ~10MB 日志,查罕见词:
// 查找框逐字输入、查找条开着在正文打字、回车查找下一个,期间最长的帧间隔(单键阻塞主线程的最长时间)在上限内;计数最终正确。
// 修前每键 ~560–600ms(计数在按键里同步整篇扫描,回车由 CodeMirror findNext 再整篇搜索)。
// BDD: src/__tests__/editor-find-widget/
import { expect, test, type Page } from '@playwright/test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { closeDiscardingUnsaved } from './helpers/close-app';
import { launchContinuo } from './helpers/launch';
import { seedExplorerJson } from './helpers/seed-explorer';

/** 每键耗时上限(ms)。宽松:e2e 与其它进程共享 CPU(构建机 / 本机负载下实测修后 ~30–60ms,修前 ~560ms)。 */
const KEY_BUDGET_MS = 150;
const LINES = 100_000;
const NEEDLE = 'needle-xyz';

function bigLog(lines = LINES): string {
  const out: string[] = [];
  for (let i = 0; i < lines; i++) {
    out.push(
      `${String(i).padStart(6, '0')} INFO 2026-11-27T12:00:00.000Z worker-${i % 16} heartbeat ok latency=${i % 997}ms queue=${i % 31} payload=abcdefghij`,
    );
    if (i === lines - 10) out.push(`${String(i).padStart(6, '0')} WARN ${NEEDLE} found once`);
  }
  return out.join('\n') + '\n';
}

/**
 * 开始记录帧间隔(rAF 心跳):按键路径上的同步长任务会推迟下一帧,最大帧间隔 ≈ 单键阻塞主线程的最长时间(含渲染)。
 * 不用 Event Timing:CodeMirror 的正文输入经 DOM 观察者在别的任务里处理,按键事件条目量不到。
 */
async function startFrameMonitor(win: Page): Promise<void> {
  await win.evaluate(() => {
    const g = globalThis as unknown as { __frameGaps: number[]; __frameStop?: () => void };
    g.__frameStop?.();
    g.__frameGaps = [];
    let last = performance.now();
    let id = 0;
    const tick = (now: number) => {
      g.__frameGaps.push(now - last);
      last = now;
      id = requestAnimationFrame(tick);
    };
    id = requestAnimationFrame(tick);
    g.__frameStop = () => cancelAnimationFrame(id);
  });
}

/** 停止记录,返回最大帧间隔(ms)。 */
async function maxFrameGap(win: Page): Promise<number> {
  await win.evaluate(() => new Promise((r) => setTimeout(r, 300)));
  return win.evaluate(() => {
    const g = globalThis as unknown as { __frameGaps: number[]; __frameStop?: () => void };
    g.__frameStop?.();
    return Math.round(Math.max(0, ...g.__frameGaps));
  });
}

test('10 万行文件:查找条开着时输入查询 / 正文打字 / 回车下一个,每键 < 150ms;计数最终正确', async () => {
  test.setTimeout(180_000);
  const ud = mkdtempSync(path.join(tmpdir(), 'ui118-ud-'));
  const ws = mkdtempSync(path.join(tmpdir(), 'ui118-ws-'));
  try {
    writeFileSync(path.join(ws, 'big.log'), bigLog());
    seedExplorerJson(ud, { root: ws });
    const app = await launchContinuo(ud);
    try {
      const win = await app.firstWindow();
      await win.waitForLoadState('domcontentloaded');
      const cdp = await win.context().newCDPSession(win);
      await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: false });
      await win.locator('text=big.log').first().click();
      await expect(win.locator('.cm-content')).toBeVisible({ timeout: 30_000 });
      await win.locator('.cm-content').click();
      await win.keyboard.press('ControlOrMeta+KeyF');
      const search = win.locator('.cm-search [name="search"]');
      const count = win.locator('.cm-search .cm-search-count');
      await expect(search).toBeFocused();

      // 1. 查找框逐字输入罕见词
      await startFrameMonitor(win);
      for (const ch of NEEDLE) await win.keyboard.type(ch, { delay: 30 });
      const typing = await maxFrameGap(win);
      await expect(count).toHaveText(/^\D*\b1\b\D*$/, { timeout: 10_000 });

      // 2. 回车查找下一个(计数已完整:用已数到的匹配跳转)
      await startFrameMonitor(win);
      await win.keyboard.press('Enter');
      const enter = await maxFrameGap(win);
      await expect(count).toHaveText('1 / 1');

      // 3. 查找条开着,在正文打字(大文档编辑后约 100ms 重数,期间沿用随编辑移动的旧匹配)
      await win.locator('.cm-content').click({ position: { x: 40, y: 10 } });
      await startFrameMonitor(win);
      await win.keyboard.type(`${NEEDLE} `, { delay: 30 });
      const editing = await maxFrameGap(win);
      await expect(count).toHaveText(/^\D*\b2\b\D*$/, { timeout: 10_000 });

      // 4. 不存在的词:期间不报「无结果」,数完才报
      await search.click();
      await search.selectText();
      await startFrameMonitor(win);
      await win.keyboard.type('zz-none-q', { delay: 30 });
      const absent = await maxFrameGap(win);
      await expect(count).toHaveText(/^(No results|无结果|결과 없음)$/, { timeout: 10_000 });

      console.log(`[editor-find-large-file] max key ms: typing=${typing} enter=${enter} editing=${editing} absent=${absent}`);
      expect(typing).toBeLessThan(KEY_BUDGET_MS);
      expect(enter).toBeLessThan(KEY_BUDGET_MS);
      expect(editing).toBeLessThan(KEY_BUDGET_MS);
      expect(absent).toBeLessThan(KEY_BUDGET_MS);
    } finally {
      await closeDiscardingUnsaved(app);
    }
  } finally {
    rmSync(ud, { recursive: true, force: true });
    rmSync(ws, { recursive: true, force: true });
  }
});

// ⌘D / ⇧⌘L 对不再出现的词(BDD: src/__tests__/editor-text-commands/ 第 6 条):修前 CodeMirror 一次扫整篇,8.7 MB 日志卡约 0.5s;
// 修后分片搜索,按键期间最长帧间隔在上限内,结果不变(没有别的匹配 → 仍是一个选区)。8 万行 ≈ 8.4 MB。
test('8 万行日志:选中只出现一次的词后 ⌘D / ⇧⌘L 每键 < 150ms,结果仍是一个选区', async () => {
  test.setTimeout(180_000);
  const ud = mkdtempSync(path.join(tmpdir(), 'ui210-ud-'));
  const ws = mkdtempSync(path.join(tmpdir(), 'ui210-ws-'));
  try {
    writeFileSync(path.join(ws, 'big.log'), bigLog(80_000));
    seedExplorerJson(ud, { root: ws });
    const app = await launchContinuo(ud);
    try {
      const win = await app.firstWindow();
      await win.waitForLoadState('domcontentloaded');
      const cdp = await win.context().newCDPSession(win);
      await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: false });
      await win.locator('text=big.log').first().click();
      await expect(win.locator('.cm-content')).toBeVisible({ timeout: 30_000 });
      await win.locator('.cm-content').click();
      // 经查找选中唯一出现的词,Esc 关查找条(选区留在匹配上)
      await win.keyboard.press('ControlOrMeta+KeyF');
      await win.keyboard.type(NEEDLE);
      const count = win.locator('.cm-search .cm-search-count');
      await expect(count).toHaveText(/^\D*\b1\b\D*$/, { timeout: 10_000 });
      await win.keyboard.press('Enter');
      await win.keyboard.press('Escape');
      // 状态栏选区项:多个选区时显示「N 个选区」
      const status = win.locator('[data-statusbar-selection]');
      const selectedText = () => win.evaluate(() => window.getSelection()?.toString() ?? '');
      await expect.poll(selectedText).toBe(NEEDLE);

      await startFrameMonitor(win);
      await win.keyboard.press('ControlOrMeta+KeyD');
      const addNext = await maxFrameGap(win);
      await startFrameMonitor(win);
      await win.keyboard.press('ControlOrMeta+Shift+KeyL');
      const selectAll = await maxFrameGap(win);
      console.log(`[editor-find-large-file] max key ms: cmd+d=${addNext} cmd+shift+l=${selectAll}`);
      await expect.poll(selectedText).toBe(NEEDLE);
      await expect(status).not.toHaveText(/^\d+ (selections|选择|선택 항목)/);
      expect(addNext).toBeLessThan(KEY_BUDGET_MS);
      expect(selectAll).toBeLessThan(KEY_BUDGET_MS);
    } finally {
      await closeDiscardingUnsaved(app);
    }
  } finally {
    rmSync(ud, { recursive: true, force: true });
    rmSync(ws, { recursive: true, force: true });
  }
});
