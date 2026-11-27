// e2e 编辑器性能对比:同一视图里切换某个设置的开 / 关,页内计时滚动 / 移动光标 / 输入(BDD: src/__tests__/editor-indent-guides/、
// src/__tests__/editor-occurrences-highlight/)。
import type { Page } from '@playwright/test';
import { expect, test } from '@playwright/test';
import { openWorkspaceFile } from './editor';
import { waitForTestHooks } from './app-ready';

interface Timing {
  scroll: number;
  cursor: number;
  type: number;
}

/** 页内计时:滚动 20 次(各等两帧)/ 移动光标 200 次 / 输入 100 个字符(各一次 dispatch,DOM 同步更新)。 */
function measure(window: Page, horizontal: boolean): Promise<Timing> {
  return window.locator('.cm-content').first().evaluate(async (content, horiz) => {
    type View = {
      state: { doc: { length: number; lines: number; line(n: number): { from: number; to: number } }; selection: { main: { head: number } } };
      dispatch(tr: unknown): void;
      scrollDOM: HTMLElement;
    };
    const view = (content as unknown as { cmTile: { root: { view: View } } }).cmTile.root.view;
    const frames = () => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())));
    const s = view.scrollDOM;
    let t = performance.now();
    for (let i = 1; i <= 20; i++) {
      if (horiz) s.scrollLeft = ((s.scrollWidth - s.clientWidth) * i) / 20;
      else s.scrollTop = ((s.scrollHeight - s.clientHeight) * i) / 20;
      await frames();
    }
    const scroll = performance.now() - t;
    // 回到中部附近定光标
    if (horiz) s.scrollLeft = (s.scrollWidth - s.clientWidth) / 2;
    else s.scrollTop = (s.scrollHeight - s.clientHeight) / 2;
    await frames();
    const mid = horiz ? Math.floor(view.state.doc.length / 2) : view.state.doc.line(Math.floor(view.state.doc.lines / 2)).to;
    view.dispatch({ selection: { anchor: mid }, scrollIntoView: true });
    await frames();
    t = performance.now();
    for (let i = 0; i < 200; i++) {
      const head = view.state.selection.main.head;
      const next = horiz ? head + 1 : Math.min(view.state.doc.length, head + 17);
      view.dispatch({ selection: { anchor: next } });
    }
    await frames();
    const cursor = performance.now() - t;
    t = performance.now();
    for (let i = 0; i < 100; i++) {
      const head = view.state.selection.main.head;
      view.dispatch({ changes: { from: head, insert: 'x' }, selection: { anchor: head + 1 } });
    }
    await frames();
    const type = performance.now() - t;
    return { scroll, cursor, type };
  }, horizontal);
}

/**
 * 打开 file,在同一视图里交替把设置 id 设成 on / off 各测两轮(先预热一轮),取各项最小值比较每次操作多出的耗时。
 * 结果打到日志与用例注释。
 */
export async function compareSettingCost(
  window: Page,
  file: string,
  horizontal: boolean,
  id: string,
  onValue: string | boolean,
  offValue: string | boolean,
): Promise<void> {
  await openWorkspaceFile(window, [file]);
  await expect(window.locator('.cm-content').first()).toBeVisible({ timeout: 30_000 });
  await window.locator('.cm-content').first().click();
  await waitForTestHooks(window);
  const set = (v: string | boolean) =>
    window.evaluate(([key, value]) => globalThis.__continuoTest!.setSettingValue(key as string, value as string | boolean), [id, v] as const);
  // 预热一轮,再交替测两轮取最小值(降低偶发卡顿的影响)
  await measure(window, horizontal);
  const on: Timing[] = [];
  const off: Timing[] = [];
  for (let round = 0; round < 2; round++) {
    await set(onValue);
    on.push(await measure(window, horizontal));
    await set(offValue);
    off.push(await measure(window, horizontal));
  }
  const best = (xs: Timing[], k: keyof Timing) => Math.min(...xs.map((x) => x[k]));
  const report = (['scroll', 'cursor', 'type'] as const).map((k) => `${k} on=${best(on, k).toFixed(1)}ms off=${best(off, k).toFixed(1)}ms`);
  console.log(`[perf ${id}] ${file}: ${report.join(' | ')}`);
  test.info().annotations.push({ type: 'perf', description: `${id} ${file}: ${report.join(' | ')}` });
  // 每次操作多出的耗时:滚动一步(两帧)< 8ms、移动光标 / 输入一次 < 3ms(远小于一帧 16ms,按住方向键 / 连续输入不掉帧)
  const ops = { scroll: 20, cursor: 200, type: 100 } as const;
  const budget = { scroll: 8, cursor: 3, type: 3 } as const;
  for (const k of ['scroll', 'cursor', 'type'] as const) {
    expect((best(on, k) - best(off, k)) / ops[k], `${file} ${k} 每次多出的耗时(ms)`).toBeLessThan(budget[k]);
  }
}
