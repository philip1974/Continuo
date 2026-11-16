# protocol-url-ready-handshake

冷启动 co:// 深链的「renderer 协议监听就绪」握手。

此前 main 以 `did-finish-load`(`!isLoading()`)判定窗口就绪并排空深链队列;但 renderer 是动态
import main-app、再 await locale IPC 之后才调用 `coApi.plugins.onProtocolUrl` 挂监听 —— 文档 load
完成时监听往往还没挂上,深链投给无人接收的 renderer 被丢弃。

## 行为契约

- preload 的 `onProtocolUrl` 先挂 `plugins:protocol-url` 监听,再经 `plugins:protocol-ready` 上报
  「本窗口协议监听就绪」(与 `layout:flush-ready` 同款)。
- main 只向已上报就绪的窗口投递 / 排空深链:文档已加载完成(`did-finish-load`)但尚未上报就绪的窗口
  不投递,深链继续排队(队列上限与 FIFO 语义不变)。
- 窗口上报就绪后按 FIFO 一次性排空队列;之后到达的深链直接投给就绪窗口。
- main 端就绪上报须来自受信 frame 且能解析到发送方窗口;窗口主 frame 重新导航(reload)后就绪
  状态作废,等新文档重新上报。
