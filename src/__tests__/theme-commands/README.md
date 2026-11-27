# theme-commands(首选项:颜色主题 / 在浅色和深色主题之间切换)

背景:此前 ⇧⌘P 搜「主题 / theme」没有命令,只能到设置页切 `general.theme`。

对齐 VSCode(`src/vs/workbench/contrib/themes/browser/themes.contribution.ts`):

| 命令 | id | 默认键 |
|---|---|---|
| 首选项: 颜色主题 | `workbench.action.selectTheme` | 无(VSCode ⌘K ⌘T 是和弦,键位模型不支持和弦;可在快捷键页自行绑定) |
| 首选项: 在浅色和深色主题之间切换 | `workbench.action.toggleLightDarkThemes` | 无(VSCode 同) |

## 行为(`theme-commands.spec.tsx`)

### 1. 命令

- 三语标题,类别「首选项」;命令面板可按本地化标题或英文原名搜到(命令面板既有机制)
- popout 子窗里也经热键分发(进 `POPOUT_HOTKEY_COMMAND_IDS`):选择器画在按键所在子窗(picker 切片的 `hostDocument`,
  见 popout-picker);切换只改设置
- 执行颜色主题:打开选择器,关掉命令面板 / Quick Open / 打开最近(选择器互斥)

### 2. 颜色主题选择器

- 列出 亮色 / 暗色 / 跟随系统(设置页同序同名);打开时选中当前主题,当前项行尾标「当前」
- ↑↓ 移动即预览(VSCode `onDidChangeActive` → 'preview' 目标):只改界面,不写设置(不跨窗口同步、不落盘)
- Enter / 单击:写入 `general.theme` 并关闭
- Esc / 点遮罩 / 其它关闭路径(所在子窗关闭):关闭并恢复原主题(VSCode 未确定即 hide → 还原)
- 可输入过滤(本地化名称或英文模式名 light / dark / system);无匹配 → 提示,预览回到原主题
- 预览同步到 popout 子窗的 `<html>`:子窗各自按设置值定主题 class,但预览只在主窗 JS 环境,由主窗 ThemeProvider 一并写
  子窗 class(子窗里打开的选择器预览才可见;无预览时与子窗自己的结果一致)

### 3. 在浅色和深色主题之间切换

- 当前实际生效的是暗色 → 写入亮色,否则 → 暗色
- 跟随系统:按当前实际亮 / 暗写入相反的固定主题。**与 VSCode 的差异**:VSCode 在「自动检测系统配色」开着时拒绝切换并提示去设置;
  Continuo 的「跟随系统」是主题设置的一个值(没有独立的检测开关),切换等同于在设置页点另一项

## 模块

| 文件 | 职责 |
|---|---|
| `src/plugins/theme-picker/theme-commands.ts` | 命令 spec、`openThemePicker`、`toggleLightDarkThemes` |
| `src/plugins/theme-picker/store.ts` | picker 切片;`close` 清预览 |
| `src/plugins/theme-picker/ThemePickerModal.tsx` | 选择器 UI(共享 `usePickerList`) |
| `src/theme/ThemeProvider.tsx` | `useThemePreviewStore` / `setThemePreview`;生效主题 = 预览 ?? 设置;同步 popout 子窗 class |
| `src/shell/PickerModals.tsx` | 经 `PickerPortal` 挂载(画在触发窗口) |
| `src/core-plugins/WindowPlugin.ts` | 注册命令 |

## E2E

`tests/e2e/theme-commands.spec.ts`:命令面板搜到两条命令;选择器预览 / Esc 恢复 / Enter 生效(`<html>` class 与设置值);
popout 子窗里打开时选择器画在子窗、预览作用于子窗;切换浅深。
