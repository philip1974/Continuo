// BDD:窗口几何的显示器校验 / 新窗口错开 / popout features 解析。见同目录 README 第 1、2 条。
import { describe, expect, it } from 'vitest';
import {
  ensureNoOverlap,
  fitRectToDisplays,
  newWindowBounds,
  popoutWindowBounds,
} from '../../../electron/main/lib/window-state';

const PRIMARY = { x: 0, y: 25, width: 1440, height: 875 };
const RIGHT = { x: 1440, y: 0, width: 1920, height: 1080 };

describe('fitRectToDisplays(VSCode validateWindowState 思路)', () => {
  it('完全在某显示器工作区内 → 原样采用', () => {
    const r = { x: 100, y: 100, width: 1000, height: 700 };
    expect(fitRectToDisplays(r, [PRIMARY, RIGHT])).toEqual(r);
  });

  it('在第二块显示器上 → 原样采用(多显示器坐标)', () => {
    const r = { x: 2000, y: 200, width: 1200, height: 800 };
    expect(fitRectToDisplays(r, [PRIMARY, RIGHT])).toEqual(r);
  });

  it('所在显示器已拔掉(与任何工作区无交集)→ null(按新窗口处理)', () => {
    expect(fitRectToDisplays({ x: 2000, y: 200, width: 1200, height: 800 }, [PRIMARY])).toBeNull();
  });

  it('交集不足 128px(只露出一条边)→ null', () => {
    expect(fitRectToDisplays({ x: 1400, y: 100, width: 800, height: 600 }, [PRIMARY])).toBeNull();
    expect(fitRectToDisplays({ x: 100, y: 850, width: 800, height: 600 }, [PRIMARY])).toBeNull();
  });

  it('交集足够但部分越界 → 平移进工作区(标题栏可达),尺寸超出则收进工作区', () => {
    expect(fitRectToDisplays({ x: -200, y: 0, width: 800, height: 600 }, [PRIMARY])).toEqual({
      x: 0,
      y: 25,
      width: 800,
      height: 600,
    });
    expect(fitRectToDisplays({ x: 10, y: 30, width: 3000, height: 2000 }, [PRIMARY])).toEqual(PRIMARY);
  });

  it('跨两块显示器 → 取交集最大的那块并收进去', () => {
    const r = { x: 1000, y: 100, width: 1000, height: 600 };
    expect(fitRectToDisplays(r, [PRIMARY, RIGHT])).toEqual({ x: 1440, y: 100, width: 1000, height: 600 });
  });

  it('非有限值 / 非正尺寸 → null', () => {
    expect(fitRectToDisplays({ x: Number.NaN, y: 0, width: 800, height: 600 }, [PRIMARY])).toBeNull();
    expect(fitRectToDisplays({ x: 0, y: 0, width: 0, height: 600 }, [PRIMARY])).toBeNull();
    expect(fitRectToDisplays({ x: 0, y: 0, width: 800, height: 600 }, [])).toBeNull();
  });
});

describe('新窗口(VSCode getNewWindowState + ensureNoOverlap)', () => {
  it('默认 1280×800 在给定显示器工作区居中', () => {
    expect(newWindowBounds(PRIMARY, [])).toEqual({ x: 80, y: 63, width: 1280, height: 800 });
  });

  it('工作区比默认尺寸小 → 收进工作区', () => {
    expect(newWindowBounds({ x: 0, y: 0, width: 1024, height: 700 }, [])).toEqual({ x: 0, y: 0, width: 1024, height: 700 });
  });

  it('已有窗口与其同 x 或同 y → 各 +10 直到不重合', () => {
    const at = { x: 80, y: 63, width: 1280, height: 800 };
    expect(ensureNoOverlap(at, [at])).toEqual({ ...at, x: 90, y: 73 });
    expect(ensureNoOverlap(at, [at, { ...at, x: 90, y: 73 }])).toEqual({ ...at, x: 100, y: 83 });
    expect(ensureNoOverlap(at, [{ x: 500, y: 500, width: 10, height: 10 }])).toEqual(at);
  });

  it('newWindowBounds 带已开窗口 → 错开后仍在工作区内', () => {
    const first = newWindowBounds(PRIMARY, []);
    const second = newWindowBounds(PRIMARY, [first]);
    expect(second).toEqual({ ...first, x: first.x + 10, y: first.y + 10 });
  });
});

describe('popout 子窗 features(dockview PopoutWindow 的 window.open 参数,屏幕坐标)', () => {
  it('解析 left/top/width/height(取整)并按显示器校验', () => {
    expect(popoutWindowBounds('top=200.4,left=300.6,width=640,height=480', [PRIMARY], PRIMARY)).toEqual({
      x: 301,
      y: 200,
      width: 640,
      height: 480,
    });
  });

  it('不足最小尺寸 400×270 → 抬到最小尺寸', () => {
    expect(popoutWindowBounds('top=100,left=100,width=120,height=80', [PRIMARY], PRIMARY)).toEqual({
      x: 100,
      y: 100,
      width: 400,
      height: 270,
    });
  });

  it('部分越界但看得见 → 收进所在工作区(同主窗 containIn)', () => {
    expect(popoutWindowBounds('top=-100,left=3000,width=640,height=480', [PRIMARY, RIGHT], PRIMARY)).toEqual({
      x: 2720,
      y: 0,
      width: 640,
      height: 480,
    });
  });

  it('位置不在任何显示器上(屏已拔掉 / Windows 负坐标)→ 默认 800×600 在主显示器工作区居中,明确给出 x / y', () => {
    expect(popoutWindowBounds('top=100,left=9000,width=1600,height=1000', [PRIMARY], PRIMARY)).toEqual({
      x: 320,
      y: 163,
      width: 800,
      height: 600,
    });
    expect(popoutWindowBounds('top=-2000,left=-3000,width=640,height=480', [PRIMARY, RIGHT], PRIMARY)).toEqual({
      x: 320,
      y: 163,
      width: 800,
      height: 600,
    });
  });

  it('主显示器比默认尺寸小 → 收进主显示器工作区', () => {
    const small = { x: 0, y: 0, width: 700, height: 500 };
    expect(popoutWindowBounds('top=0,left=9000,width=640,height=480', [small], small)).toEqual({
      x: 0,
      y: 0,
      width: 700,
      height: 500,
    });
  });

  it('无 features / 畸形值 → 默认 800×600 在主显示器居中', () => {
    const centered = { x: 320, y: 163, width: 800, height: 600 };
    expect(popoutWindowBounds('', [PRIMARY], PRIMARY)).toEqual(centered);
    expect(popoutWindowBounds('top=abc,left=,width=Infinity,height=-5', [PRIMARY], PRIMARY)).toEqual(centered);
  });
});
