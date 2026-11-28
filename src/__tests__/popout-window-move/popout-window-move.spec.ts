// BDD:popout 子窗移动改为事件驱动(不再每帧 rAF 轮询 screenX / screenY)。见同目录 README.md。
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { patchDockviewWindowMoveEnd } from '../../../scripts/vite-dockview-popout-move';
import { forwardPopoutMoves } from '../../../electron/main/popout-move-forward';
import { POPOUT_MOVE_HOOK_GLOBAL, WINDOW_CHANNELS } from '../../../electron/shared/window-channels';

const onPopoutMoved = vi.fn<(cb: (name: string) => void) => () => void>();
vi.mock('@/lib/co-api', () => ({ coApi: { window: { onPopoutMoved: (cb: (name: string) => void) => onPopoutMoved(cb) } } }));

const ROOT = path.resolve(__dirname, '../../..');

/** renderer 实际解析到的 dockview-core 产物(dockview-react → dockview → dockview-core 的 module 入口)。 */
function dockviewCoreBundlePath(): string {
  const fromReact = createRequire(createRequire(path.join(ROOT, 'package.json')).resolve('dockview-react'));
  const fromDockview = createRequire(fromReact.resolve('dockview'));
  const pkgJson = fromDockview.resolve('dockview-core/package.json');
  const pkg = JSON.parse(readFileSync(pkgJson, 'utf-8')) as { module: string };
  return path.join(path.dirname(pkgJson), pkg.module);
}

type Hook = (popout: unknown, onMove: () => void) => () => void;
interface MoveEmitter {
  event: (cb: () => void) => { dispose(): void };
  dispose(): void;
}

const BUNDLE = dockviewCoreBundlePath();
const ORIGINAL = readFileSync(BUNDLE, 'utf-8');
let tmp = '';
let onDidWindowMoveEnd: (win: unknown) => MoveEmitter;

