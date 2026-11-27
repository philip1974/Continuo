# 终端 WebGL 渲染器:名额、显隐与上下文丢失(对齐 VSCode xtermTerminal)

行为契约:**正在显示的终端保持 WebGL 渲染(CJK 不被 DOM 渲染裁尾)。终端很多时(超过 Chromium 每进程 16 个 WebGL 上下文),
让出上下文的是最久没显示的隐藏终端,而不是浏览器随手丢掉的最早那个(往往正可见:白底哭脸约 3 秒后永久降为 DOM)。**

## 行为

- **延后安装**:终端创建后下一帧才装 WebGL(同步 GPU 初始化不压在首屏接线里);创建时隐藏的终端不装,首次显示时下一帧装。
  切到别的 tab 前未装上的帧取消。
- **名额**:所有终端(主窗与 popout 子窗同一渲染进程)同时持有 WebGL 的上限 `MAX_TERMINAL_WEBGL` = 12(低于 Chromium 的 16,
  留余量)。名额满、又有终端需要装时,卸掉**最久没显示的隐藏终端**(它回退 DOM,无可见代价;重新显示时再装,必要时再让出别的
  隐藏终端)。拆分并排 / popout 里同时可见的终端都算可见,不被让出;全是可见终端时照装。
- **让出过名额的终端重新可见不空白**:隐藏时被让出、换成的 DOM 渲染器在隐藏期间没画过(xterm RenderService 在
  IntersectionObserver 回报可见前暂停渲染);重新可见时**当场**装上 WebGL(不等下一帧),告诉 RenderService 已可见并 refresh 全部
  行,canvas 先按设备像素(`devicePixelContentBox` 同值)设好宽高 —— 渲染落在本帧,addon 的 ResizeObserver 不再改尺寸清空画面。
  CDP screencast 逐帧:修前切回空白 2~3 帧,修后 0 帧。没被让出过的终端(首次显示)照旧下一帧装。
- **切 tab 不重建**:名额未满时,隐藏 / 重新显示不卸不装(不重复同步 GPU 初始化与纹理图集重建)。
- **上下文丢失**(`onContextLoss`):卸掉回退 DOM;可见时按退避重试(1s、2s、4s),累计丢失 3 次后不再重试(防抖动);
  丢失时隐藏则等重新显示再装。
- **WebGL 不可用**(创建 / 加载抛错):保持 DOM,不再重试,控制台告警。
- **换窗口**:拖进 / 拖出 popout 子窗后在新窗口可见时重建渲染器(canvas 上下文属于原窗口;VSCode `updateGpuRendererWindow`)。
- 渲染器换了(装上 / 卸下)请求重新 fit(两种渲染器 cell 尺寸可能不同)。
- 显隐来源:dockview `onDidVisibilityChange`(切 tab 不卸载 React 组件,见 topic-34);popout 移动经 `onDidLocationChange`。
- 纹理图集按配置在终端间共享,卸 / 装只增减引用;页版本碰撞由 `scripts/vite-xterm-webgl-atlas-version.ts` 修正,
  多终端同时显示不乱码(e2e 覆盖)。

## Modules

| File | Role |
|---|---|
| `src/panels/Terminal/terminal-webgl.ts` | `createTerminalWebgl`:每终端的装 / 卸、模块级名额(LRU 让出隐藏终端)、让出过的终端重新可见时当场装上并画出、上下文丢失退避重试、换窗口重建 |
| `src/panels/Terminal/useTerminal.ts` | 创建时 `setVisible(isVisible())`;返回 `setRendererVisible`;卸载时 dispose |
| `src/panels/Terminal/TerminalPanelView.tsx` | dockview 显隐 / location 变化 → `setRendererVisible` |

## Specs

- `terminal-webgl.spec.ts`
- `panel-visibility-wiring.spec.tsx`
- e2e:`tests/e2e/terminal-webgl-many.spec.ts`(20 个终端时可见终端保持 WebGL、切 tab 耗时)
- e2e:`tests/e2e/terminal-webgl-switch-frames.spec.ts`(22 个终端切回让出过的终端,screencast 逐帧无空白帧)
