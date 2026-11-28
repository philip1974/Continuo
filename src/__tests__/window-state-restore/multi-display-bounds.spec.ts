// BDD:多显示器时建窗后再设一次 bounds(VSCode CodeWindow.applyState / auxiliaryWindow.applyState,issue #74872 / #146499)。
// 见同目录 README 第 4 条。
import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { reapplyWindowBounds, shouldReapplyBounds } from '../../../electron/main/lib/window-state';

const read = (rel: string): string => readFileSync(join(process.cwd(), rel), 'utf8');

/** screen mock:返回 n 块显示器(只关心数量)。 */
const screenWith = (n: number) => ({ getAllDisplays: () => Array.from({ length: n }, (_, i) => ({ id: i })) });
const envOf = (platform: string, screen: ReturnType<typeof screenWith>) => ({
  platform,
  displayCount: screen.getAllDisplays().length,
});

function fakeWin() {
  return {
    setBounds: vi.fn(),
    // 外框比内容多一个 28px 标题栏
    getBounds: () => ({ x: 0, y: 0, width: 800, height: 628 }),
    getContentBounds: () => ({ x: 0, y: 28, width: 800, height: 600 }),
  };
}

describe('多显示器建窗后再设一次 bounds', () => {
  const target = { x: 2000, y: 100, width: 1200, height: 800 };

  it('macOS / Windows 且多于一块显示器才再设;单屏 / Linux 不设(VSCode 同)', () => {
    expect(shouldReapplyBounds('darwin', 2)).toBe(true);
    expect(shouldReapplyBounds('win32', 3)).toBe(true);
    expect(shouldReapplyBounds('darwin', 1)).toBe(false);
    expect(shouldReapplyBounds('linux', 2)).toBe(false);
    for (const [platform, n, calls] of [
      ['darwin', 2, 1],
      ['win32', 2, 1],
      ['darwin', 1, 0],
      ['linux', 2, 0],
    ] as const) {
      const win = fakeWin();
      reapplyWindowBounds(win, target, envOf(platform, screenWith(n)));
      expect(win.setBounds).toHaveBeenCalledTimes(calls);
      if (calls) expect(win.setBounds).toHaveBeenCalledWith(target);
    }
  });

  it('popout(useContentSize):宽高是内容尺寸 → 加上窗框换算成外框;x / y 是窗口左上角', () => {
    const win = fakeWin();
    reapplyWindowBounds(win, { x: 1500, y: 40, width: 640, height: 480 }, envOf('darwin', screenWith(2)), true);
    expect(win.setBounds).toHaveBeenCalledWith({ x: 1500, y: 40, width: 640, height: 508 });
  });

  it('bounds 无效(非有限 / 非正)→ 不设', () => {
    const win = fakeWin();
    reapplyWindowBounds(win, { x: Number.NaN, y: 0, width: 10, height: 10 }, envOf('darwin', screenWith(2)));
    reapplyWindowBounds(win, { x: 0, y: 0, width: 0, height: 10 }, envOf('darwin', screenWith(2)));
    expect(win.setBounds).not.toHaveBeenCalled();
  });

  it('接线:主窗建窗后先再设 bounds 再恢复最大化 / 全屏;popout 在 did-create-window 里先再设 bounds 再量窗框 / 套用状态', () => {
    const src = read('electron/main/index.ts');
    const create = src.slice(src.indexOf('export function createMainWindow('));
    const reapply = create.indexOf('reapplyWindowBounds(win, placement.bounds, displayEnv());');
    expect(reapply).toBeGreaterThan(-1);
    expect(reapply).toBeLessThan(create.indexOf('if (placement.isMaximized) win.maximize();'));
    expect(reapply).toBeLessThan(create.indexOf('if (placement.isFullScreen) win.setFullScreen(true);'));
    expect(src).toMatch(/function displayEnv\(\)[^]*?displayCount: screen\.getAllDisplays\(\)\.length/);

    const created = src.slice(src.indexOf("contents.on('did-create-window'"));
    const body = created.slice(0, created.indexOf('});'));
    const popoutReapply = body.indexOf('reapplyPopoutBounds(child, options);');
    expect(popoutReapply).toBeGreaterThan(-1);
    expect(popoutReapply).toBeLessThan(body.indexOf('forwardPopoutWindowState(child, contents)'));
    expect(popoutReapply).toBeLessThan(body.indexOf('applyPopoutWindowMode(child, mode)'));
    expect(src).toMatch(
      /reapplyWindowBounds\(child, \{ x, y, width, height \}, displayEnv\(\), options\.useContentSize === true\)/,
    );
    // popout 建窗参数总带明确位置(位置不可用时主显示器居中),不再交给 Electron 居中
    const handler = src.slice(src.indexOf('function windowOpenHandler('));
    const allow = handler.slice(0, handler.indexOf("return { action: 'deny' };\n}"));
    expect(allow).toMatch(/popoutWindowBounds\(features, displayWorkAreas\(\), screen\.getPrimaryDisplay\(\)\.workArea\)/);
    expect(allow).not.toMatch(/center:/);
  });
});
