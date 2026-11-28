# high-contrast-theme(高对比度深色 / 高对比度浅色主题 + 系统高对比度自动切换)

背景:此前只有 亮色 / 暗色 / 跟随系统 三项,默认暗色的控件边界(输入框 / 分段控件外框 `--md-outline-variant`)只有
1.98:1(亮色 1.66:1),系统开了高对比度(Windows 高对比度 / macOS「增强对比度」「反转颜色」)也不跟随。

## 对照 VSCode

| VSCode | 位置 | Continuo |
|---|---|---|
| 内置主题「Dark High Contrast」(`hc-black`)/「Light High Contrast」(`hc-light`) | `extensions/theme-defaults/package.json`、`themes/hc_black.json` / `hc_light.json` | `general.theme` 新增 `hcDark` / `hcLight`(值取 `ColorScheme.HIGH_CONTRAST_DARK / LIGHT` 的 id);`<html>` 加 `hc-black` / `hc-light` 类(VSCode workbench 同名类) |
| 各颜色的 `hcDark` / `hcLight` 默认值 | `src/vs/platform/theme/common/colors/*.ts`、`src/vs/editor/common/core/editorColorRegistry.ts`、`src/vs/workbench/common/theme.ts`、`terminalColorRegistry.ts` | `design-tokens.css` / `theme.css` 的 `.hc-black` / `.hc-light` 两套 `--md-*` |
| `contrastBorder`(hcDark `#6FC3DF` / hcLight `#0F4A85`):输入框、下拉、按钮、菜单、面板 / 编辑器组 / tab 分隔、widget 边框 | `baseColors.ts`,`input.border` / `menu.border` / `panel.border` / `tab.border` … 默认都取它 | `--md-contrast-border`;HC 下 `--md-outline-variant`(全部 `border-line` 分隔线)= 同值 |
| `contrastActiveBorder` = `focusBorder`(hcDark `#F38518` / hcLight `#006BBD`):活动 / 选中 / 悬停项轮廓、当前行边框、查找匹配边框 | `listWidget.ts`(选中 1px、悬停 1px dashed)、`multiEditorTabsControl.ts`(活动组的活动 tab 1px solid、非活动组 dotted)、`editorColorRegistry.ts`(`editor.lineHighlightBorder`)、`editorColors.ts`(`editor.findMatchBorder` 等) | `--md-contrast-active-border`、`--md-focus-ring`;规则集中在 `src/styles/high-contrast.css` |
| `window.autoDetectHighContrast`(默认 true):OS 高对比度时自动切到 `preferred*HighContrast*ColorTheme`;明暗按 OS | `workbenchThemeService.ts` / `themeConfiguration.ts`(`getPreferredColorScheme`) | 「跟随系统」时生效(见下「刻意差异」) |
| main 侧 OS 高对比度判定 | `src/vs/platform/theme/electron-main/themeMainServiceImpl.ts` `getColorScheme()`:Windows `shouldUseHighContrastColors`(明暗 = `shouldUseInvertedColorScheme`);macOS `shouldUseInvertedColorScheme \|\| shouldUseHighContrastColors`(明暗 = `shouldUseDarkColors`);Linux `shouldUseHighContrastColors`(按暗色) | `electron/shared/host-color-scheme.ts` `hostColorSchemeFromNativeTheme`(逐条照抄),`nativeTheme` 'updated' 广播 |
| 「在浅色和深色主题之间切换」:HC 深 ↔ HC 浅 | `themes.contribution.ts` `toggleLightDarkThemes` | 同 |
| `terminal.integrated.minimumContrastRatio` | 默认 4.5,不随主题变 | HC 两套取 7(见「刻意差异」) |
| 终端 16 色 `terminal.ansi*` hcDark / hcLight、选区 `terminal.selectionBackground/Foreground` | `terminalColorRegistry.ts` | `HC_DARK_THEME` / `HC_LIGHT_THEME`(16 色逐项照抄) |

