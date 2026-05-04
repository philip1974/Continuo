## 模块

| 文件 | 职责 |
|---|---|
| `src/theme/ThemeProvider.tsx` | 主题模式 / 系统跟随 / `.dark` class 切换 / localStorage 持久化 |
| `src/styles/nous-tokens.css` | Nous shell-ui 共享 MD3 token(亮+暗双套,LM 不修改) |
| `src/styles/theme.css` | LM 暗色覆盖 + `@theme inline` 把 9 个 `--color-*` 私有 token 映射到 `--md-*` |
| `src/design/*` | LM 本地 design 组件副本(从 Nous shell-ui sync,部分 LM-local 微调) |

## 关键行为

### ThemeProvider

- 默认 mode = `'dark'`(LM 暗色优先,无 localStorage 时)
- `setMode('dark' | 'light' | 'system')` 把值写入 `localStorage` 键 `layoutmotion.theme.mode`
- `mode === 'system'` 时跟随 `prefers-color-scheme` 媒体查询
- mount 后 `<html>` 加 `dark` class(若 resolved=dark)/移除(若 resolved=light)
- `useTheme()` 暴露 `{ mode, resolved, setMode }`

### Token 完整性

- `nous-tokens.css` 在 `:root`(light)与 `.dark` 下的 `--md-*` 变量数量必须**严格相等**(亮/暗对称)
- `theme.css` 必须导入 `nous-tokens.css`;LM 覆盖只动 `.dark` 块的 surface / primary 等 IDE 关键值
- LM 9 个 `--color-*` 私有 token 必须全部通过 `var(--md-*)` 解析(不许字面 hex)

### Design 组件契约

- 全部位于 `src/design/`,导出从 `src/design/index.ts` 集中
- 渲染时附带 `data-variant` / `data-size` / `data-active` 等 data-attribute 用于 CSS 选择
- 接受 `className` prop,合并到 `wm-*` 基类后(不覆盖)
- 完全用 `--md-*` / `--wm-*` token,组件 CSS 不出现字面 hex
