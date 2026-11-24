## 模块

| 文件 | 职责 |
|---|---|
| `src/theme/ThemeProvider.tsx` | 主题模式 / 系统跟随 / `.dark` class 切换;mode 唯一存储为设置值 `general.theme` |
| `src/styles/design-tokens.css` | 唯一 MD3 色板(亮+暗双套,暗色即 Continuo IDE 色板;源自已废弃的 Nous shell-ui,现由本仓库维护) |
| `src/styles/theme.css` | Continuo 自有槽位(`--md-debug-*` / `--md-fg-dim` / `--wm-radius-*` 等)+ `@theme inline` 把 `--color-*` 私有 token 映射到 `--md-*` |
| `src/design/*` | design 基础组件(本仓库维护) |

## 关键行为

### ThemeProvider

- 默认 mode = `'dark'`(Continuo 暗色优先,无存储值时);设置值非法也兜底 `'dark'`
- mode 的唯一存储是设置值 `general.theme`(values-store):设置页切换 / 别窗同步即时生效;`setMode` 写同一设置值
- 旧版独立键 `layoutmotion.theme.mode`:启动时一次性迁移(设置值尚无且旧值合法才写入),之后删除
- localStorage 受限(getItem / setItem 抛)不崩:读兜底 dark,写失败仍更新内存态与 class
- `mode === 'system'` 时跟随 `prefers-color-scheme` 媒体查询
- mount 后 `<html>` 加 `dark` class(若 resolved=dark)/移除(若 resolved=light)
- `useTheme()` 暴露 `{ mode, resolved, setMode }`

### Token 完整性

- `design-tokens.css` 在 `:root`(light)与 `.dark` 下的 `--md-*` 变量数量必须**严格相等**(亮/暗对称)
- `theme.css` 必须导入 `design-tokens.css`;色板单层:`theme.css` 不覆盖 `design-tokens.css` 已定义的任何 `--md-*`,Continuo IDE 暗色值直接写在 `design-tokens.css` 的 `.dark`
- Continuo 自有 `--md-*` 槽位(`--md-debug-*` / `--md-fg-dim`)在 `theme.css` 的 `:root` 与 `.dark` 都给值
- Continuo 的 `--color-*` 私有 token 必须全部通过 `var(--md-*)` 解析(不许字面 hex)

### Design 组件契约

- 全部位于 `src/design/`,导出从 `src/design/index.ts` 集中
- 渲染时附带 `data-variant` / `data-size` / `data-active` 等 data-attribute 用于 CSS 选择
- 接受 `className` prop,合并到 `wm-*` 基类后(不覆盖)
- 完全用 `--md-*` / `--wm-*` token,组件 CSS 不出现字面 hex
