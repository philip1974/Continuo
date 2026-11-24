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
- Continuo 自有 `--md-*` 槽位(`--md-debug-*` / `--md-fg-dim` / `--md-rating`)在 `theme.css` 的 `:root` 与 `.dark` 都给值
- Continuo 的 `--color-*` 私有 token 必须全部通过 `var(--md-*)` 解析(不许字面 hex)
- `--md-fg-dim`(次要弱化正文)两主题各自取值,对 `surface` / `surface-container` / `surface-container-high` 均 ≥ 4.5:1;
  `text-fg-dim` / `text-fg-muted` 不叠透明度修饰(`/60` 等会把正文压到 AA 以下)
- `--md-rating`(评分星,`text-rating`)两主题各自取值,对 `surface` / `surface-container-low` / `surface-container` ≥ 4.5:1
- 组件不用 Tailwind 默认色板(`text-amber-400` 等),统一走语义 token

### Design 组件契约

- 全部位于 `src/design/`,导出从 `src/design/index.ts` 集中
- 渲染时附带 `data-variant` / `data-size` / `data-active` 等 data-attribute 用于 CSS 选择
- 接受 `className` prop,合并到 `wm-*` 基类后(不覆盖)
- 完全用 `--md-*` / `--wm-*` token,组件 CSS 不出现字面 hex

### 样式契约(`style-contracts.spec.ts`,按 CSS 源码钉)

- **design CSS 在 Tailwind `components` 层**:`tailwind.css` 以 `@import "../design/index.css" layer(components)` 引入,
  `index.css` 汇总 `src/design/` 全部组件 CSS,组件 `.tsx` 不再各自 `import './X.css'`(否则会打出一份 unlayered 副本)。
  Tailwind v4 层顺序 theme < base < components < utilities,而 unlayered 样式压过任何 layer —— 不在层里时调用方传给
  design 组件的 className(`@max-md:hidden`、`w-24`、`overflow-x-auto` 等)会被组件基类静默覆盖
- 可聚焦控件键盘焦点一致:`Button` 与 IconButton / NavRailButton / SegmentedControl / TabNav 同为 `:focus-visible` 2px `--md-focus-ring` 轮廓
- 有不透明底色的控件 hover 用 MD3 state layer 叠加(`background-image` 叠 `--md-state-hover`),不把底色换成半透明
- `SegmentedControl`:轨道 1px `outline-variant` 描边;选中项 `secondary-container` 底 + `on-secondary-container` 字 +
  1px `primary` 描边(指示对轨道 ≥ 3:1);未选中项同宽透明描边,切换不抖动
- `MenuItem`:Radix 菜单原语注入的 `[data-highlighted]` 与 hover / focus-visible 同为 state-hover 底;`trailing`(快捷键 / 计数)靠右、`--md-fg-dim`
- 浮层阴影统一:Explorer 右键菜单 / DropdownMenu / 终端搜索条用 `shadow-popover`,Toast 用 `var(--wm-shadow-popover)`;
  Toast 关闭按钮 hover 为 state-hover 背景
- `Badge`:`size="xs"` 为 4px 圆角矩形小标签;`accent-soft` 与其它 `*-soft` 同构;设置 / 插件 / 快捷键 id 与单位、市场
  Verified / 维护者 / 新账号标签统一用 `Badge`,不手写;全应用无小于 10px 的任意字号

- `TruncateStart`(路径等尾部更重要的单行文本):外层 `direction: rtl` + `text-overflow: ellipsis` + `text-align: left`,
  溢出从行首截断、省略号在左;文本在 `dir="ltr"` 内层(`unicode-bidi: isolate`),开头的 `/` 等中性标点不被重排;
  完整文本默认进 `title`
- `EmptyState`(面板 / 区块空态):占满可用空间(`flex: 1 1 auto`)并居中,`on-surface-variant` 正文色,无边框
- `Tabs`(面板内竖向视图切换):选中项与设置页导航同一样式 —— 左侧 2px `primary` 竖条 + `surface-container-high` 底,
  不用填充描边药丸

### MenuItem / Badge 组件契约(`components.spec.tsx`)

- `MenuItem` 透传 `ref` 与其余 button 属性(可作 Radix `ContextMenu.Item asChild` 的子元素),`onClick` 可省略;
  `trailing` 渲染在截断 label 之外
- `Badge` 默认 `size="sm"`(胶囊),`data-size` / `data-variant` 写入 DOM

### TabNavItem 关闭与焦点(`components.spec.tsx`)

- 有 `onClose` 且未 `disabled` 的 tab:中键单击(`auxclick` button=1)调用 `onClose`(与点 × 同一路径,未保存 tab 的确认由
  调用方负责),不触发 `onSelect`;中键按下 `preventDefault`,不进入浏览器中键自动滚动 —— 与 dock tab(SharedTab)中键关闭一致
- 右键 auxclick、左键按下不关闭;无 `onClose` 或 `disabled` 的 tab 中键既不关闭也不拦默认行为
- 键盘关闭:聚焦 tab 时只认 `Delete`,**不认 Backspace**(焦点停在 tab 上时用户常以为还在编辑器里打字,退格即误关 tab;
  与 dock tab SharedTab 同规则,VSCode tab 上也无退格关闭)
- 鼠标点击选中 tab 时,在 `onSelect` 之后额外回调可选的 `onMouseSelect`(调用方据此把焦点交回内容);键盘 Enter / Space
  合成的 click(`detail === 0`)只 `onSelect`,焦点留在 tab
