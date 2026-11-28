# popout 子窗移动:事件驱动,不再每帧轮询

## 背景

dockview-core 6.0.0 的 `onDidWindowMoveEnd(window)`(`dist/esm/dom.js`,打包进 `dist/package/main.esm.mjs`)为得知 popout
子窗「移动结束」,每帧 `requestAnimationFrame` 轮询子窗 `screenX / screenY`,子窗关闭前不停。它只用于在移动结束后派发
`onDidPopoutGroupPositionChange` → `onDidLayoutChange` → DockShell 防抖持久化布局(`toJSON` 读子窗当时的 `screenX / screenY`
存进 `popoutGroups[].position`)。开着 popout 时主 renderer 一直按刷新率(120Hz)跑 rAF,窗口最小化也不停
(`backgroundThrottling: false`,为防 issue #34 黑屏不能改):空闲 renderer ~4% / GPU ~1.6%,无 popout 时 0.15% / 0.39%。

VSCode 的辅助窗口不轮询位置:`auxiliaryWindowService.ts` 的 `createState()` 在保存工作区状态时才读子窗
`screenX / screenY`。这里保留「移动后即落盘」(崩溃 / 强退后也不丢位置,原有行为),只把「得知移动」从轮询换成 main 推送。

## 行为

1. **不轮询**:开着 popout、不动它时,dockview 不再调用 `requestAnimationFrame`(主 renderer 空闲时 CPU / GPU 回到接近无
   popout 的水平)。
2. **移动后照常持久化**:main 在 popout 子窗 `BrowserWindow` 发 `move`(拖动 / 程序化 setBounds / 换显示器)时,向打开它的
   主窗 renderer 推 `window:popout-moved`(payload = 子窗 `window.open` 名)。renderer 只回调**被移动的那个**子窗(名字相同且
   未关闭),沿用上游 100ms 防抖后派发 `onDidWindowMoveEnd` → 布局持久化;重启后子窗回到移动后的位置。
3. **子窗已关闭 / 已销毁**:不再派发;dockview 回收该 popout(dispose)时退订推送、清掉在途防抖。
4. **构建期改写有守护**:改写在 `electron.vite.config.ts` 的 renderer 插件(构建)与 `optimizeDeps` 的 esbuild 插件(dev
   预打包)里做(同 xterm atlas / Milkdown 补丁,不用 pnpm patch);上游产物对不上锚点时构建直接报错,不静默失效。升级
   dockview 后先看上游是否已改(已改则删补丁)。

## 模块

| 文件 | 职责 |
|---|---|
| `scripts/vite-dockview-popout-move.ts` | 改写 dockview-core 产物里的 `onDidWindowMoveEnd` |
| `electron/main/popout-move-forward.ts` | 子窗 `move` → 推给打开它的 webContents |
| `electron/preload/index.ts` | `coApi.window.onPopoutMoved` |
| `src/shell/dock/popout-window-move.ts` | 装 `globalThis.__continuoOnPopoutWindowMove`(按子窗名过滤) |

## 规范

- `popout-window-move.spec.ts`:改写后的真实产物不调 rAF、按推送防抖派发、关窗 / dispose 后不再派发;锚点不符报错;构建 / dev
  都注册了改写;main 转发与 renderer 过滤。
- e2e `tests/e2e/window-state-restart.spec.ts`「popout 子窗只移动不改尺寸」:移动后位置落盘。
