# hotkey-editor-handled

全局命令热键(`useCommandHotkeys`,挂在 document)遇到「编辑器已处理」的按键不再执行:

- 事件目标在 Milkdown 的 ProseMirror 或 CodeMirror 6(`.ProseMirror` / `.cm-editor`)内,且已被 `preventDefault`
  (编辑器用该键执行了自己的动作)→ 跳过。否则 Markdown 里 ⌘B 会同时加粗与切换侧栏;用户把命令改绑到编辑器自带
  键位(mod+d / mod+/ 等)时同样一键两动作。
- 编辑器内未处理的组合(如 ⌘S 之外的全局命令)照常执行。
- 编辑器之外的可编辑控件(xterm 的 textarea 等)即使 preventDefault 也照常执行:它们可能对未处理的组合也取消默认行为,
  不据此拦命令(终端的让出另由 terminal-hotkeys 处理)。
