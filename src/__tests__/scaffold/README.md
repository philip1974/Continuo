# 工程骨架就绪 (M1)

行为契约:在打开主窗口的那一刻,用户应能感知到:

1. 应用窗口出现,标题为 "LayoutMotion"。
2. 主区域显示 "Hello LayoutMotion"。
3. preload 桥已建立(`window.api.ping()` 返回 `'pong'`)。

> 注:Electron 主进程的端到端验证留给手工 demo。本主题只做 preload API 契约的纯函数级 BDD。
