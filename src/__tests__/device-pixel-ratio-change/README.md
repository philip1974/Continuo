# 窗口缩放比例(devicePixelRatio)变化后重算像素相关布局

行为契约:**窗口换到缩放比例不同的显示器(或页面缩放)后,终端按新的设备像素重算行列,不残留旧屏算出的列数(文字溢出 /
右侧留白)。** 对齐 VSCode `src/vs/base/browser/pixelRatio.ts`(`PixelRatio.getInstance(window).onDidChange`,
`matchMedia('(resolution: Ndppx)')` 每次变化换新 query)与 `xtermTerminal.ts` `getXtermScaledDimensions`(行列按
`devicePixelRatio` 缩放后的 cell 尺寸算)。

## 行为

- **通用监听 `watchDevicePixelRatio(getWindow, onChange)`**(`src/lib/device-pixel-ratio.ts`):
  - 监听 `getWindow()` 的 `(resolution: ${devicePixelRatio}dppx)`;离开该值触发一次 `onChange`,随即按新值换一条 query
    (之后再变仍能听到 —— 每次只听当前值)。
  - `sync()`:元素所在窗口变了(拖进 / 拖出 popout 子窗)→ 改听新窗口、摘掉旧窗口的监听;窗口没变不动;都不触发 `onChange`。
  - `dispose()` 后不再触发;没有窗口 / 没有 `matchMedia`(jsdom)→ 不监听、不抛。
- **终端**(`useTerminal`):DPR 变化时容器 CSS 尺寸不变、ResizeObserver 不触发,而 xterm 的 cell 尺寸按设备像素取整
  (DPR 1→1.5 时 cell 宽 7→7.33 CSS px)→ 下一帧(等 xterm 自己的 DPR 监听先更新 cell 尺寸)请求重算行列
  (`resizeDebouncer.request()`,与容器尺寸变化同一防抖)。监听终端**所在窗口**(主窗 / popout):容器 ResizeObserver 每次回调先
  `sync()`(拖进 / 拖出 popout 时容器重新布局必触发)。终端卸载时摘监听并取消待执行的帧。
- **不需要额外处理的**:
  - xterm 自身(`CoreBrowserService` 的 `ScreenDprMonitor`,随 `ownerDocument.defaultView` 换窗口)在 DPR 变化时更新 cell
    尺寸、重建 WebGL 纹理图集与 canvas 尺寸;Continuo 只缺「按新 cell 尺寸重算行列」这一步。
  - CodeMirror 6:正文、光标层、选区层、缩进参考线都是 DOM / CSS(CSS 像素定位,浏览器按新 DPR 重新栅格化),
    `@codemirror/view` 不监听 DPR(核实 6.41.1 源码:只有 window `resize` 与 scrollDOM 的 ResizeObserver),
    其 CSS 像素测量值不随 DPR 变化(CDP 模拟 DPR 2 / 1 / 1.25 / 1.5 / 3 实测:`defaultCharacterWidth` 7.828、
    `defaultLineHeight` 18.195 不变,与当场量的字符宽一致),不接入。VSCode 编辑器在 DPR 变化时重算字体信息
    (`editorConfiguration.ts` 订阅 `PixelRatio.onDidChange`)是因为 Monaco 的测量 / 渲染按设备像素对齐,CodeMirror 没有这一层。

## 规范

- `device-pixel-ratio.spec.ts`:`watchDevicePixelRatio` 的监听 / 换 query / 换窗口 / 释放;终端接线。
