// 22 个终端时切回让出过 WebGL 的终端:逐帧(CDP screencast)无空白帧。修前:隐藏时让出 WebGL 后换上的 DOM 渲染器在隐藏期间
// 不渲染(xterm RenderService 在 IntersectionObserver 回报可见前暂停),重新可见时下一帧才装 WebGL、装完再等一帧画 —— 空白 2~3 帧。
// BDD: src/__tests__/terminal-webgl/
import type { Page } from '@playwright/test';
import { test, expect } from './fixtures/with-workspace';
import { waitForAppReady, waitForTestHooks } from './helpers/app-ready';
import { TERMINAL_PANEL_TAB } from './helpers/editor';

const COUNT = 22;
const SWITCH_BUDGET_MS = 1_000;

function renderers(win: Page) {
  return win.evaluate(() =>
    [...document.querySelectorAll<HTMLElement>('.xterm')].map((el) => ({
      visible: el.offsetParent !== null && el.getBoundingClientRect().width > 0,
      webgl: !!el.querySelector('.xterm-screen canvas') && !el.querySelector('.xterm-rows'),
    })),
  );
}

async function visibleAllWebgl(win: Page): Promise<boolean> {
  const all = await renderers(win);
  return all.some((r) => r.visible) && all.every((r) => !r.visible || r.webgl);
}

interface Frame {
  readonly data: string;
  readonly deviceWidth: number;
  readonly offsetTop: number;
}

/** 帧内矩形(CSS px)里与背景(矩形右下角像素)明显不同的像素数。在页面里解码 PNG(createImageBitmap)。 */
function inkOf(win: Page, frame: Frame, rect: { x: number; y: number; width: number; height: number }): Promise<number> {
  return win.evaluate(
    async ({ frame, rect }) => {
      const bytes = Uint8Array.from(atob(frame.data), (c) => c.charCodeAt(0));
      const bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/png' }));
      const scale = bitmap.width / frame.deviceWidth;
      const x = Math.round(rect.x * scale);
      const y = Math.round((rect.y + frame.offsetTop) * scale);
      const w = Math.max(1, Math.round(rect.width * scale));
      const h = Math.max(1, Math.round(rect.height * scale));
      const canvas = new OffscreenCanvas(w, h);
      const ctx = canvas.getContext('2d')!;
      ctx.drawImage(bitmap, x, y, w, h, 0, 0, w, h);
      const px = ctx.getImageData(0, 0, w, h).data;
      const bg = [px[px.length - 4]!, px[px.length - 3]!, px[px.length - 2]!];
      let ink = 0;
      for (let i = 0; i < px.length; i += 4) {
        if (Math.abs(px[i]! - bg[0]!) + Math.abs(px[i + 1]! - bg[1]!) + Math.abs(px[i + 2]! - bg[2]!) > 60) ink++;
      }
      return ink;
    },
    { frame, rect },
  );
}

test('22 个终端:切回让出过 WebGL 的终端,逐帧无空白帧;切换耗时在上限内', async ({ window }) => {
  test.setTimeout(300_000);
  await waitForAppReady(window);
  await waitForTestHooks(window);

  for (let i = 0; i < COUNT; i++) {
    expect(await window.evaluate(() => globalThis.__continuoTest!.executeCommand('terminal.new'))).toBe(true);
    await expect(window.getByRole('tab', { name: TERMINAL_PANEL_TAB })).toHaveCount(i + 1, { timeout: 15_000 });
    await expect.poll(() => visibleAllWebgl(window), { timeout: 15_000 }).toBe(true);
    // 每个终端写满几屏内容(新终端获得焦点),空白帧才可辨
    await expect
      .poll(() => window.evaluate(() => document.activeElement?.classList.contains('xterm-helper-textarea') ?? false), { timeout: 5_000 })
      .toBe(true);
    await window.keyboard.type('seq -w 100000 100060\n');
  }
  await window.waitForTimeout(2_000);

  const group = window.locator('.dv-groupview').last();
  const tabs = group.getByRole('tab', { name: TERMINAL_PANEL_TAB });
  expect(await tabs.count()).toBeGreaterThan(12);
  // 最右组第一个 tab 最久没显示:名额满时最先让出 WebGL(隐藏面板不在 DOM 里,无从直接查看)
  const screen = group.locator('.xterm-screen').filter({ visible: true });
  const rect = (await screen.boundingBox())!;

  const cdp = await window.context().newCDPSession(window);
  const frames: Frame[] = [];
  cdp.on('Page.screencastFrame', (f) => {
    frames.push({ data: f.data, deviceWidth: f.metadata.deviceWidth, offsetTop: f.metadata.offsetTop });
    void cdp.send('Page.screencastFrameAck', { sessionId: f.sessionId }).catch(() => {});
  });
  await cdp.send('Page.startScreencast', { format: 'png', everyNthFrame: 1 });
  await window.waitForTimeout(500);
  const before = frames.length;

  const t0 = Date.now();
  await tabs.first().click();
  await expect(tabs.first()).toHaveAttribute('aria-selected', 'true');
  await expect.poll(() => visibleAllWebgl(window), { timeout: 5_000, intervals: [16] }).toBe(true);
  const switchMs = Date.now() - t0;
  await window.waitForTimeout(1_000);
  await cdp.send('Page.stopScreencast');

  const inks: number[] = [];
  for (const frame of frames.slice(Math.max(0, before - 1))) inks.push(await inkOf(window, frame, rect));
  const settled = inks[inks.length - 1]!;
  console.log(`[terminal-webgl-switch-frames] switch=${switchMs}ms frames=${frames.length - before} inks=${JSON.stringify(inks)}`);
  expect(settled).toBeGreaterThan(500);
  // 空白帧:内容像素不到稳定后的一成
  expect(inks.filter((ink) => ink < settled * 0.1)).toEqual([]);
  expect(switchMs).toBeLessThan(SWITCH_BUDGET_MS);
});
