import { readFile } from 'node:fs/promises';
import type { Plugin } from 'vite';
import { POPOUT_MOVE_HOOK_GLOBAL } from '../electron/shared/window-channels';

// dockview-core 6.0.0 的 onDidWindowMoveEnd(popout 子窗「移动结束」,用于触发 onDidLayoutChange → 布局持久化记下子窗位置)
// 每帧 requestAnimationFrame 轮询子窗 screenX / screenY,且子窗关闭前不停:开着 popout 时主 renderer 一直按刷新率(120Hz)
// 跑 rAF,窗口最小化也不停(backgroundThrottling 为防 issue #34 黑屏已关)。构建期把它换成事件驱动:订阅 renderer 装在
// globalThis[POPOUT_MOVE_HOOK_GLOBAL] 上的「该子窗被移动」(main 转发子窗 BrowserWindow 'move'),保留上游 100ms 防抖与
// 「子窗已关不再触发」语义;dispose 时退订。见 src/__tests__/popout-window-move/README.md。
// 升级 dockview 后锚点对不上直接报错:先看上游是否已改(改成事件 / 可关闭轮询就删本插件),没改再按新产物调整锚点。

const ANCHOR =
  /function onDidWindowMoveEnd\(window\) \{\s*const emitter = new Emitter\(\);[\s\S]*?requestAnimationFrame\(checkMovement\);\s*\};\s*checkMovement\(\);\s*return emitter;\s*\}/;

const REPLACEMENT = `function onDidWindowMoveEnd(window) {
    const emitter = new Emitter();
    let timeout;
    const subscribe = globalThis.${POPOUT_MOVE_HOOK_GLOBAL};
    const unsubscribe = typeof subscribe === 'function'
        ? subscribe(window, () => {
            if (window.closed) {
                return;
            }
            clearTimeout(timeout);
            timeout = setTimeout(() => {
                emitter.fire();
            }, DEBOUCE_DELAY);
        })
        : undefined;
    const disposeEmitter = emitter.dispose.bind(emitter);
    emitter.dispose = () => {
        clearTimeout(timeout);
        if (typeof unsubscribe === 'function') {
            unsubscribe();
        }
        disposeEmitter();
    };
    return emitter;
}`;

export function patchDockviewWindowMoveEnd(code: string): string {
  const hits = code.match(new RegExp(ANCHOR.source, 'g'))?.length ?? 0;
  if (hits !== 1) {
    throw new Error(`[dockview-popout-move] dockview-core 产物里 onDidWindowMoveEnd 锚点命中 ${hits} 次(应为 1),补丁需重新评估`);
  }
  return code.replace(ANCHOR, REPLACEMENT);
}

// renderer 解析 `dockview-core` 走 package.json 的 module 入口(dist/package/main.esm.mjs,单文件打包产物)。
const DOCKVIEW_CORE_BUNDLE = /[\\/]dockview-core[\\/]dist[\\/]package[\\/]main\.esm\.mjs$/;

/** renderer 构建(rollup)用。 */
export function dockviewPopoutMovePlugin(): Plugin {
  return {
    name: 'continuo:dockview-popout-move',
    enforce: 'pre',
    transform(code, id) {
      if (!DOCKVIEW_CORE_BUNDLE.test(id.split('?')[0]!)) return null;
      return { code: patchDockviewWindowMoveEnd(code), map: null };
    },
  };
}

/** dev 预打包(optimizeDeps 走 esbuild,绕过 vite transform)用。 */
export function dockviewPopoutMoveEsbuildPlugin() {
  return {
    name: 'continuo:dockview-popout-move',
    setup(build: { onLoad: (o: { filter: RegExp }, cb: (a: { path: string }) => Promise<{ contents: string; loader: 'js' }>) => void }) {
      build.onLoad({ filter: DOCKVIEW_CORE_BUNDLE }, async ({ path }) => ({
        contents: patchDockviewWindowMoveEnd(await readFile(path, 'utf-8')),
        loader: 'js',
      }));
    },
  };
}
