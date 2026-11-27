# design ProgressBar(视图顶部的不确定进度细条)

行为契约:**`<ProgressBar active delayMs aria-label>` 在 `active` 持续为 true 满 `delayMs` 后才渲染一条
`role="progressbar"`(无 `aria-valuenow`,不确定进度)的 2px 细条;`active` 变 false 立即不渲染。**

对标 VSCode:视图 / 视图容器顶部的 `monaco-progress-container`(`.infinite`:2px 高、无轨道底色、一小段来回扫过),
`IProgressService.withProgress({ location, delay })` 的 `delay` 防止很快结束的操作闪出进度条
(搜索视图 300ms、资源管理器文件操作 500ms)。

## 模块

| 文件 | 职责 |
|---|---|
| `src/design/ProgressBar.tsx` | `ProgressBar` 组件与 `useDelayedActive(active, delayMs)` hook(经 `@/design` 导出) |
| `src/design/ProgressBar.css` | 细条与扫动动画(只用 `--md-primary` 与 `--wm-duration-progress` token) |

## 关键行为

- `delayMs` 缺省 0:`active` 为 true 即渲染
- `active` 在延迟内变回 false → 始终不渲染(快速操作不闪);再次变 true 重新计时
- `active` 变 false → 立即不渲染
- `className` 合并到 `wm-progress` 后,其余 div 属性(`aria-label` 等)透传;定位由调用方给(如 `absolute inset-x-0 top-0`)
- 颜色:细条 `--md-primary`(亮 / 暗两套 token 各自取值),无轨道底色;`prefers-reduced-motion: reduce` 时不扫动,整条静止显示
- `useDelayedActive` 供同一延迟的其它反馈复用(如搜索视图的「取消搜索」按钮与进度条同时出现)
