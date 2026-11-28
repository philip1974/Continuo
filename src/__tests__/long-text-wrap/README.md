# long-text-wrap(长路径 / 长文件名在对话框与 toast 里折行,韩文界面也一样)

## 背景

韩文界面按词(어절)断行靠 `word-break: keep-all`(`src/styles/theme.css`,`<html lang="ko">`)。此前写成**未分层**的
`:lang(ko) { word-break: keep-all }`:它匹配每个元素,且未分层样式压过一切 `@layer` 规则(与特异性无关),于是
Tailwind `break-all`(授权弹窗里的 `UntrustedText` / 命令块、卸载插件确认框里的插件 id)、`Toast.css` 的
`word-break: break-word` 全部失效 —— 长路径 / 长文件名(无空格)不折行,撑破授权弹窗与 toast(「열기 실패
binaryfilewithaverylongname…」越出右边)。

## 参考:VSCode

| VSCode | 做法 | 出处 |
|---|---|---|
| 按语言的工作台样式 | `:lang()` 规则只挂在根容器 `.monaco-workbench` 上(字体),子元素靠继承 | `src/vs/workbench/browser/media/style.css` |
| 对话框正文 / 详情 | `word-wrap: break-word` —— 长词放不下时断到下一行,不溢出 | `src/vs/base/browser/ui/dialog/dialog.css` |
| 通知(toast)正文 | `word-wrap: break-word` | `src/vs/workbench/browser/parts/notifications/media/notificationsList.css` |

## 行为

1. **韩文 keep-all 只在根元素、base 层**:`@layer base { :root:lang(ko) { word-break: keep-all } }`,靠继承下传 —— 韩文正文仍按词断行;
   任何元素自己写的 `word-break`(`break-all` 等,含 utilities / components 层与组件 CSS)覆盖它并作用于其子树。不再有未分层的 `:lang(ko)` 规则。
2. **toast 正文**(`.toast__message`):`overflow-wrap: anywhere`,不设 `word-break`(韩文继承 keep-all,只有放不下的长串在词内断开)。
3. **确认框**(`ConfirmDialog`,写保护文件「覆盖?」、删除、未保存关闭、最近项目已不存在等):标题与说明区 `[overflow-wrap:anywhere]`
   —— 标题 / 说明里的长文件名、长路径放不下时折行,不越出对话框。
4. **授权弹窗里对方可控的文本**(`UntrustedText` / `UntrustedBlock`)与调试控制台行:元素自己的 `break-all` 生效(不再需要另加
   `[overflow-wrap:anywhere]` 绕过 keep-all)。
5. 韩 / 中 / 英三种界面下,授权弹窗(插件 id、agent 工作目录)、toast(打开二进制长文件名失败)、写保护文件确认框的内容都不越出容器
   (e2e 量 `scrollWidth ≤ clientWidth`,且子元素右缘不超出容器)。

## 规范

| 文件 | 覆盖 |
|---|---|
| `long-text-wrap.spec.tsx` | 1–4:theme.css 的 keep-all 只在 base 层根元素、无未分层 `:lang(ko)`;Toast.css 正文 overflow-wrap 且不设 word-break;ConfirmDialog 标题 / 说明 overflow-wrap;UntrustedText / UntrustedBlock 用 break-all |
| `tests/e2e/long-text-wrap-locale.spec.ts` | 5:真实应用,ko / zh / en 下授权弹窗、toast、确认框不越界 |
