# terminal-resize-debounce

行为契约:**拖拽改尺寸时,长 buffer 终端的列变化合并成一次 reflow**。

列数变化要对整个 scrollback(最多 20000 行)做 reflow,且每次都给 PTY 发 SIGWINCH 让 TUI 全屏重绘;
侧栏 / 窗口 / 分栏拖拽每帧都会触发。参考 VSCode `TerminalResizeDebouncer`:

- buffer < 200 行 → 立即按容器尺寸 fit(便宜,不防抖)
- buffer ≥ 200 行:
  - 行数变化立即生效(不 reflow,便宜)
  - 列数变化防抖 100ms(拖拽期间连续变化只在停下后 reflow 一次,用最新尺寸)
- 每次实际改变 xterm 网格后,PTY 尺寸随之同步(沿用 perf-audit P9 的去重)
- 面板切回可见 / 激活(`flush`)→ 立即按最新尺寸 fit,撤销未触发的防抖(VSCode 可见时 flush;
  隐藏期间改过的宽度不应在切回后再晚 100ms 才 reflow 闪一下)
- 面板卸载 → 撤销未触发的防抖