## 行为

### 1. 主题项与切换(`hc-theme-switch.spec.tsx`)

- `general.theme` 枚举 = 亮色 / 暗色 / 高对比度深色 / 高对比度浅色 / 跟随系统;新两项三语文案(en「Dark High Contrast /
  Light High Contrast」照 VSCode 内置主题名,zh「高对比度深色 / 高对比度浅色」,ko「고대비 다크 / 고대비 라이트」(沿用既有「暗色 / 다크」等的用词);
  设置说明补一句「跟随系统」含系统高对比度);
  设置页、颜色主题选择器同序同名
- `<html>` 类:亮色 无;暗色 `dark`;HC 深 `dark hc-black`(保留 `dark`:明暗判定只看它,同 VSCode `isDark(HIGH_CONTRAST_DARK)`);
  HC 浅 `hc-light`。popout 子窗同步(同既有机制)
- ThemeProvider `resolved` = 四值(`light | dark | hcDark | hcLight`,同 VSCode `ColorScheme`),上报 main 的窗口底色
  与持久化同用此值;HC 深 / 浅底色 `#000000` / `#ffffff`
- 首帧(`initial-theme.ts`)按同一规则同步定 class(含 system + 系统高对比度的媒体查询)
- 「在浅色和深色主题之间切换」:亮 ↔ 暗,HC 深 ↔ HC 浅
- 编辑器 / 终端随之切换:`codeEditorTheme(hcDark)` 按暗色变体;终端换 `HC_DARK_THEME` / `HC_LIGHT_THEME`(底色 = 画布色)与
  `minimumContrastRatio 7`;新终端 COLORFGBG 按明暗;终端搜索装饰色缓存按四值主题作键

### 2. 跟随系统 + 系统高对比度(`hc-theme-switch.spec.tsx` / `hc-host-color-scheme.spec.ts`)

- 系统高对比度 = main 推送的 `nativeTheme` 判定(VSCode `getColorScheme`)**或** 渲染侧 `(forced-colors: active)` /
  `(prefers-contrast: more)`;此时「跟随系统」解析为 HC,明暗:main 判定为高对比度时用 main 的明暗,否则用
  `prefers-color-scheme`。系统高对比度关掉 → 回到普通 亮 / 暗
- main:`window:get-host-color-scheme` 返回当前判定;`nativeTheme` 'updated' 时广播 `window:host-color-scheme-changed`
  到全部窗口(畸形 payload 由 preload 丢弃);system 模式冷启动底色也按它(HC → `#000000` / `#ffffff`)
- 固定选了某主题时不自动切(见「刻意差异」)

### 3. 色板(`hc-tokens.spec.ts`;`design-system/tokens.spec.ts` 的一一对应守护扩展到四套)

- `design-tokens.css` 的 `.hc-black` / `.hc-light` 与 `:root` 的 `--md-*` 名称集合完全一致;`theme.css` 的自有槽位四套一致
- 文字 token(on-surface / on-surface-variant / fg-dim / outline(占位符)/ primary / list-highlight / error / warning /
  success / info / git-* / syntax-* / rating)对 HC 文字承载面(surface、container-low、container、container-high、
  container-highest、调试执行行底、编辑器选区底)≥ 7:1
- UI 边界(contrast-border、contrast-active-border、focus-ring、outline-variant、debug-breakpoint、debug-exec-marker、
  indent-guide(-active))对 surface 阶梯 ≥ 3:1
- 默认两主题的输入框 / 分段控件外框改用 `--md-outline`(MD3 outlined text field 的容器描边即 outline):暗色 ≥ 3:1;亮色
  `--md-outline` 对 container-low ≥ 3:1
- 终端 `HC_DARK_THEME` / `HC_LIGHT_THEME` 背景 = 对应 `--md-surface`;窗口底色常量同

### 4. HC 专有边框(`hc-tokens.spec.ts` 静态守护 `src/styles/high-contrast.css`)

