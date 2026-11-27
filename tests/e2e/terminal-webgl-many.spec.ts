// 终端多于 Chromium 的 16 个 WebGL 上下文时,可见终端保持 WebGL(对齐 VSCode xtermTerminal 的 WebGL 装卸)。修前:连建 20 个终端,
// 控制台 4 次「Too many active WebGL contexts」,被丢的是最早建、恰好可见的终端(白底哭脸约 3 秒后永久降为 DOM 渲染)。
// WebGL 渲染时 .xterm-screen 下是 canvas、没有 DOM 渲染器的 .xterm-rows。
// BDD: src/__tests__/terminal-webgl/
import type { Page } from '@playwright/test';
import { test, expect } from './fixtures/with-workspace';
import { waitForAppReady, waitForTestHooks } from './helpers/app-ready';
import { TERMINAL_PANEL_TAB } from './helpers/editor';

const COUNT = 20;
/** 切 tab 到可见终端换上 WebGL 的耗时上限(ms;宽松,负载下)。 */
const SWITCH_BUDGET_MS = 1_000;

/** 各终端的渲染器:可见与否、是否 WebGL。 */
function renderers(win: Page) {
  return win.evaluate(() =>
    [...document.querySelectorAll<HTMLElement>('.xterm')].map((el) => ({
      visible: el.offsetParent !== null && el.getBoundingClientRect().width > 0,
      webgl: !!el.querySelector('.xterm-screen canvas') && !el.querySelector('.xterm-rows'),
    })),
  );
}

/** 有可见终端,且可见的全是 WebGL。 */
async function visibleAllWebgl(win: Page): Promise<boolean> {
  const all = await renderers(win);
  return all.some((r) => r.visible) && all.every((r) => !r.visible || r.webgl);
}

test('连建 20 个终端:无「Too many active WebGL contexts」,可见终端一直是 WebGL;切回最早的终端重新装上 WebGL', async ({ window }) => {
  test.setTimeout(240_000);
  const warnings: string[] = [];
  window.on('console', (msg) => {
    if (/too many active webgl contexts|webgl/i.test(msg.text())) warnings.push(msg.text());
  });
  await waitForAppReady(window);
  await waitForTestHooks(window);

  for (let i = 0; i < COUNT; i++) {
    expect(await window.evaluate(() => globalThis.__continuoTest!.executeCommand('terminal.new'))).toBe(true);
    await expect(window.getByRole('tab', { name: TERMINAL_PANEL_TAB })).toHaveCount(i + 1, { timeout: 15_000 });
    // 新终端可见且装上 WebGL(可见的终端全是 WebGL)
    await expect.poll(() => visibleAllWebgl(window), { timeout: 15_000 }).toBe(true);
  }
  // 留出浏览器丢弃上下文 / addon 等待恢复(~3s)的时间
  await window.waitForTimeout(4_000);
  const after = await renderers(window);
  console.log(`[terminal-webgl-many] after create: ${JSON.stringify(after)}`);
  expect(after.some((r) => r.visible) && after.every((r) => !r.visible || r.webgl)).toBe(true);
  expect(after.filter((r) => r.webgl).length).toBeLessThanOrEqual(12);
  expect(warnings.filter((w) => /too many active webgl contexts/i.test(w))).toEqual([]);

  // 切回最早的隐藏终端(已让出 WebGL):terminal.new 先往右拆出几个组,之后都作为 tab 叠进最右的组;
  // 该组第一个 tab 是最久没显示的,名额满时最先让出。重新可见后装上 WebGL
  const tabs = window.locator('.dv-groupview').last().getByRole('tab', { name: TERMINAL_PANEL_TAB });
  expect(await tabs.count()).toBeGreaterThan(12);
  const t0 = Date.now();
  await tabs.first().click();
  await expect(tabs.first()).toHaveAttribute('aria-selected', 'true');
  await expect.poll(() => visibleAllWebgl(window), { timeout: 5_000, intervals: [16] }).toBe(true);
  const switchMs = Date.now() - t0;

  // 名额内的终端之间来回切:不重建,切换耗时同样在上限内
  const t1 = Date.now();
  await tabs.last().click();
  await expect(tabs.last()).toHaveAttribute('aria-selected', 'true');
  await expect.poll(() => visibleAllWebgl(window), { timeout: 5_000, intervals: [16] }).toBe(true);
  const switchBackMs = Date.now() - t1;
  console.log(`[terminal-webgl-many] switch to evicted=${switchMs}ms, switch within pool=${switchBackMs}ms`);
  expect(switchMs).toBeLessThan(SWITCH_BUDGET_MS);
  expect(switchBackMs).toBeLessThan(SWITCH_BUDGET_MS);
  expect((await renderers(window)).filter((r) => r.webgl).length).toBeLessThanOrEqual(12);
  expect(warnings.filter((w) => /too many active webgl contexts/i.test(w))).toEqual([]);
});
