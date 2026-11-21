# terminal-panel-keyboard-new

行为契约:terminal 提供 `terminal.new` 命令,可从命令面板触发,默认快捷键是 `mod+t`。Op0 grep 已确认当前项目没有占用 `mod+t`,因此本 topic 锁定默认键位而不是 fallback 键位。

命令执行只负责请求 main 创建 PTY session;panel 创建仍由 sessions store 到 dockview reconciler 的统一路径完成。
