# editor-markdown-link-href

行为契约:**Markdown 链接的地址在 Edit / Preview(Milkdown)里不被清空:盘符路径与任意自定义 scheme
(`co:` / `vscode:` / `obsidian:` …)链接渲染、复制、确认编辑后保存都保留原地址;`javascript:` / `data:` /
`vbscript:` / `file:` 仍被清空。能否点击打开另由 `resolveLink` 白名单决定。**

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

- 上游「白名单放行、其余清空」改为「只清空危险 scheme(`javascript:` / `data:` / `vbscript:` / `file:`)、其余原样保留」:
  地址是用户文件内容,编辑器不认识的 scheme(`obsidian://` 等)也不能在确认编辑时被抹掉。盘符路径 `C:/…`(被当成
  `C:` scheme)随之放行。
- 安全:Milkdown 内链接点击一律 `preventDefault` 后交给 `resolveLink`(白名单外返回 null 不打开),DOM href
  不会被直接导航;危险 scheme 在 DOM 中仍为空。

升级 Milkdown 后锚点对不上即构建报错;上游修了就删补丁。

链接气泡「复制链接」取气泡显示的文字(= mark 的原地址)而非 `<a href>`,白名单外 scheme 也能复制。

## Specs

| File | 覆盖 |
|---|---|
| `link-href-roundtrip.spec.ts` | 真实 Crepe(jsdom):三类链接往返不变、DOM href 保留、气泡确认后不变、盘符链接可解析;`javascript:` 仍拦;补丁锚点与配置注册 |
| `tests/e2e/markdown-link-href.spec.ts` | 真实 Electron:Edit 模式含盘符 / co: 链接的文件,确认气泡 + 编辑别处保存后地址仍在 |