全部规则限定 `:root:is(.hc-black, .hc-light)`,未分层(压过 design 的 components 层 / utilities):

- 选中 / 当前 / 按下 / 菜单高亮 / design `data-active`:1px solid `--md-contrast-active-border`(内嵌);悬停 1px dashed;
  键盘焦点 2px solid `--md-focus-ring`
- dock:tab 间 `--md-contrast-border` 分隔;活动组的活动 tab 1px solid、非活动组的活动 tab 1px dotted(VSCode 同)
- 输入框 / 分段控件 / 按钮(ghost 除外)/ 对话框 / 通知:`--md-contrast-border` 边框
- 链接下划线(`a[href]`、Milkdown 正文链接)
- CodeMirror:当前行无底色、`--md-contrast-active-border` 边框;行号 = 前景,当前行号 = contrast-active;选区淡底 + 边框;
  查找匹配 dashed / 当前匹配 2px solid;出现处高亮 dotted;括号匹配 contrast-border 边框;调试执行行边框;冲突比较
  diff 用边框代替色块(VSCode `diffEditor.inserted/removedTextBorder`)
- Milkdown:代码块 / 引用 / 表格边框、查找匹配同编辑器

## 刻意差异

- **只在「跟随系统」时自动切 HC**:VSCode 的 `window.autoDetectHighContrast` 在用户固定选了主题时也生效,并另设
  `preferred*ColorTheme` 记住各配色下的主题。Continuo 的主题只有一个设置值,「跟随系统」本身就是「检测系统」的开关:选了
  固定主题 = 不自动切。故不加 `window.autoDetectHighContrast`(极简)
- **终端 `minimumContrastRatio`**:VSCode 是单独设置(默认 4.5,与主题无关);Continuo 无此设置,按主题给值,HC 两套取 7
  (WCAG AAA,与 HC 文字 ≥ 7 的目标一致)
- **HC 语法色**:取 `hc_black.json` / `hc_light.json` 同色相,对选区 / 调试执行行底仍 ≥ 7 而提亮 / 加深;执行行底色比
  VSCode(`#ffff0033`)淡、另加边框,保证行内语法色 ≥ 7
- **选中项**一律 1px solid(VSCode 列表「选中未聚焦」为 dotted,tab 为 solid);焦点 2px
- 默认主题只改输入框 / 分段控件外框(见 3),其余分隔线保持低对比(VSCode 默认主题同样不保证 3:1,高对比度交给 HC 主题)

## 模块

| 文件 | 职责 |
|---|---|
| `electron/shared/window-background.ts` | `ResolvedTheme` 四值、`THEME_MODE_VALUES`、`isDarkTheme` / `isHighContrastTheme`、四套窗口底色 |
| `electron/shared/host-color-scheme.ts` | `HostColorScheme`、`hostColorSchemeFromNativeTheme`(VSCode `getColorScheme`)、`systemResolvedTheme`、payload 守卫 |
| `electron/main/services/window-theme.service.ts` | `getHostColorScheme()`、system 模式底色含 HC、`watchHostColorScheme` |
| `electron/main/ipc/window.ipc.ts` | `window:get-host-color-scheme`;notify-theme 入参放宽到四值 |
| `electron/preload/index.ts` | `coApi.window.getHostColorScheme / onHostColorSchemeChanged` |
| `src/theme/host-color-scheme.ts` | 渲染侧:媒体查询 + main 判定合成系统配色,`useSystemTheme` |
| `src/theme/ThemeProvider.tsx` / `initial-theme.ts` | 模式 → 四值 → `<html>` 类 |
| `src/styles/design-tokens.css` / `theme.css` | HC 两套 token |
| `src/styles/high-contrast.css` | HC 专有边框 / 轮廓规则 |
| `src/panels/Terminal/useTerminal.ts` | 四套 xterm 主题(`terminalThemeFor`)+ `terminalMinimumContrastRatio` |
