# design Switch(开关)

行为契约:**`<Switch checked onCheckedChange aria-label>` 渲染原生 `<button type="button" role="switch">`,
`aria-checked` / `data-checked` 反映 `checked`;点击(及原生按钮的 Space / Enter 键盘激活)调
`onCheckedChange(!checked)`;`disabled` 时不可聚焦点击、不回调。**

视觉对齐 MD3 Switch(VSCode 无原生开关,其设置页用 checkbox;选 MD3 规范以与设计层一致):

| 状态 | 轨道 | 滑块 | 对比(暗 / 亮) |
|---|---|---|---|
| 打开 | `--md-primary` | `--md-on-primary` | 轨道对 panel 9.68 / 5.55;滑块对轨道 7.72 / 6.44 |
| 关闭 | `--md-surface-container-highest` + 1px `--md-outline` 描边 | `--md-outline` | 描边对 panel 5.19 / 3.92;滑块对轨道 3.91 / 3.51 |

(打开态不用 `accent-fill`(primary-container):亮色 `#eaddff` 对 panel 仅 1.11:1,轨道看不出。)

## 模块

| 文件 | 职责 |
|---|---|
| `src/design/Switch.tsx` | UI(经 `@/design` 导出) |
| `src/design/Switch.css` | 轨道 / 滑块 / 焦点环样式(只用 `--md-*` / `--wm-*` token) |

## 关键行为

- 原生 `<button type="button" role="switch">`:浏览器自带 Space / Enter 激活与 Tab 聚焦,不另写键盘处理
- `aria-checked` 与 `data-checked` 同步 `checked`
- 点击 → `onCheckedChange(!checked)`(受控,组件不持有内部状态)
- `disabled` → 原生 disabled,点击不回调
- `className` 合并到 `wm-switch` 后;其余 button 属性(`aria-label` / `aria-labelledby` 等)透传
- 键盘焦点:`:focus-visible` 2px `--md-focus-ring` 轮廓(与其它 design 控件一致)
