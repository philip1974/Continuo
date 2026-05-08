# useColumnResize(侧栏拖拽 hook)

行为契约:**`useColumnResize` 返回 mousedown handler。按下后注册 document 上 mousemove
/ mouseup,移动时根据 direction 与 startX/startW 算新宽度调 setCurrent;
松开移除监听,恢复 body cursor 与 userSelect。**

## 模块

| 文件 | 职责 |
|---|---|
| `src/lib/use-column-resize.ts` | hook + clampWidth/computeNewWidth(纯函数已有 spec) |

## 关键行为

### onMouseDown 回调

- preventDefault()
- 记 startX / startW
- 注册 document mousemove + mouseup
- body.style.cursor = 'col-resize',userSelect = 'none'

### mousemove

- 计算新宽度 → setCurrent(可被 clamp 到 [min, max])

### mouseup

- 移除两个监听
- 还原 body cursor / userSelect

### 多次拖拽

- 每次 mousedown 重新读 getCurrent → 互不影响
