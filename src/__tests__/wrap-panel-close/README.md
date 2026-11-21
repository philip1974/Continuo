# wrap-panel-close(dock 关闭动画拦截)

行为契约:**`wrapPanelClose(panel)` 把 dockview panel 的 `api.close()` 包成「先 mark
closing-store,EXIT_DURATION_MS 后真 close」。同 panel 多次包 / 多次 close 都幂等。**

## 模块

| 文件 | 职责 |
|---|---|
| `src/shell/dock/wrap-panel-close.ts` | api.close 包裹 |
| `src/stores/closing.store.ts` | 关闭中 panel id 集合,PanelMount 据此切 EXIT 动画 |

## 关键行为

### 第一次 close

1. closing-store.ids 加入 panel.api.id
2. setTimeout(EXIT_DURATION_MS) 后调真 close

### 同 panel 第二次 close(动画期内)

- 直接返回,不重复 setTimeout、不重复 mark

### 包裹幂等

- 同 panel 二次 wrap → 第二次直接返回,不再重新 defineProperty

### 真 close 抛错

- catch 静默(panel 可能已被其他路径移除)
