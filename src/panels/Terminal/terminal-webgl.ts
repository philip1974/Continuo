// 终端 WebGL 渲染器的装 / 卸(对齐 VSCode xtermTerminal 的 _enableWebglRenderer / _disposeOfWebglRenderer / onContextLoss /
// updateGpuRendererWindow)。
//
// Chromium 每个渲染进程最多同时 16 个活动 WebGL 上下文(popout 子窗与主窗同进程),超出时丢弃最早创建的那个 —— 往往正是用户正在看
// 的终端:白底哭脸约 3 秒(addon 等待上下文恢复)后降为 DOM 渲染,且之后一直是 DOM(DOM 渲染会裁 CJK 末尾,见 useTerminal)。
// 这里给所有终端共用一个上限 MAX_TERMINAL_WEBGL(低于 16,留余量给其它 WebGL 用途):可见终端需要装而名额已满时,先卸掉最久没
// 显示的隐藏终端(隐藏终端回退 DOM 无可见代价,重新可见时再装)。只在名额满时才卸隐藏终端 —— 终端不多时切 tab 不重建渲染器
//(重建 = 同步 GPU 初始化 + 纹理图集重建,几十 ms)。
//
// 上下文丢失(GPU 重置、驱动问题等):卸掉 addon 回退 DOM;可见时按退避重试,累计丢失 WEBGL_RETRY_LIMIT 次后不再重试(防抖动)。
// 纹理图集按配置在终端间共享(addon-webgl 的 acquireTextureAtlas 引用计数),卸 / 装只增减引用;页版本碰撞已由 Vite transform 修正
//(scripts/vite-xterm-webgl-atlas-version.ts),多终端同时显示不乱码。
// BDD: src/__tests__/terminal-webgl/

import type { Terminal } from '@xterm/xterm';
import { WebglAddon } from '@xterm/addon-webgl';
import { installAtlasGuards } from '@continuo-terminal/react-terminal';

/** 所有终端同时持有 WebGL 上下文的上限(Chromium 上限 16)。 */
export const MAX_TERMINAL_WEBGL = 12;
/** 上下文丢失后的重试次数上限;第 n 次丢失后等 WEBGL_RETRY_BASE_MS · 2^(n-1) 再装。 */
export const WEBGL_RETRY_LIMIT = 3;
export const WEBGL_RETRY_BASE_MS = 1000;

interface WebglAddonLike {
  onContextLoss(cb: () => void): { dispose(): void };
  dispose(): void;
}

export interface TerminalWebglDeps {
  readonly createAddon?: () => WebglAddonLike;
  /** 渲染器换了(装上 / 卸下):cell 尺寸可能不同,调用方重新 fit(VSCode _onDidRequestRefreshDimensions)。 */
  readonly onRendererChange?: () => void;
}

export interface TerminalWebgl {
  /** 面板显隐(dockview onDidVisibilityChange;拆分并排 / popout 子窗里同时可见的都算可见)。可见且未装时下一帧装。 */
  setVisible(visible: boolean): void;
  dispose(): void;
  /** 当前是否在用 WebGL。 */
  readonly active: boolean;
}

interface Slot {
  readonly visible: boolean;
  readonly lastShown: number;
  release(): void;
}

/** 已装 WebGL 的终端(模块级:同一渲染进程里的所有窗口共用)。 */
const installed = new Set<Slot>();
let showClock = 0;

/** 测试用:当前持有 WebGL 的终端数。 */
export function activeTerminalWebglCount(): number {
  return installed.size;
}

/**
 * 终端 WebGL 渲染器 canvas 的上下文(addon 的 canvas 直接挂在 .xterm-screen 下、无 class;链接层等 2d canvas 带 `xterm-*-layer`
 * class,跳过 —— 对已有 2d 上下文的 canvas 取 webgl2 返回 null,不会新建上下文)。
 */
function webglContextOf(term: Terminal): WebGL2RenderingContext | null {
  const screen = term.element?.querySelector?.('.xterm-screen');
  for (const canvas of screen?.querySelectorAll<HTMLCanvasElement>(':scope > canvas') ?? []) {
    if ([...canvas.classList].some((c) => c.startsWith('xterm-'))) continue;
    const gl = canvas.getContext('webgl2');
    if (gl) return gl;
  }
  return null;
}

/**
 * 卸掉 addon 并立即释放其 WebGL 上下文。addon 的 dispose 只移除 canvas,上下文要等垃圾回收才释放 —— 期间仍计入 Chromium 的
 * 16 个上限,让出名额后马上再装,浏览器照样会丢弃最早的上下文(可能正是可见终端)。先取上下文、dispose(摘掉 addon 的
 * contextlost 监听)后再 loseContext。
 */
