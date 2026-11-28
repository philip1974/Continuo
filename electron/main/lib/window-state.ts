// 窗口几何的显示器校验与新窗口位置(纯函数,无 electron 依赖;显示器工作区由调用方经 screen 取)。
// 对齐 VSCode:WindowStateValidator.validateWindowState(保存的矩形须落在某个显示器工作区里才采用)、
// windowsStateHandler.getNewWindowState(新窗口在显示器居中)+ ensureNoOverlap(与已开窗口错开 10px)、
// auxiliaryWindowsMainService(解析 window.open features 并同样校验)。BDD: src/__tests__/window-state-restore/

export interface Rect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** 主窗默认尺寸(此前写死在 createMainWindow)。 */
export const DEFAULT_WINDOW_SIZE = { width: 1280, height: 800 } as const;
/** popout 子窗:无 features 尺寸时的默认值(同 Electron window.open 默认)与最小尺寸(同主窗 / VSCode 窗口最小尺寸)。 */
export const DEFAULT_POPOUT_SIZE = { width: 800, height: 600 } as const;
export const MIN_WINDOW_SIZE = { width: 400, height: 270 } as const;
/** 与显示器工作区的交集在两个方向都至少这么多(窗口更小则取窗口尺寸)才算「看得见、拖得回来」(VSCode 单屏校验的 128)。 */
const MIN_VISIBLE_PX = 128;
/** VSCode ensureNoOverlap 的错开步长。 */
const CASCADE_STEP_PX = 10;

function isValidRect(r: Rect): boolean {
  return (
    Number.isFinite(r.x) &&
    Number.isFinite(r.y) &&
    Number.isFinite(r.width) &&
    Number.isFinite(r.height) &&
    r.width > 0 &&
    r.height > 0
  );
}

function overlap(a0: number, aLen: number, b0: number, bLen: number): number {
  return Math.max(0, Math.min(a0 + aLen, b0 + bLen) - Math.max(a0, b0));
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(Math.max(v, lo), Math.max(lo, hi));
}

/** 把矩形收进工作区:尺寸不超过工作区,位置平移进工作区(标题栏总可达)。 */
function containIn(r: Rect, area: Rect): Rect {
  const width = Math.min(r.width, area.width);
  const height = Math.min(r.height, area.height);
  return {
    x: clamp(r.x, area.x, area.x + area.width - width),
    y: clamp(r.y, area.y, area.y + area.height - height),
    width,
    height,
  };
}

/**
 * 保存的窗口矩形能否在当前显示器上使用:取与它交集最大的显示器工作区,交集两个方向都 ≥ 128px(或窗口自身尺寸)
 * 才采用并收进该工作区;否则(显示器已拔掉 / 分辨率变了 / 只露出一条边)返回 null,调用方按新窗口处理。
 */
export function fitRectToDisplays(rect: Rect, workAreas: readonly Rect[]): Rect | null {
  if (!isValidRect(rect)) return null;
  let best: Rect | null = null;
  let bestArea = 0;
  for (const area of workAreas) {
    const w = overlap(rect.x, rect.width, area.x, area.width);
    const h = overlap(rect.y, rect.height, area.y, area.height);
    if (w < Math.min(MIN_VISIBLE_PX, rect.width) || h < Math.min(MIN_VISIBLE_PX, rect.height)) continue;
    if (w * h > bestArea) {
      bestArea = w * h;
      best = area;
    }
  }
  return best ? containIn(rect, best) : null;
}

/** VSCode ensureNoOverlap:只要有已开窗口与它同 x 或同 y,就各 +10px,直到不重合。 */
export function ensureNoOverlap(rect: Rect, existing: readonly Rect[]): Rect {
  let { x, y } = rect;
  while (existing.some((b) => b.x === x || b.y === y)) {
    x += CASCADE_STEP_PX;
    y += CASCADE_STEP_PX;
  }
  return { ...rect, x, y };
}

/** 新窗口(无保存值):默认尺寸(不超过工作区)在该显示器工作区居中,再与已开窗口错开。 */
export function newWindowBounds(workArea: Rect, existing: readonly Rect[]): Rect {
  const width = Math.min(DEFAULT_WINDOW_SIZE.width, workArea.width);
  const height = Math.min(DEFAULT_WINDOW_SIZE.height, workArea.height);
  const centered = {
    x: Math.round(workArea.x + (workArea.width - width) / 2),
    y: Math.round(workArea.y + (workArea.height - height) / 2),
    width,
    height,
  };
  return ensureNoOverlap(centered, existing);
}

