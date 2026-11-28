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
// - layout:read 按 `popoutWindowModes` 登记待恢复的状态(按 popoutGroups 顺序);dockview 恢复开窗(按该顺序逐个 window.open,
//   features = 存下的 position)时按开窗次序认领(位置尺寸核对),建窗(普通矩形)后 maximize() / setFullScreen(true)。
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

/** 恢复时第 N 个 popout 组(popoutGroups[N])的开窗 position(没有 / 畸形 → null)与要恢复的状态(没有 → null)。 */
export interface RestoringPopoutGroup {
  readonly position: PersistedPopoutWindowMode['position'] | null;
  readonly mode: PopoutWindowMode | null;
}

/**
 * layout:read:布局里各 popout 组按 popoutGroups 顺序的开窗 position 与待恢复状态。状态只在该组仍在、position 与写出时相同才
 * 恢复(降级到 0.2.15 期间挪过 / 改过的子窗不套用旧状态)。没有任何要恢复的状态 → 空数组。
 */
export function restorablePopoutWindowModes(
  layout: unknown,
  modes: readonly PersistedPopoutWindowMode[] | undefined,
): RestoringPopoutGroup[] {
  if (!modes || modes.length === 0 || !isObj(layout) || !Array.isArray(layout['popoutGroups'])) return [];
  const out: RestoringPopoutGroup[] = [];
  for (const g of layout['popoutGroups'] as unknown[]) {
    const id = isObj(g) && isObj(g['data']) ? g['data']['id'] : undefined;
    const position = isObj(g) ? positionOf(g['position']) : null;
    const saved = modes.find((m) => m.id === id);
    const p = saved?.position;
    const same =
      p !== undefined &&
      position !== null &&
      p.left === position.left &&
      p.top === position.top &&
      p.width === position.width &&
      p.height === position.height;
    out.push({ position, mode: same ? saved!.mode : null });
  }
  return out.some((g) => g.mode !== null) ? out : [];
}

// ─── 恢复登记(layout:read → window.open → did-create-window) ───

const pending = new Map<number, { groups: RestoringPopoutGroup[]; next: number; expiresAt: number }>();
/** windowOpenHandler 认领到状态、等 did-create-window 套用的子窗(键 = 打开者 webContents id + 子窗名)。 */
const claimed = new Map<string, PopoutWindowMode>();
const claimKey = (openerId: number, frameName: string) => `${openerId}\0${frameName}`;

/** layout:read 返回布局时调用:该 webContents 接下来按 popoutGroups 顺序恢复这些子窗(以最新一次为准)。 */
export function notePopoutWindowModes(openerId: number, groups: RestoringPopoutGroup[], now: number = Date.now()): void {
  if (groups.some((g) => g.mode !== null)) {
    pending.set(openerId, { groups: [...groups], next: 0, expiresAt: now + POPOUT_RESTORE_WINDOW_MS });
  } else pending.delete(openerId);
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
 * windowOpenHandler(恢复中的子窗):按组身份认领登记的状态,认领到 → 记给 did-create-window。dockview fromJSON 按 popoutGroups
 * 顺序逐个(间隔 100ms)window.open,子窗名是新分配的组 id(与布局里的组 id 无关),故身份 = 恢复开窗的次序:第 N 次开窗 =
 * popoutGroups[N] —— 两个位置尺寸相同的子窗不会互相认领。features 的 left/top/width/height 须与该组 position 相符(容差 1px:
 * dockview 换算主窗原点时可能有亚像素;没有 position 的组只按次序);不符(前面的组没开出来)→ 往后找第一个相符的组并从那里续上。
 */
export function claimPopoutWindowMode(openerId: number, frameName: string, features: string, now: number = Date.now()): void {
  const entry = pending.get(openerId);
  if (!entry) return;
  if (now > entry.expiresAt) {
    pending.delete(openerId);
    return;
  }
  const f = ['left', 'top', 'width', 'height'].map((k) => featureNumber(features, k));
  const [left, top, width, height] = f;
  const near = (a: number, b: number | undefined) => b !== undefined && Math.abs(a - b) <= 1;
  let i = entry.next;
  for (; i < entry.groups.length; i++) {
    const p = entry.groups[i]!.position;
    if (p === null ? i === entry.next : near(p.left, left) && near(p.top, top) && near(p.width, width) && near(p.height, height)) break;
  }
  if (i >= entry.groups.length) return;
  entry.next = i + 1;
  const { mode } = entry.groups[i]!;
  if (!entry.groups.slice(entry.next).some((g) => g.mode !== null)) pending.delete(openerId);
  if (mode !== null) claimed.set(claimKey(openerId, frameName), mode);
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
