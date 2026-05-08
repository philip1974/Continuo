# SharedTab(Dockview tab header,带 motion shared layout)

行为契约:**渲染 Dockview panel 的 tab title + close 按钮。
active 时 title 与底部下划线指示条都挂 motion layoutId(panelTitleLayoutId/tabIndicatorLayoutId)
让跨 group 拖动有飞行动画;inactive 不挂 layoutId 减噪。
关闭按钮 → api.close()。中键(button=1)按下后抬起 → api.close()。
其它 PointerEvent 透传给 dockview 自身 handler 维持拖拽。**

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

### 其它 pointer 事件

- 同时调 props 传入的 onPointerDown/Up/Leave 透传给 dockview

### 动画 layoutId

- active=true → motion.span title 挂 layoutId、底部指示条挂 layoutId
- active=false → 普通 span,不挂指示条
