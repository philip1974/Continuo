# editor-markdown-link-href

行为契约:**Markdown 链接的地址在 Edit / Preview(Milkdown)里不被清空:盘符路径与 Continuo 用到的
`co:` / `vscode:` 链接渲染、点击、复制、确认编辑后保存都保留原地址;`javascript:` 等危险 scheme 仍被拦。**

## 背景

`@milkdown/preset-commonmark` ≥7.22 新增 `sanitizeLinkHref`:只放行 `http/https/mailto/tel/ftp`,
用 `/^([a-z][a-z0-9+.-]*):/i` 判 scheme,`C:/proj/a.md` 的 `C:` 也被当成 scheme。它用在两处:

- 链接 mark 的 `toDOM`:`<a href>` 为空 → Edit 里 Cmd+click 盘符链接无反应、`co://` 链接地址丢失。
- 链接气泡确认(`confirmEdit`):打开气泡不改内容直接回车,sanitize 后的 `""` 与原 href 不等 →
  mark 被替换成 `href: ""` → 文件写成 `[x]()`,自动保存后地址丢失(数据丢失)。

解析(`parseMarkdown`)与序列化(`toMarkdown`)不经过它:**仅打开文件、编辑别处并保存,地址不会丢**;
丢地址只发生在对该链接做了气泡确认之后。上游没有配置项可放开。

## 修复

`scripts/vite-milkdown-link-href.ts` 在构建期修补上游产物(renderer 构建走 vite transform,dev 预打包走
esbuild 插件,vitest 在单独的 `milkdown-patched` project 里把 `@milkdown/*` inline 后同样经过 transform):

- `^[A-Za-z]:[\\/]`(盘符路径)按无 scheme 处理,原样放行;
- scheme 白名单加入 `co:`、`vscode:`(只保证地址不被清空;点击能否打开仍由 `resolveLink` 白名单决定)。
- `javascript:` / `data:` / `vbscript:` / `file:` 等其余 scheme 照旧清空。

升级 Milkdown 后锚点对不上即构建报错;上游修了就删补丁。

链接气泡「复制链接」取气泡显示的文字(= mark 的原地址)而非 `<a href>`,白名单外 scheme 也能复制。

## Specs

| File | 覆盖 |
|---|---|
| `link-href-roundtrip.spec.ts` | 真实 Crepe(jsdom):三类链接往返不变、DOM href 保留、气泡确认后不变、盘符链接可解析;`javascript:` 仍拦;补丁锚点与配置注册 |
| `tests/e2e/markdown-link-href.spec.ts` | 真实 Electron:Edit 模式含盘符 / co: 链接的文件,确认气泡 + 编辑别处保存后地址仍在 |
