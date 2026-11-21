# terminal-bundled-font(终端内置 Nerd Font 以 WOFF2 加载)

perf:终端首选的 `MesloLGS NF`(MesloLGS Nerd Font Mono,Apache 2.0)随应用打包,首次打开终端时由
`src/styles/fonts.css` 的 `@font-face` 加载。原始 TTF 2,831,664 bytes,改为 **保留完整 glyph 集** 的 WOFF2
(不子集化:Nerd 图标码位不可盲目裁剪),字形与 cmap 与原 TTF 一致,只减少传输 / 解析字节。

## 行为契约

- `fonts.css` 的 `MesloLGS NF` 只引用 `.woff2`,`format('woff2')`,不再引用 TTF。
- 引用的文件存在,且是 WOFF2 容器(文件头魔数 `wOF2`)。
- `font-family` 名称不变(xterm `fontFamily` 首选项不受影响),`font-display: block` 不变。

## 规范文件

- `fonts-css.spec.ts`