describe('popout-window-move', () => {
  beforeEach(async () => {
    if (!tmp) {
      // 真实产物改写后加一个测试用导出,按 ESM 加载(产物无外部 import)。
      tmp = mkdtempSync(path.join(tmpdir(), 'continuo-dockview-move-'));
      const file = path.join(tmp, 'dockview-core.mjs');
      writeFileSync(file, `${patchDockviewWindowMoveEnd(ORIGINAL)}\nexport { onDidWindowMoveEnd as __onDidWindowMoveEnd };\n`);
      const mod = (await import(/* @vite-ignore */ pathToFileURL(file).href)) as { __onDidWindowMoveEnd: typeof onDidWindowMoveEnd };
      onDidWindowMoveEnd = mod.__onDidWindowMoveEnd;
    }
    vi.useFakeTimers();
    vi.stubGlobal('requestAnimationFrame', vi.fn());
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    delete (globalThis as Record<string, unknown>)[POPOUT_MOVE_HOOK_GLOBAL];
    onPopoutMoved.mockReset();
  });

  afterAll(() => {
    if (tmp) rmSync(tmp, { recursive: true, force: true });
  });

  it('修复前:上游 onDidWindowMoveEnd 仍是每帧 rAF 轮询(补丁仍有必要;上游已改则删补丁)', () => {
    const fn = ORIGINAL.slice(ORIGINAL.indexOf('function onDidWindowMoveEnd('), ORIGINAL.indexOf('function onDidWindowResizeEnd('));
    expect(fn.includes('requestAnimationFrame(checkMovement)'), '上游已不再 rAF 轮询').toBe(true);
  });

  it('不动子窗时不调 requestAnimationFrame;推送一次移动 → 100ms 防抖后派发一次,连续移动合并', () => {
    let notify: () => void = () => {};
    const unsubscribe = vi.fn();
    const hook = vi.fn<Hook>((_w, cb) => {
      notify = cb;
      return unsubscribe;
    });
    (globalThis as Record<string, unknown>)[POPOUT_MOVE_HOOK_GLOBAL] = hook;
    const win = { closed: false, screenX: 10, screenY: 20 };
    const emitter = onDidWindowMoveEnd(win);
    const fired = vi.fn();
    emitter.event(fired);

    expect(hook).toHaveBeenCalledWith(win, expect.any(Function));
    vi.advanceTimersByTime(5_000);
    expect(globalThis.requestAnimationFrame).not.toHaveBeenCalled();
    expect(fired).not.toHaveBeenCalled();

    notify();
    vi.advanceTimersByTime(60);
    notify();
    vi.advanceTimersByTime(99);
    expect(fired).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(fired).toHaveBeenCalledTimes(1);
    expect(globalThis.requestAnimationFrame).not.toHaveBeenCalled();
  });

  it('子窗已关闭 → 推送不再派发;dispose → 退订并清掉在途防抖', () => {
    let notify: () => void = () => {};
    const unsubscribe = vi.fn();
    (globalThis as Record<string, unknown>)[POPOUT_MOVE_HOOK_GLOBAL] = ((_w, cb) => {
      notify = cb;
      return unsubscribe;
    }) satisfies Hook;
    const win = { closed: false, screenX: 0, screenY: 0 };
    const emitter = onDidWindowMoveEnd(win);
    const fired = vi.fn();
    emitter.event(fired);

    notify();
    emitter.dispose();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(500);
    expect(fired).not.toHaveBeenCalled();

    const emitter2 = onDidWindowMoveEnd(win);
    const fired2 = vi.fn();
    emitter2.event(fired2);
    win.closed = true;
    notify();
    vi.advanceTimersByTime(500);
    expect(fired2).not.toHaveBeenCalled();
  });

  it('锚点对不上(上游改了实现)时直接报错,不静默放过', () => {
    expect(() => patchDockviewWindowMoveEnd('function unrelated() {}')).toThrow(/dockview-popout-move/);
  });

  it('renderer 构建与 dev 预打包都经过改写;主窗 renderer 启动时装上订阅钩子', () => {
    const config = readFileSync(path.join(ROOT, 'electron.vite.config.ts'), 'utf-8');
    const renderer = config.slice(config.indexOf('renderer:'));
    expect(renderer).toMatch(/plugins:\s*\[[^\]]*dockviewPopoutMovePlugin\(\)/);
    expect(renderer).toMatch(/optimizeDeps:\s*\{[\s\S]*?esbuildOptions:\s*\{\s*plugins:\s*\[[^\]]*dockviewPopoutMoveEsbuildPlugin\(\)/);
    expect(BUNDLE).toMatch(/[\\/]dockview-core[\\/]dist[\\/]package[\\/]main\.esm\.mjs$/);
    const init = readFileSync(path.join(ROOT, 'src/main-app.ts'), 'utf-8');
    const body = init.slice(init.indexOf('export async function init'));
    expect(body.indexOf('installPopoutWindowMoveHook()')).toBeGreaterThan(-1);
    expect(body.indexOf('installPopoutWindowMoveHook()')).toBeLessThan(body.indexOf("document.getElementById('root')"));
  });

  it('renderer 钩子:只回调名字相同且未关闭的子窗,返回 coApi 的 unsubscribe', async () => {
    const { installPopoutWindowMoveHook } = await import('@/shell/dock/popout-window-move');
    let push: (name: string) => void = () => {};
    const off = vi.fn();
    onPopoutMoved.mockImplementation((cb) => {
      push = cb;
      return off;
    });
    installPopoutWindowMoveHook();
    const hook = (globalThis as Record<string, unknown>)[POPOUT_MOVE_HOOK_GLOBAL] as Hook;
    const popout = { name: 'dv-1-group-2', closed: false };
    const onMove = vi.fn();
    const unsubscribe = hook(popout, onMove);

    push('dv-1-group-3');
    expect(onMove).not.toHaveBeenCalled();
    push('dv-1-group-2');
    expect(onMove).toHaveBeenCalledTimes(1);
    popout.closed = true;
    push('dv-1-group-2');
    expect(onMove).toHaveBeenCalledTimes(1);
    unsubscribe();
    expect(off).toHaveBeenCalledTimes(1);
  });

  it('main:子窗 BrowserWindow move → 向打开它的 webContents 推 window:popout-moved(子窗名);任一方已销毁不推', () => {
    const listeners: Array<() => void> = [];
    const child = {
      destroyed: false,
      on: (_e: 'move', l: () => void) => listeners.push(l),
      isDestroyed: () => child.destroyed,
      webContents: { isDestroyed: () => false, mainFrame: { name: 'dv-1-group-2' } },
    };
    const opener = { destroyed: false, isDestroyed: () => opener.destroyed, send: vi.fn() };
    forwardPopoutMoves(child, opener);
    expect(listeners).toHaveLength(1);
    listeners[0]!();
    expect(opener.send).toHaveBeenCalledWith(WINDOW_CHANNELS.POPOUT_MOVED, 'dv-1-group-2');
    opener.destroyed = true;
    listeners[0]!();
    child.destroyed = true;
    opener.destroyed = false;
    listeners[0]!();
    expect(opener.send).toHaveBeenCalledTimes(1);

    const src = readFileSync(path.join(ROOT, 'electron/main/index.ts'), 'utf-8');
    const created = src.slice(src.indexOf("contents.on('did-create-window'"));
    expect(created.slice(0, created.indexOf('});'))).toMatch(/forwardPopoutMoves\(child, contents\)/);
  });
});
