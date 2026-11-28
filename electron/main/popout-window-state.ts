// popout 子窗的窗口状态(普通 / 最大化 / 全屏)与普通矩形:重启恢复对应状态,还原后回到原来的普通尺寸。
// 对齐 VSCode 辅助窗口(src/vs/workbench/services/auxiliaryWindow/electron-browser/auxiliaryWindowService.ts createState():
// bounds + mode(Normal / Maximized / Fullscreen);electron-main/auxiliaryWindowsMainService.ts 按 `window-maximized` /
// `window-fullscreen` 建窗后 applyState)。dockview 只把子窗当时的 screenX/Y + innerWidth/Height 存进 popoutGroups[].position,
// 最大化 / 全屏时存下的就是铺满屏幕的尺寸、也不记状态 → 重启成铺满屏幕的普通窗口,原尺寸丢失。
//
// - main 在子窗 maximize / unmaximize / enter-full-screen / leave-full-screen / resize / move 时把子窗名、状态、普通矩形
//  (getNormalBounds() 换算成 dockview 的 position:窗口左上角 + 内容尺寸)推给打开它的主窗 renderer。
// - renderer 写布局时:非普通状态的子窗 position 改用普通矩形,并在该 popout 组上标 `windowMode`。
// - layout:write 把 `windowMode` 从布局里摘出来,存窗口段的 main 独占字段 `popoutWindowModes`(新增字段 → 旁挂
//   explorer-ext.json,explorer.json 的布局保持 0.2.15 认识的样子;0.2.15 照普通矩形开子窗)。
// - layout:read 按 `popoutWindowModes` 登记待恢复的状态;dockview 恢复开窗(window.open features = 存下的 position)时按
//   位置尺寸认领,建窗(普通矩形)后 maximize() / setFullScreen(true)。
// BDD: src/__tests__/window-state-restore/popout-window-mode.spec.ts

import { WINDOW_CHANNELS, type PopoutWindowMode, type PopoutWindowState } from '../shared/window-channels';
import { POPOUT_RESTORE_WINDOW_MS } from './services/popout-restore-focus.service';

