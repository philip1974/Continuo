# font-settings(编辑器 / 终端的字体族与行高)

背景:编辑器字体写死 `var(--wm-font-mono)`,终端字体 / 行高写死在 `useTerminal`,都不能改。

对齐 VSCode(`editorOptions.ts` / `fontInfo.ts`、`terminalConfiguration.ts` / `terminalConfigurationService.ts`):

| 设置 | 类型 / 默认 | 规则 |
|---|---|---|
| `editor.fontFamily` | 文本,默认 = 设计 token `--wm-font-mono` 的值 | 空 / 全空白 → 默认 |
| `editor.lineHeight` | 数字 0..150,默认 0 | 0 = 按字号自动;0 < v < 8 = 字号倍数;≥ 8 = 像素;取整且不低于 8px |
| `terminal.integrated.fontFamily` | 文本,默认空 | 空 → 跟随 `editor.fontFamily`;两者都没自定义 → 终端自带 Nerd Font 链 |
| `terminal.integrated.lineHeight` | 数字 1..10,默认 1 | 字号的倍数;0 / 非法 → 1 |

## 行为

### 1. 设置项(`font-settings.spec.tsx`)

- 编辑器页「外观」组:字体 → 字号 → 行高;终端页:字体 → 字号 → 行高。三语标题与说明;设置页搜 id 可搜到、可恢复默认(通用设置行机制)
- 编辑器字体默认值与 `--wm-font-mono` 一致(规范守护,改 token 须同步)
- 越界行高经设置读端夹取(编辑器 [0, 150]、终端 [1, 10]);设置页输入越界时行内提示允许范围(通用 number 行机制)

### 2. 取值规则(`font-settings.spec.tsx`)

- 字体串去首尾空白与结尾多余逗号;空 → 回落(编辑器 → 默认,终端 → 编辑器 → 自带链)
- 用户指定的终端字体后面接 Nerd Font 符号回退与 `monospace`(VSCode 总接 `monospace`;符号回退保住 Powerline / 图标字形)
- 编辑器行高按 VSCode fontInfo 换算成像素

### 3. 编辑器侧生效(`font-settings.spec.tsx`)

- `EditorFontFromSettings`(App 顶层,每个窗口各一份,popout 子窗也有)把字体与行高写到 `<html>` 的
  `--wm-editor-font-family` / `--wm-editor-line-height`;行高自动 → 移除变量(CodeMirror 默认 1.4)。改设置即时生效,
  其它窗口经设置跨窗同步各自更新
- 代码编辑器(含 Markdown 源码模式)`.cm-scroller` 取这两个变量;改字体 / 行高 / 字号后 CodeMirror 重新测量(光标、选区、
  点击定位按新行高)
- Markdown 编辑 / 预览:正文字体不变;代码块与行内代码跟随编辑器字体(`--crepe-font-code`;VSCode Markdown 预览代码同取
  编辑器字体),行高不跟随

### 4. 终端侧生效(`terminal-font-settings.spec.tsx`)

- 创建 xterm 时用设置值(含延迟初始化:见 terminal-lazy-init-settings)
- 改字体族 / 行高 / 字号 → 写到已有 xterm(不重建、不丢输出),随后 fit 重排行列并同步 PTY 尺寸;只改光标样式不 fit。
  xterm 在字体族 / 字号变化时重新测量字符尺寸;WebGL 渲染器的纹理图集按字体 / 字号 / 行高等配置缓存,配置变了即换用新图集
  (旧字形不会混进新字体)
- 终端字体优先于编辑器字体;留空跟随编辑器字体(VSCode 同)

## 与 VSCode 的差异

- `editor.lineHeight` 为 0(自动)时沿用 CodeMirror 默认的 1.4 倍,VSCode 是 mac 1.5 / 其它 1.35 倍(保持现有外观)
- 终端字体为空且编辑器字体也是默认值时,用终端自带 Nerd Font 链而不是编辑器字体(VSCode 编辑器默认字体是 Menlo 等;
  这里保住内置 MesloLGS NF 对 P10k 等图标字形的支持)

## E2E

`tests/e2e/font-settings.spec.ts`:改编辑器字体 / 行高 → 代码编辑器计算样式即时变化;改终端字体 / 行高 → xterm 选项与单元格尺寸变化,
行列数随之重排;popout 子窗里的编辑器同样生效。