function disposeAddon(term: Terminal, addon: WebglAddonLike): void {
  let gl: WebGL2RenderingContext | null = null;
  try {
    gl = webglContextOf(term);
  } catch {
    /* 取不到就只 dispose */
  }
  try {
    addon.dispose();
  } catch {
    /* 已随 term 拆除 */
  }
  try {
    gl?.getExtension('WEBGL_lose_context')?.loseContext();
  } catch {
    /* ignore */
  }
}

/** 名额已满:卸掉最久没显示的隐藏终端。全是可见终端则不卸(照装,超出时由浏览器处理)。 */
function makeRoom(): void {
  if (installed.size < MAX_TERMINAL_WEBGL) return;
  let victim: Slot | null = null;
  for (const slot of installed) {
    if (!slot.visible && (!victim || slot.lastShown < victim.lastShown)) victim = slot;
  }
  victim?.release();
}

export function createTerminalWebgl(term: Terminal, deps: TerminalWebglDeps = {}): TerminalWebgl {
  const createAddon = deps.createAddon ?? (() => new WebglAddon());
  let addon: WebglAddonLike | null = null;
  let lossListener: { dispose(): void } | null = null;
  let guards: { dispose(): void } | null = null;
  let addonWindow: Window | null = null;
  let visible = false;
  let losses = 0;
  /** 创建失败(GPU / WebGL2 不可用):不再尝试,一直 DOM(VSCode 同:加载失败即建议 DOM 渲染)。 */
  let unavailable = false;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  /** 待装的帧(装 WebGL 是同步 GPU 初始化,几十 ms:放到下一帧,不压在首屏 / 切 tab 的这一帧里)。 */
  let installFrame: { readonly win: Window | typeof globalThis; readonly id: number } | null = null;
  let disposed = false;

  const termWindow = (): Window | null => term.element?.ownerDocument.defaultView ?? null;

  const slot: Slot = {
    get visible() {
      return visible;
    },
    get lastShown() {
      return lastShown;
    },
    release: () => release(),
  };
  let lastShown = 0;

  function release(): void {
    installed.delete(slot);
    lossListener?.dispose();
    lossListener = null;
    guards?.dispose();
    guards = null;
    addonWindow = null;
    if (!addon) return;
    const old = addon;
    addon = null;
    disposeAddon(term, old);
    deps.onRendererChange?.();
  }

  function cancelInstallFrame(): void {
    if (installFrame) installFrame.win.cancelAnimationFrame(installFrame.id);
    installFrame = null;
  }

  function scheduleInstall(): void {
    if (installFrame || addon || unavailable || losses > WEBGL_RETRY_LIMIT || retryTimer !== undefined) return;
    // 用终端所在窗口的帧(popout 子窗)
    const win = termWindow() ?? globalThis;
    installFrame = {
      win,
      id: win.requestAnimationFrame(() => {
        installFrame = null;
        if (visible) install();
      }),
    };
  }

  function install(): void {
    if (disposed || addon || unavailable || losses > WEBGL_RETRY_LIMIT || retryTimer !== undefined) return;
    makeRoom();
    let next: WebglAddonLike;
    try {
      next = createAddon();
      term.loadAddon(next as unknown as WebglAddon);
    } catch (err) {
      unavailable = true;
      console.warn('[terminal] webgl renderer init failed, falling back to dom:', err);
      return;
    }
    addon = next;
    addonWindow = termWindow();
    installed.add(slot);
    lossListener = next.onContextLoss(onContextLoss);
    // 图集守卫只对启用的 WebGL 有意义(在唤醒 / DPR 变化时 clearTextureAtlas 修字形错乱)
    guards = installAtlasGuards(term);
    deps.onRendererChange?.();
  }

  function onContextLoss(): void {
    release();
    losses += 1;
    if (losses > WEBGL_RETRY_LIMIT) {
      console.warn('[terminal] webgl context lost repeatedly, staying on dom renderer');
      return;
    }
    retryTimer = setTimeout(() => {
      retryTimer = undefined;
      // 隐藏时不装,等重新可见(setVisible)
      if (visible) scheduleInstall();
    }, WEBGL_RETRY_BASE_MS * 2 ** (losses - 1));
  }

  return {
    setVisible(next: boolean) {
      if (disposed) return;
      visible = next;
      if (!next) {
        cancelInstallFrame();
        return;
      }
      lastShown = ++showClock;
      // 换了窗口(拖进 / 拖出 popout 子窗):canvas 的上下文属于原窗口,重建(VSCode updateGpuRendererWindow)
      if (addon && addonWindow !== termWindow()) release();
      scheduleInstall();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      cancelInstallFrame();
      clearTimeout(retryTimer);
      retryTimer = undefined;
      // 终端关闭:摘名额 / 守卫并立即释放上下文(同 release),不触发 onRendererChange
      installed.delete(slot);
      lossListener?.dispose();
      guards?.dispose();
      if (addon) disposeAddon(term, addon);
      addon = lossListener = guards = null;
    },
    get active() {
      return addon !== null;
    },
  };
}