/** 窗口段 `popoutWindowModes` 的一项:popout 组 id、状态、写出时该组的 position(与布局对得上才恢复)。 */
export interface PersistedPopoutWindowMode {
  readonly id: string;
  readonly mode: PopoutWindowMode;
  readonly position: { readonly left: number; readonly top: number; readonly width: number; readonly height: number };
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const isMode = (v: unknown): v is PopoutWindowMode => v === 'maximized' || v === 'fullscreen';

function positionOf(v: unknown): PersistedPopoutWindowMode['position'] | null {
  if (!isObj(v)) return null;
  const { left, top, width, height } = v;
  const ok = [left, top, width, height].every((n) => typeof n === 'number' && Number.isFinite(n));
  return ok ? { left: left as number, top: top as number, width: width as number, height: height as number } : null;
}

/**
 * layout:write:把 popout 组上的 `windowMode` 摘出来(布局里不留),返回干净的布局与要存的状态(没有 → 空数组)。
 * 布局里没有任何 `windowMode` → 原对象返回。
 */
export function splitPopoutWindowModes<T extends Obj>(layout: T): { layout: T; modes: PersistedPopoutWindowMode[] } {
  const groups = layout['popoutGroups'];
  if (!Array.isArray(groups) || !groups.some((g) => isObj(g) && 'windowMode' in g)) return { layout, modes: [] };
  const modes: PersistedPopoutWindowMode[] = [];
  const next = groups.map((g: unknown) => {
    if (!isObj(g) || !('windowMode' in g)) return g;
    const { windowMode, ...rest } = g;
    const id = isObj(rest['data']) ? rest['data']['id'] : undefined;
    const position = positionOf(rest['position']);
    if (isMode(windowMode) && typeof id === 'string' && position) modes.push({ id, mode: windowMode, position });
    return rest;
  });
  return { layout: { ...layout, popoutGroups: next }, modes };
}

/**
 * layout:read:与布局对得上的待恢复状态(该组仍在 popoutGroups 里、position 与写出时相同 —— 降级到 0.2.15 期间挪过 / 改过
 * 的子窗不套用旧状态)。返回各子窗恢复开窗时的 position 与状态。
 */
export function restorablePopoutWindowModes(
  layout: unknown,
  modes: readonly PersistedPopoutWindowMode[] | undefined,
): Array<PersistedPopoutWindowMode['position'] & { mode: PopoutWindowMode }> {
  if (!modes || modes.length === 0 || !isObj(layout) || !Array.isArray(layout['popoutGroups'])) return [];
  const out: Array<PersistedPopoutWindowMode['position'] & { mode: PopoutWindowMode }> = [];
  for (const g of layout['popoutGroups'] as unknown[]) {
    if (!isObj(g) || !isObj(g['data'])) continue;
    const id = g['data']['id'];
    const position = positionOf(g['position']);
    const saved = modes.find((m) => m.id === id);
    if (!saved || !position) continue;
    const p = saved.position;
    if (p.left === position.left && p.top === position.top && p.width === position.width && p.height === position.height) {
      out.push({ ...position, mode: saved.mode });
    }
  }
  return out;
}

// ─── 恢复登记(layout:read → window.open → did-create-window) ───

const pending = new Map<number, { entries: Array<PersistedPopoutWindowMode['position'] & { mode: PopoutWindowMode }>; expiresAt: number }>();
/** windowOpenHandler 认领到状态、等 did-create-window 套用的子窗(键 = 打开者 webContents id + 子窗名)。 */
const claimed = new Map<string, PopoutWindowMode>();
const claimKey = (openerId: number, frameName: string) => `${openerId}\0${frameName}`;

/** layout:read 返回布局时调用:该 webContents 接下来恢复的子窗里,这些 position 的要恢复成最大化 / 全屏(以最新一次为准)。 */
export function notePopoutWindowModes(
  openerId: number,
  entries: Array<PersistedPopoutWindowMode['position'] & { mode: PopoutWindowMode }>,
  now: number = Date.now(),
): void {
  if (entries.length > 0) pending.set(openerId, { entries: [...entries], expiresAt: now + POPOUT_RESTORE_WINDOW_MS });
  else pending.delete(openerId);
}

function featureNumber(features: string, key: string): number | undefined {
  for (const part of features.split(',')) {
    const eq = part.indexOf('=');
    if (eq > 0 && part.slice(0, eq).trim().toLowerCase() === key) {
      const n = Number(part.slice(eq + 1).trim());
      return Number.isFinite(n) ? n : undefined;
    }
  }
  return undefined;
}

/**
 * windowOpenHandler(恢复中的子窗):按 window.open features 的 left/top/width/height 认领登记的状态(容差 1px:dockview
 * 换算主窗原点时可能有亚像素),认领到 → 记给 did-create-window。
 */
export function claimPopoutWindowMode(openerId: number, frameName: string, features: string, now: number = Date.now()): void {
  const entry = pending.get(openerId);
  if (!entry) return;
  if (now > entry.expiresAt) {
    pending.delete(openerId);
    return;
  }
  const f = ['left', 'top', 'width', 'height'].map((k) => featureNumber(features, k));
  if (f.some((n) => n === undefined)) return;
  const [left, top, width, height] = f as number[];
  const near = (a: number, b: number) => Math.abs(a - b) <= 1;
  const i = entry.entries.findIndex(
    (e) => near(e.left, left!) && near(e.top, top!) && near(e.width, width!) && near(e.height, height!),
  );
  if (i < 0) return;
  const [hit] = entry.entries.splice(i, 1);
  if (entry.entries.length === 0) pending.delete(openerId);
  claimed.set(claimKey(openerId, frameName), hit!.mode);
}

/** did-create-window:取走认领到的状态(没有 → undefined)。 */
export function takeClaimedPopoutWindowMode(openerId: number, frameName: string): PopoutWindowMode | undefined {
  const key = claimKey(openerId, frameName);
  const mode = claimed.get(key);
  claimed.delete(key);
  return mode;
}

/** 测试用。 */
export function _resetPopoutWindowModes(): void {
  pending.clear();
  claimed.clear();
}

// ─── 子窗状态推送 ───

interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface PopoutChildWindow {
  on(event: 'maximize' | 'unmaximize' | 'enter-full-screen' | 'leave-full-screen' | 'resize' | 'move', listener: () => void): unknown;
  isDestroyed(): boolean;
  isVisible(): boolean;
  isMaximized(): boolean;
  isFullScreen(): boolean;
  isNormal(): boolean;
  getBounds(): Rect;
  getContentBounds(): Rect;
  getNormalBounds(): Rect;
  maximize(): void;
  setFullScreen(flag: boolean): void;
  readonly webContents: { isDestroyed(): boolean; readonly mainFrame: { readonly name: string } };
}

interface PopoutOpener {
  isDestroyed(): boolean;
  send(channel: string, ...args: unknown[]): void;
}

/**
 * 订阅子窗状态变化推给 opener,并立即推一次当前状态。窗框尺寸(标题栏等;窗口外框 − 内容)只在普通状态下量(全屏时
 * 标题栏隐藏、外框 = 内容),换算普通矩形的内容尺寸用最近一次量到的值;订阅时先量一次(须在套用恢复状态之前调用,
 * 建窗时是普通状态)。隐藏中的子窗不推(⌘Q 退出流程先隐藏全部窗口,其间的状态不可信 —— 同主窗 windowState)。
 */
export function forwardPopoutWindowState(child: PopoutChildWindow, opener: PopoutOpener): void {
  let frame = { width: 0, height: 0 };
  const measureFrame = () => {
    if (!child.isNormal()) return;
    const b = child.getBounds();
    const c = child.getContentBounds();
    frame = { width: Math.max(0, b.width - c.width), height: Math.max(0, b.height - c.height) };
  };
  const send = () => {
    if (opener.isDestroyed() || child.isDestroyed() || child.webContents.isDestroyed() || !child.isVisible()) return;
    measureFrame();
    const n = child.getNormalBounds();
    const state: PopoutWindowState = {
      mode: child.isFullScreen() ? 'fullscreen' : child.isMaximized() ? 'maximized' : 'normal',
      bounds: { left: n.x, top: n.y, width: Math.max(1, n.width - frame.width), height: Math.max(1, n.height - frame.height) },
    };
    opener.send(WINDOW_CHANNELS.POPOUT_STATE, { name: child.webContents.mainFrame.name, state });
  };
  measureFrame();
  for (const event of ['maximize', 'unmaximize', 'enter-full-screen', 'leave-full-screen', 'resize', 'move'] as const) {
    child.on(event, send);
  }
  send();
}

/** 全屏请求没生效时的重试间隔与次数(见 applyPopoutWindowMode)。 */
export const POPOUT_FULLSCREEN_RETRY_MS = 1000;
export const POPOUT_FULLSCREEN_RETRIES = 3;

/**
 * did-create-window:套用恢复的状态(子窗以普通矩形建出)。全屏:macOS 在别的窗口进出全屏空间的过渡动画期间(如上次退出时
 * 全屏的子窗刚被销毁)会忽略 setFullScreen —— 没进入就隔 1s 再请求,最多 3 次;期间用户自己操作过窗口(进入过全屏 / 最大化)不再重试。
 */
export function applyPopoutWindowMode(child: PopoutChildWindow, mode: PopoutWindowMode | undefined): void {
  if (mode === 'maximized') {
    child.maximize();
    return;
  }
  if (mode !== 'fullscreen') return;
  let tries = 0;
  let settled = false;
  child.on('enter-full-screen', () => {
    settled = true;
  });
  child.on('maximize', () => {
    settled = true;
  });
  const request = () => {
    if (settled || child.isDestroyed() || child.isFullScreen()) return;
    child.setFullScreen(true);
    tries += 1;
    if (tries < POPOUT_FULLSCREEN_RETRIES) setTimeout(request, POPOUT_FULLSCREEN_RETRY_MS);
  };
  request();
}
