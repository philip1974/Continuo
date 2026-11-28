# external-link-trusted-domains(外链确认 + 受信任的域)

对齐 VSCode 链接保护(`src/vs/workbench/contrib/url/browser/trustedDomainsValidator.ts`、`trustedDomains.ts`、
`src/vs/platform/url/common/trustedDomains.ts`):打开不受信的 http(s) 链接前先确认,用户可信任整个源 / 域名及其子域。
打开不可信项目时,Markdown 链接文字、终端 OSC 8 链接文字都可以与真实地址完全不同;确认框给出完整的真实地址。

## 模块

| 文件 | 职责 |
|---|---|
| `electron/shared/trusted-domains.ts` | 匹配规则 `isUrlTrusted`、「配置受信任的域」选项 `trustChoicesFor`、默认受信、列表规整(main / renderer 共用) |
| `electron/main/services/trusted-domains.service.ts` | 用户受信列表:`userData/trusted-domains.json`,串行读写,变更广播 |
| `electron/main/external-link-confirm.ts` | 原生确认框与「配置受信任的域」 |
| `electron/main/services/shell.service.ts` `openExternalIfAllowed` | 外链唯一出口:长度上限 → scheme 白名单 → sanitize → **受信域名确认** → 系统打开 |
| `src/plugins/settings/TrustedDomainsSettingRow.tsx` | 设置页「受信任的域」(`workbench.trustedDomains`) |

## 行为

### 确认(`open-external-confirm.spec.ts`)

- 所有外链入口都经 main 的 `openExternalIfAllowed`:编辑器 ⌘ 单击、Markdown 编辑 / 预览(含 mermaid 图链接)、终端 URL 与 OSC 8
  链接、插件页 / 市场页的 `target=_blank`(windowOpenHandler)、页面导航被拦(导航守卫)。帮助菜单的链接(本应用仓库)直接打开
- http(s) 且不受信 → 原生对话框(挂在获焦窗口上):「是否要让 Continuo 打开外部网站?」+ 完整地址(WHATWG 规范化后的 href,
  国际化域名显示 punycode,不截断);按钮「打开」「复制」「配置受信任的域」「取消」
  - 打开 → 系统打开;复制 → 地址进剪贴板、不打开;取消 → 不打开(不算失败,不提示)
  - 配置受信任的域 → 第二个对话框:信任 `<scheme://host[:port]>` / 信任 `<末两级域名>` 及其所有子域(IPv4 带端口:该地址的
    所有端口)/ 信任所有域(禁用链接保护)/ 管理受信任的域 / 取消。选了信任 → 写入并按新列表判定、打开;管理 → 打开设置页这一项
- 是否打开由 main 决定(原生对话框):页面内容(Markdown、终端输出、插件页)无法伪造「已确认」
- mailto 不走受信域名(VSCode 只校验 http / https);白名单外的 scheme 仍直接拒绝

### 匹配规则(`trusted-domains.spec.ts`,VSCode isURLDomainTrusted / testUrlMatchesGlob 的子集)

- `https://example.com`:scheme 与主机都相同(不隐式匹配子域);不写 scheme 的模式匹配 http 与 https
- `*.example.com`:example.com 本身及任意层子域
- 路径前缀按段匹配(`/a` 匹配 `/a`、`/a/b`,不匹配 `/ab`;`..` 先由 URL 解析消去);github.com 路径不区分大小写
- 端口:不写 = 默认端口;`:*` = 任意端口
- localhost / 127.0.0.1 / [::1] 始终受信;带用户信息(`https://github.com@evil.test`)的链接一律不受信;`*` = 信任所有
- 主机名按 punycode 比较:同形字域名不会匹配到 ASCII 域名

### 默认受信

- `https://github.com/philip1974/Continuo`(本应用仓库;帮助菜单的文档 / 发行说明 / 报告问题都在其下)。VSCode 的默认列表
  (product.json `linkProtectionTrustedDomains`,只在官方发行版里,OSS 构建为空)是它自己的产品域名;Continuo 的产品域名就是这个仓库,
  其余由用户添加。默认项在设置页标「默认」、不可删除

### 设置页(`trusted-domains-settings.spec.tsx`)

- 通用页「受信任的域」(`workbench.trustedDomains`,可搜索、`@id:` 定位):默认项只读;用户项可移除;输入框 + 「添加」
- 值在 main(不进设置值 store),经 IPC 读写;确认框里「信任 <域名>」等别处的变更经广播实时出现
- 命令「首选项: 管理受信任的域」(`workbench.action.manageTrustedDomain`,VSCode 同 id)打开设置并以 `@id:workbench.trustedDomains` 过滤

### 持久化

- `userData/trusted-domains.json` = `{ version: 1, domains: [...] }`(只存用户项);缺文件 = 空
- 读得出来但内容不对(JSON 损坏 / 格式不符 / 超大)→ 原文件隔离为 `.corrupt` 留证(不覆盖更早的证据),`domains` 里能抢救出的
  合法条目保留并立即写回,之后照常保存(同 workspace-trust 的损坏隔离;不因一次损坏让以后信任的域永远存不下来)
- 读不出来(权限 / IO 错误,内容未知)→ 本次运行按空列表处理(只会多问),且不写盘(不覆盖原文件);「配置受信任的域」对话框与
  设置页写明「本次修改只在退出 Continuo 前有效，不会保存。」

## 与 VSCode 的差异

- 管理界面是设置页里的列表,不是 VSCode 的 `trustedDomains:/Trusted Domains` JSON 编辑器
- 「配置受信任的域」是第二个原生对话框(VSCode 是快速选择)
- 持久化:VSCode 存在应用级 storage(SQLite;`readTrustedDomains` 对 JSON 解析失败静默当空,数据库打不开时删库改用 `.backup`,
  再不行用内存库)。Continuo 是独立 JSON 文件:损坏隔离留证并抢救条目,读不出来时不写盘并明确提示
- 确认框显示完整地址(VSCode 超过 60 字符时截掉 query / fragment 的中段)
- 不区分「来自工作区的链接」与受信工作区(VSCode `workbench.trustedDomains.promptInTrustedWorkspace`):始终确认

## e2e

`tests/e2e/external-link-confirm.spec.ts`:main 的 `shell.openExternal` 换成只记录的替身、`dialog.showMessageBox` 换成按序应答的替身
(绝不真的打开浏览器);Markdown 预览单击 / 编辑器 ⌘ 单击 / 终端 OSC 8 ⌘ 单击外链 → 确认框带完整地址,取消不打开、打开才打开;
「信任域名」后不再询问,设置页出现该项;Markdown 预览悬停链接显示真实地址。
