# SharedTab(Dockview tab header,带 motion shared layout)

行为契约:**渲染 Dockview panel 的 tab title + close 按钮。
active 时 title 与底部下划线指示条都挂 motion layoutId(panelTitleLayoutId/tabIndicatorLayoutId)
让跨 group 拖动有飞行动画;inactive 不挂 layoutId 减噪。
关闭按钮 → api.close()。中键(button=1)按下后抬起 → api.close()。**

## 模块

| 文件 | 职责 |
|---|---|
| `src/shell/motion/SharedTab.tsx` | UI |
| `src/shell/motion/tokens.ts` | layoutId / spring(已知常量) |

## 关键行为

### title / active 同步

- 订阅 api.onDidTitleChange → 更新 title
- 订阅 api.onDidActiveChange → 更新 active

### close 按钮

- 点击 → preventDefault + stopPropagation + api.close()

### 中键

- pointerdown button=1 → 标记
- 同 element pointerup button=1 → api.close() + 重置标记
- pointerleave → 重置标记(滑出 tab 不触发)

### 键盘关闭

- tab 聚焦时 Delete → api.close()(关闭按钮已移出 Tab 顺序,这是键盘等价入口)
- Backspace **不**关闭:焦点停在 tab 上时用户常以为还在终端 / 编辑器里打字,退格即关 tab(终端 = 杀 PTY)。
  VSCode 的 tab 上同样没有退格关闭

### 鼠标点击后焦点回到面板内容(VSCode:点编辑器 tab 即聚焦该编辑器)

- 鼠标 click(detail≥1,左键)→ 终端面板调注册的 focus 句柄(xterm);其它面板聚焦内容里第一个可编辑元素
  (contenteditable / textarea / input),没有则第一个可 Tab 控件
- 键盘合成的 click(detail=0)不移走焦点(保持 tablist 键盘模型)
- 关闭 / 退出缩放按钮的 click 不触发(已 stopPropagation)
- 两个图标按钮有与 aria-label 相同的 title 悬停提示
- tab(role=tab)名称只是标题:`aria-labelledby` 指向标题 span(active 的 motion span / inactive span 同一 id),
  不按内容把关闭 / 退出最大化按钮的名称拼进来(修复前读屏念「编辑器 关闭 编辑器」;对齐 VSCode tab)

### 动画 layoutId

- active=true → m.span title 挂 layoutId、底部指示条挂 layoutId
- active=false → 普通 span,不挂指示条
