// BDD:popout 子窗最大化 / 全屏时退出,重启恢复对应状态,还原后回到原来的普通尺寸(VSCode 辅助窗口 bounds + mode)。
// 见同目录 README 第 2 条「popout 最大化 / 全屏」。真实窗口行为由 e2e window-state-restart 覆盖。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  _resetPopoutWindowModes,
  applyPopoutWindowMode,
  claimPopoutWindowMode,
  forwardPopoutWindowState,
  notePopoutWindowModes,
  restorablePopoutWindowModes,
  splitPopoutWindowModes,
  takeClaimedPopoutWindowMode,
  type PopoutChildWindow,
} from '../../../electron/main/popout-window-state';
import { isPopoutWindowStatePayload, WINDOW_CHANNELS } from '../../../electron/shared/window-channels';

let pushState: ((payload: unknown) => void) | null = null;
vi.mock('@/lib/co-api', () => ({
  coApi: {
    window: {
      onPopoutState: (cb: (payload: unknown) => void) => {
        pushState = cb;
        return () => {
          pushState = null;
        };
      },
    },
  },
}));

import {
  _resetPopoutWindowStates,
  installPopoutWindowStateTracking,
  onPopoutWindowStateChange,
  withPopoutWindowStates,
} from '../../shell/dock/popout-window-state';

const read = (rel: string): string => readFileSync(join(process.cwd(), rel), 'utf8');
const NORMAL = { left: 300, top: 120, width: 640, height: 480 };
const FULL = { left: 0, top: 25, width: 1512, height: 919 };

beforeEach(() => {
  _resetPopoutWindowModes();
  _resetPopoutWindowStates();
});

