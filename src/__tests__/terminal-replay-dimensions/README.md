# terminal-replay-dimensions(历史回放按录制时的终端尺寸)

行为契约:**终端面板重新挂载(崩溃恢复后 reload、popout 回到主窗、lazy-mount)回放历史时,每段输出按它产生时的 PTY 尺寸写入,
写完再恢复当前尺寸,由 xterm 重排**。否则按当前宽度回放原始输出(自动换行 / 光标定位按产生时的宽度编码),popout 宽度与主窗不同的
终端在崩溃恢复后整屏错位。

参考 VSCode:pty host 的 `TerminalRecorder`(`src/vs/platform/terminal/common/terminalRecorder.ts`)按 resize 分段记录 `{cols, rows, data}`;
重连回放 `BasePty.handleReplay`(`src/vs/workbench/contrib/terminal/common/basePty.ts`)每段先 `OverrideDimensions` 到录制尺寸、等写入提交,
全部回放完撤掉覆盖。

## 主进程(`main-dimensions.spec.ts`)

- 会话以 120×40 建出,快照的 `dimensions` 首项 = `{ offset: 0, cols: 120, rows: 40 }`
- PTY resize 成功 → 在当时的累计偏移处记一条新尺寸;尺寸没变不记;同一偏移(其间无输出)上的连续 resize 只留最后一次
- resize 失败不记
- 快照只带落在 `[startOffset, endOffset)` 里的尺寸:起点之前的最后一条作为开头那段(偏移夹到 startOffset)
- 记录条数有上限(`TERMINAL_DIMENSIONS_MAX`),超出丢最旧的

## 渲染端(`renderer-replay.spec.ts`)

- 只有一段且与当前尺寸相同 / 没有尺寸记录(旧主进程)→ 照旧整段写入
- 尺寸不同 → 每段先 `resize` 到录制尺寸、写入并等解析完,再写下一段;最后恢复回放前的尺寸并按容器重新 fit
- 截断快照开头的 reset 前缀归入第一段
- 回放期间不 fit(容器尺寸变化事件推迟到回放结束);回放期间到达的实时输出等回放完再接上,仍按偏移去重(不回归
  `terminal-history-replay-dedup`)
