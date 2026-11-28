# file-name-invisible-chars(文件名里的双向控制 / 零宽字符可见化)

打开不可信项目时,文件名可以带 `U+202E`(RLO):`invoice‮txt.exe` 显示成 `invoiceexe.txt`;只差一个零宽字符的两个文件名看起来一样。
资源管理器行、编辑器 tab(及标题栏 / 状态栏 / 经 `editorTabTitle` 取名的确认框与提示)、Quick Open 等选择器(`highlightMatches`)、
搜索结果的文件行、确认框标题与资源管理器确认框的名字列表,把这些字符各显示成「�」(`src/lib/untrusted-text.tsx`
`revealInvisibleChars`,与授权弹窗的可见化同源)。

## 行为(`file-name-invisible-chars.spec.tsx`)

- 替换:控制字符(含换行 / Tab)、双向控制 U+202A–202E / U+2066–2069 / U+200E / 200F / U+061C、零宽 U+200B、U+2060–2064、BOM
- 不替换:正常文字(中文、韩文)、emoji ZWJ 组合、ZWNJ(波斯文 / 印地文)
- 等长替换:Quick Open 的匹配高亮下标照旧对得上;只改显示,实际路径、匹配与排序不变

## 与 VSCode 的差异

刻意增强:VSCode 的资源管理器 / tab / Quick Open 原样显示文件名(不处理双向控制字符)。