describe('main:子窗状态推送(最大化 / 全屏 / 普通矩形)', () => {
  function fakeChild() {
    const listeners = new Map<string, Array<() => void>>();
    const st = { maximized: false, fullscreen: false, visible: true };
    // 普通矩形:外框 = 内容 + 标题栏 28px;最大化铺满工作区;全屏时标题栏隐藏(外框 = 内容)。
    const normal = { x: 300, y: 120, width: 640, height: 508 };
    const child: PopoutChildWindow & { emit(e: string): void } = {
      on: (event, cb) => listeners.set(event, [...(listeners.get(event) ?? []), cb]),
      emit: (event) => listeners.get(event)?.forEach((cb) => cb()),
      isDestroyed: () => false,
      isVisible: () => st.visible,
      isMaximized: () => st.maximized,
      isFullScreen: () => st.fullscreen,
      isNormal: () => !st.maximized && !st.fullscreen,
      getBounds: () => (st.fullscreen ? { x: 0, y: 0, width: 1512, height: 982 } : st.maximized ? { x: 0, y: 25, width: 1512, height: 947 } : normal),
      getContentBounds: () => {
        const b = child.getBounds();
        return st.fullscreen ? b : { x: b.x, y: b.y + 28, width: b.width, height: b.height - 28 };
      },
      getNormalBounds: () => normal,
      maximize: () => {
        st.maximized = true;
        child.emit('maximize');
      },
      setFullScreen: (flag) => {
        st.fullscreen = flag;
        child.emit(flag ? 'enter-full-screen' : 'leave-full-screen');
      },
      webContents: { isDestroyed: () => false, mainFrame: { name: 'dv-1-2' } },
    };
    return Object.assign(child, { st });
  }

  it('建窗时推一次普通状态;最大化 / 全屏后推状态与普通矩形(窗口左上角 + 内容尺寸,窗框按普通状态时量的)', () => {
    const child = fakeChild();
    const opener = { isDestroyed: () => false, send: vi.fn() };
    forwardPopoutWindowState(child, opener);
    const last = () => opener.send.mock.calls.at(-1)!;
    expect(last()).toEqual([WINDOW_CHANNELS.POPOUT_STATE, { name: 'dv-1-2', state: { mode: 'normal', bounds: NORMAL } }]);
    expect(isPopoutWindowStatePayload(last()[1])).toBe(true);

    applyPopoutWindowMode(child, 'maximized');
    expect(last()[1]).toEqual({ name: 'dv-1-2', state: { mode: 'maximized', bounds: NORMAL } });
    child.emit('resize'); // 最大化中的 resize 不改窗框尺寸
    expect(last()[1]).toEqual({ name: 'dv-1-2', state: { mode: 'maximized', bounds: NORMAL } });

    const fs = fakeChild();
    const opener2 = { isDestroyed: () => false, send: vi.fn() };
    forwardPopoutWindowState(fs, opener2);
    applyPopoutWindowMode(fs, 'fullscreen');
    expect(opener2.send.mock.calls.at(-1)![1]).toEqual({ name: 'dv-1-2', state: { mode: 'fullscreen', bounds: NORMAL } });
  });

  it('全屏请求被系统忽略(别的窗口正在进出全屏空间)→ 隔 1s 重试,最多 3 次;进入后不再请求', () => {
    vi.useFakeTimers();
    try {
      const child = fakeChild();
      let ignore = 2;
      const calls: boolean[] = [];
      child.setFullScreen = (flag) => {
        calls.push(flag);
        if (ignore > 0) {
          ignore -= 1;
          return;
        }
        child.st.fullscreen = flag;
        child.emit('enter-full-screen');
      };
      applyPopoutWindowMode(child, 'fullscreen');
      expect(calls).toHaveLength(1);
      vi.advanceTimersByTime(1000);
      expect(calls).toHaveLength(2);
      vi.advanceTimersByTime(1000);
      expect(calls).toHaveLength(3);
      expect(child.isFullScreen()).toBe(true);
      vi.advanceTimersByTime(5000);
      expect(calls).toHaveLength(3);
      // 一直被忽略:最多 3 次
      const stubborn = fakeChild();
      const n: boolean[] = [];
      stubborn.setFullScreen = (flag) => void n.push(flag);
      applyPopoutWindowMode(stubborn, 'fullscreen');
      vi.advanceTimersByTime(10_000);
      expect(n).toHaveLength(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it('主窗已销毁 → 不推', () => {
    const child = fakeChild();
    const opener = { isDestroyed: () => true, send: vi.fn() };
    forwardPopoutWindowState(child, opener);
    child.emit('maximize');
    expect(opener.send).not.toHaveBeenCalled();
  });

  it('隐藏中的子窗不推(⌘Q 退出先隐藏全部窗口,其间的状态不可信);订阅时已量好窗框,恢复以隐藏方式建窗也换算对', () => {
    const child = fakeChild();
    child.st.visible = false; // 恢复的子窗 show:false 建出
    const opener = { isDestroyed: () => false, send: vi.fn() };
    forwardPopoutWindowState(child, opener);
    expect(opener.send).not.toHaveBeenCalled();
    child.st.visible = true; // showInactive
    applyPopoutWindowMode(child, 'fullscreen');
    expect(opener.send.mock.calls.at(-1)![1]).toEqual({ name: 'dv-1-2', state: { mode: 'fullscreen', bounds: NORMAL } });
    child.st.visible = false; // 退出流程隐藏窗口时退出全屏
    child.setFullScreen(false);
    expect(opener.send).toHaveBeenCalledTimes(1);
  });

  it('接线:did-create-window 先订阅(普通状态下量窗框)再套用认领到的状态;恢复开窗时按 features 认领', () => {
    const src = read('electron/main/index.ts');
    const created = src.slice(src.indexOf("contents.on('did-create-window'"));
    const body = created.slice(0, created.indexOf('});'));
    const fwd = body.indexOf('forwardPopoutWindowState(child, contents)');
    expect(fwd).toBeGreaterThan(-1);
    expect(fwd).toBeLessThan(body.indexOf('applyPopoutWindowMode(child, mode)'));
    expect(body).toMatch(/takeClaimedPopoutWindowMode\(contents\.id, frameName\)/);
    const handler = src.slice(src.indexOf('function windowOpenHandler('));
    expect(handler.slice(0, handler.indexOf("return { action: 'deny' };\n}"))).toMatch(
      /if \(restoring\) claimPopoutWindowMode\(openerId, frameName, features\)/,
    );
    const ipc = read('electron/main/ipc.ts');
    expect(ipc).toMatch(/notePopoutWindowModes\(senderId, restorablePopoutWindowModes\(layout, entry\?\.popoutWindowModes\)\)/);
    expect(ipc).toMatch(/const \{ layout, modes \} = splitPopoutWindowModes\(json\)/);
  });
});

describe('main:布局里的 windowMode 摘出来存窗口段;恢复时按位置认领', () => {
  const layout = (windowMode?: unknown, position = NORMAL) => ({
    grid: {},
    popoutGroups: [
      { data: { id: '2', views: ['a'] }, position, ...(windowMode === undefined ? null : { windowMode }) },
      { data: { id: '5', views: ['b'] }, position: { left: 10, top: 10, width: 500, height: 400 } },
    ],
  });

  it('layout:write:windowMode 不留在布局里,另存 { id, mode, position };没有 windowMode → 原对象', () => {
    const { layout: clean, modes } = splitPopoutWindowModes(layout('maximized'));
    expect(clean).toEqual(layout());
    expect(modes).toEqual([{ id: '2', mode: 'maximized', position: NORMAL }]);
    const plain = layout();
    expect(splitPopoutWindowModes(plain)).toEqual({ layout: plain, modes: [] });
    expect(splitPopoutWindowModes(plain).layout).toBe(plain);
    // 畸形值:摘掉但不存
    expect(splitPopoutWindowModes(layout('huge'))).toEqual({ layout: layout(), modes: [] });
  });

  it('layout:read:组还在、position 与写出时相同才恢复(降级期间旧版本挪过子窗 → 不套用)', () => {
    const modes = [{ id: '2', mode: 'fullscreen' as const, position: NORMAL }];
    expect(restorablePopoutWindowModes(layout(), modes)).toEqual([{ ...NORMAL, mode: 'fullscreen' }]);
    expect(restorablePopoutWindowModes(layout(undefined, FULL), modes)).toEqual([]);
    expect(restorablePopoutWindowModes({ grid: {} }, modes)).toEqual([]);
    expect(restorablePopoutWindowModes(layout(), undefined)).toEqual([]);
  });

  it('恢复开窗:features 位置尺寸对上(容差 1px)→ 该子窗名认领到状态,只取一次;对不上 / 过期 → 没有', () => {
    notePopoutWindowModes(7, [{ ...NORMAL, mode: 'maximized' }], 1000);
    claimPopoutWindowMode(7, 'dv-1-9', 'top=0,left=0,width=500,height=400', 1001);
    expect(takeClaimedPopoutWindowMode(7, 'dv-1-9')).toBeUndefined();
    claimPopoutWindowMode(7, 'dv-1-3', 'top=120.5,left=300,width=640,height=480', 1002);
    expect(takeClaimedPopoutWindowMode(8, 'dv-1-3')).toBeUndefined();
    expect(takeClaimedPopoutWindowMode(7, 'dv-1-3')).toBe('maximized');
    expect(takeClaimedPopoutWindowMode(7, 'dv-1-3')).toBeUndefined();
    // 已认领完 → 再开同位置的子窗(用户主动弹出)不套用
    claimPopoutWindowMode(7, 'dv-1-4', 'top=120,left=300,width=640,height=480', 1003);
    expect(takeClaimedPopoutWindowMode(7, 'dv-1-4')).toBeUndefined();

    notePopoutWindowModes(7, [{ ...NORMAL, mode: 'fullscreen' }], 1000);
    claimPopoutWindowMode(7, 'dv-1-5', 'top=120,left=300,width=640,height=480', 1000 + 60_000);
    expect(takeClaimedPopoutWindowMode(7, 'dv-1-5')).toBeUndefined();
  });
});

describe('renderer:写布局时最大化 / 全屏的子窗存普通矩形 + 状态', () => {
  let stop: (() => void) | null = null;
  afterEach(() => stop?.());

  const api = (names: Record<string, string>) => ({
    getGroup: (id: string) =>
      names[id] === undefined
        ? undefined
        : { api: { location: { type: 'popout', getWindow: () => ({ name: names[id] }) as unknown as Window } } },
  });
  const dockLayout = () => ({
    grid: {},
    popoutGroups: [
      { data: { id: '2' }, position: FULL },
      { data: { id: '5' }, position: { left: 1, top: 2, width: 3, height: 4 } },
    ],
  });

  it('最大化 / 全屏 → position 换成普通矩形并标 windowMode;普通 / 没有状态的组原样;状态变了通知标脏', () => {
    stop = installPopoutWindowStateTracking();
    const changed = vi.fn();
    const off = onPopoutWindowStateChange(changed);
    const l = dockLayout();
    expect(withPopoutWindowStates(l, api({ '2': 'dv-1-2', '5': 'dv-1-5' }))).toBe(l);

    pushState!({ name: 'dv-1-5', state: { mode: 'normal', bounds: { left: 9, top: 9, width: 9, height: 9 } } });
    expect(changed).not.toHaveBeenCalled(); // 普通 → 普通:dockview 自己记位置
    pushState!({ name: 'dv-1-2', state: { mode: 'maximized', bounds: NORMAL } });
    expect(changed).toHaveBeenCalledTimes(1);
    pushState!({ name: 'dv-1-2', state: { mode: 'bogus', bounds: NORMAL } }); // 畸形推送丢弃
    expect(changed).toHaveBeenCalledTimes(1);

    expect(withPopoutWindowStates(dockLayout(), api({ '2': 'dv-1-2', '5': 'dv-1-5' }))).toEqual({
      grid: {},
      popoutGroups: [
        { data: { id: '2' }, position: NORMAL, windowMode: 'maximized' },
        { data: { id: '5' }, position: { left: 1, top: 2, width: 3, height: 4 } },
      ],
    });

    pushState!({ name: 'dv-1-2', state: { mode: 'normal', bounds: NORMAL } });
    expect(changed).toHaveBeenCalledTimes(2); // 还原也要重写(去掉 windowMode)
    expect(withPopoutWindowStates(dockLayout(), api({ '2': 'dv-1-2' }))).toEqual(dockLayout());
    off();
  });

  it('接线:写盘的快照经 withPopoutWindowStates;状态变化标脏并防抖落盘;主窗启动装上订阅', () => {
    const src = read('src/shell/dock/DockShell.tsx');
    expect(src).toMatch(/const raw = withPopoutWindowStates\(api\.toJSON\(\), api\)/);
    expect(src).toMatch(/onPopoutWindowStateChange\(\(\) => \{\s*layoutVersions\.set\(event\.api,[^;]+;\s*persist\(\);/);
    expect(read('src/main-app.ts')).toMatch(/installPopoutWindowStateTracking\(\);/);
  });
});
