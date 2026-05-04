# column-resize (Sidebar 拖拽改宽)

行为契约:**侧栏拖拽改宽的纯函数层**。React hook(useColumnResize)是薄壳,
绑 mousedown / mousemove / mouseup,业务逻辑都在 `computeNewWidth` / `clampWidth`。

## 模块

| 文件 | 职责 |
|---|---|
| `src/lib/use-column-resize.ts` | `clampWidth` / `computeNewWidth` 纯函数 + `useColumnResize` hook |

## 关键行为

### `clampWidth(value, min, max)`
- value 在 [min, max] 内 → 原值
- 超 max → max
- 低于 min → min
- NaN → min(防御性)

### `computeNewWidth(startX, startW, currentX, min, max, direction?)`
- direction='left-to-right'(默认):向右拖增宽(width = startW + delta)
- direction='right-to-left':向右拖减宽(width = startW - delta)— 用于右侧栏的左边拖拽条
- 结果经 clampWidth 截断

## 不在本主题验证

- React hook 的 mousedown / mousemove / mouseup 事件绑定(留 E2E)
- document.body.style 副作用(同上)