/** 解析 window.open features 里的一个数值项(非有限 / 缺失 → undefined)。 */
function featureNumber(features: Map<string, string>, key: string): number | undefined {
  const raw = features.get(key);
  if (raw === undefined || raw.trim() === '') return undefined;
  const n = Number(raw);
  return Number.isFinite(n) ? Math.round(n) : undefined;
}

/**
 * popout 位置不可用时的状态(VSCode defaultAuxWindowState):默认尺寸(不超过工作区)在**主显示器**工作区居中,显式给出 x / y ——
 * 只给尺寸时 window.open 的 features 位置(可能是已拔掉的屏、Windows 上的负坐标)仍可能被采用,窗口拖不回来。
 */
export function defaultPopoutBounds(primaryWorkArea: Rect): Rect {
  const width = Math.min(DEFAULT_POPOUT_SIZE.width, primaryWorkArea.width);
  const height = Math.min(DEFAULT_POPOUT_SIZE.height, primaryWorkArea.height);
  return containIn(
    {
      x: Math.round(primaryWorkArea.x + (primaryWorkArea.width - width) / 2),
      y: Math.round(primaryWorkArea.y + (primaryWorkArea.height - height) / 2),
      width,
      height,
    },
    primaryWorkArea,
  );
}

/**
 * popout 子窗的位置 / 尺寸:dockview 经 window.open features 传 `left/top`(屏幕坐标)与 `width/height`(内容尺寸)。
 * 尺寸不小于最小尺寸;位置按显示器校验(收进所在工作区),通不过(或缺失)→ 默认尺寸在主显示器居中(同 VSCode
 * auxiliaryWindowsMainService:`validateWindowState(...) ?? defaultAuxWindowState()`)。总是给出明确的 x / y。
 */
export function popoutWindowBounds(featuresString: string, workAreas: readonly Rect[], primaryWorkArea: Rect): Rect {
  const features = new Map<string, string>();
  for (const part of featuresString.split(',')) {
    const eq = part.indexOf('=');
    if (eq <= 0) continue;
    features.set(part.slice(0, eq).trim().toLowerCase(), part.slice(eq + 1).trim());
  }
  const w = featureNumber(features, 'width');
  const h = featureNumber(features, 'height');
  const width = Math.max(MIN_WINDOW_SIZE.width, w !== undefined && w > 0 ? w : DEFAULT_POPOUT_SIZE.width);
  const height = Math.max(MIN_WINDOW_SIZE.height, h !== undefined && h > 0 ? h : DEFAULT_POPOUT_SIZE.height);
  const x = featureNumber(features, 'left');
  const y = featureNumber(features, 'top');
  const fitted = x === undefined || y === undefined ? null : fitRectToDisplays({ x, y, width, height }, workAreas);
  return fitted ?? defaultPopoutBounds(primaryWorkArea);
}

// ─── 多显示器:建窗后再设一次 bounds(VSCode CodeWindow.applyState) ───

interface WindowBoundsTarget {
  setBounds(bounds: Rect): void;
  getBounds(): Rect;
  getContentBounds(): Rect;
}

/**
 * VSCode `applyState`(issue #74872 / #146499):macOS / Windows 多显示器时,目标屏分辨率比主屏大,BrowserWindow 构造参数给的
 * bounds 不一定按目标屏生效(尺寸 / 位置偏),建窗后再 `setBounds` 一次。单屏 / Linux 不做(VSCode 同)。
 */
export function shouldReapplyBounds(platform: string, displayCount: number): boolean {
  return (platform === 'darwin' || platform === 'win32') && displayCount > 1;
}

/**
 * 按 shouldReapplyBounds 再设一次 bounds。`useContentSize`:bounds 的宽高是内容尺寸(popout 按 dockview 的 innerWidth /
 * innerHeight 建窗),按当前窗框(外框 − 内容)换算成外框再设;x / y 始终是窗口左上角。
 */
export function reapplyWindowBounds(
  win: WindowBoundsTarget,
  bounds: Rect,
  env: { readonly platform: string; readonly displayCount: number },
  useContentSize = false,
): void {
  if (!shouldReapplyBounds(env.platform, env.displayCount) || !isValidRect(bounds)) return;
  let { width, height } = bounds;
  if (useContentSize) {
    const outer = win.getBounds();
    const content = win.getContentBounds();
    width += Math.max(0, outer.width - content.width);
    height += Math.max(0, outer.height - content.height);
  }
  win.setBounds({ x: bounds.x, y: bounds.y, width, height });
}
