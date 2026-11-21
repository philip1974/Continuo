# Continuo —— 面向终端原生 agent 的开源 GUI 基座

[English](README.md) · **简体中文** · [한국어](README.ko.md)

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![GitHub stars](https://img.shields.io/github/stars/philip1974/Continuo?style=social)](https://github.com/philip1974/Continuo)

在一个可停靠的多终端 GUI 中运行 Claude Code、Codex CLI、Aider 或你自己的 agent。agent 只有在你于目标窗口内允许后才能操作；插件会声明它要用的权限（插件不在沙箱中运行，只安装你信任的插件）。**自带你的 agent。**

> **为什么做它：** 单个编码 agent 常常没做完就说「完成了」。Continuo 让你在同一个窗口里同时跑多个终端 agent —— 一个干活、一个审查 —— 这样你看到的是每个 agent 实际做了什么，而不是只能相信最后那句「完成了」。

## 下载

预构建安装包发布在 [Releases 页面](https://github.com/philip1974/Continuo/releases)，也可以从源码构建（见下方 **快速开始**）。

抢先体验版**只支持 macOS（Apple Silicon）且未签名**：挂载 `.dmg` 并把 Continuo 拖进 **应用程序** 文件夹后，**右键点击 app → 打开 → 打开**以绕过 Gatekeeper（macOS 14 及更早）；macOS 15 及以上请先尝试打开一次，再到 系统设置 → 隐私与安全性 点 **仍要打开**。若提示 app「已损坏」，请移除下载隔离标记：`xattr -dr com.apple.quarantine /Applications/Continuo.app`。代码签名 / 公证以及 Windows / Linux 构建会在之后提供。

## 首次运行反馈

1. 从源码构建（见下方 **快速开始**），或从 Releases 页面下载构建（未签名，见上方 Gatekeeper 说明）。
2. 通过 MCP stdio 桥接，把你平常用的终端 agent 接进来。
3. 告诉我们发生了什么：操作系统、agent，以及安装或 MCP 在哪一步出问题。

有用的反馈：

- app 打开了吗？
- 你试了哪个 agent：Claude Code、Codex CLI、Aider，还是你自己的？
- 安装或 MCP 集成在哪里失败了？
- 你会为真实工作第二次用它吗？

反馈 / issue：
<https://github.com/philip1974/Continuo/issues/new?template=first-run-feedback.md>

## 它「不是」什么

- ❌ 不是又一个 AI Markdown 编辑器
- ❌ 不是 Cursor / VSCode 的竞品
- ❌ 不是云托管；没有同步服务
- ❌ 不绑定某一个 agent 的品牌

## 快速开始

需要 **Node 24** 和 **pnpm 9 或更新版本**。

> **平台支持：** Continuo 目前只在 **macOS** 上运行和测试过。Windows 和 Linux 尚未测试 —— 可能可以运行，但请预期会有粗糙之处。欢迎反馈与修复。

**1 · 克隆、安装、运行 dev 构建**

Continuo 依赖同级仓库 [ContinuoTerminal](https://github.com/philip1974/ContinuoTerminal)（通过 `file:../ContinuoTerminal/...` 引用，固定在 `.continuo-terminal-ref` 记录的 commit）。把两个仓库克隆到同一目录下：

```bash
git clone https://github.com/philip1974/Continuo.git
git clone https://github.com/philip1974/ContinuoTerminal.git
git -C ContinuoTerminal checkout "$(cat Continuo/.continuo-terminal-ref)"

cd Continuo
pnpm install
pnpm dev
```

`debug.*` 工具需要微软的 js-debug 适配器，它不在仓库里。用 `node scripts/fetch-debug-adapter.mjs` 下载一次即可（固定版本并校验 SHA256）；安装版已自带。下载适配器后，`pnpm test` 会同时运行真实调试器的测试，需要先编译其测试程序：`pnpm exec tsc -p scripts/debug-spike/tsconfig.json`。

**2 · 把 Continuo 作为 MCP server 接入 Claude Code**

Continuo 附带一个 stdio 桥接（`scripts/continuo-mcp-stdio.mjs`），它通过 Unix socket / Windows 命名管道，把 MCP 流量代理进正在运行的 Continuo app。

```bash
claude mcp add --transport stdio continuo -- /absolute/path/to/Continuo/scripts/continuo-mcp-stdio.mjs
```

Windows 上需经 Node 调用：`claude mcp add --transport stdio continuo -- node "C:\path\to\Continuo\scripts\continuo-mcp-stdio.mjs"`。状态栏的 **复制 MCP 配置** 按钮会给出适合当前平台的命令。

其他支持 MCP 的 agent(如 Codex CLI)也有对应的 stdio MCP server 配置 —— 指向同一个脚本即可。

在 Continuo 终端里,bridge 总是连接拥有该终端的 Continuo 实例(其 socket 路径以 `CONTINUO_MCP_SOCKET` 注入),因此 dev 构建与安装版可以并存。在 Continuo 终端之外,它先尝试安装版,再尝试 dev 构建。在 MCP server 配置中显式设置 `CONTINUO_MCP_SOCKET` 可覆盖以上两者。macOS / Linux 上 bridge 只连接属于当前用户的 socket,且其所在目录须属于当前用户、group / other 不可写(Continuo 自己的 socket 总是满足);显式设置的值不满足该条件(其他用户的 socket、`/tmp` 下的 socket、解析后不满足上述条件的符号链接)时,bridge 直接报错退出,不连接、也不发送窗口 token。Windows 上显式设置的值必须是合法的本机 Continuo 管道名(`\\.\pipe\continuo-mcp-…`);其它值(远程管道、任意路径)会让 bridge 直接报错退出,不会回退到其它候选。

**3 · 让 agent 驱动 UI**

一旦 Continuo 运行起来并注册了 MCP server，agent 就可以调用：

| 工具 | 用途 |
|------|------|
| `terminal.create_session` | 新建一个终端面板（成为可停靠的瓦片） |
| `terminal.send_text` | 向某个 session 输入文本 |
| `terminal.send_input` | 向 session 写入原始字节（高级用法；优先用 `send_text` + `press_key`） |
| `terminal.press_key` | 发送一个具名按键（`enter`、`ctrl_c`、`tab`、`escape`、方向键等） |
| `terminal.read_output` | 读取已滚动过的输出 |
| `terminal.list_sessions` | 枚举活跃面板 |
| `terminal.kill` | 向 session 发信号:`SIGTERM`(默认)先发 Ctrl+C,3 秒后强杀;`SIGINT` 只发 Ctrl+C(Continuo 不会强制结束进程);`SIGKILL` 立即强杀。进程退出后面板保留,`list_sessions` 会返回其 `exit_code`;此时输出缓冲会被释放,如需最终输出请先调 `read_output` |
| `terminal.await_stop_hook` | 阻塞等待 session 里的 agent 触发 Stop hook（完成本轮）；只有用 `install_stop_hook: true`、`agentLabel` 为 `claude` / `claude-code` / `cc` / `codex` 且 cwd 位于窗口 workspace 文件夹内(不能是 home 目录或其上级目录)创建的 session 才会安装该 hook |
| `debug.*` | 驱动 Node.js 调试器：`launch`、`set_breakpoint`、`wait_for_stop`、`continue`、`step_over` / `step_in` / `step_out`、`stack`、`scopes`、`variables`、`evaluate`、`disconnect`、`list_sessions` |

agent 操作某个窗口之前，Continuo 会在该窗口里征求你的同意；终端权限与调试权限分开授予。`list_sessions` 能看到窗口内全部 session，但读 / 写 / kill / 等待类工具和 `debug.*` 只能作用于同一个 MCP 连接用 `create_session` 或 `debug.launch` 创建的 session。

> **在多用户主机上调试：** `debug.launch` 会话运行期间，被调试 Node 进程的 inspector 监听 `127.0.0.1` 上的随机端口。同一台机器上的其他本地用户都能连接该端口，并以你的身份在被调试进程内执行代码 —— 这是 Node / js-debug 的通用限制，并非 Continuo 特有。在多用户主机上请谨慎使用 `debug.launch`，用完及时断开会话。

让 Claude Code 试试：*「打开 4 个面板，分别运行 `pnpm test:unit`、`pnpm test:integration`、`pnpm test:contract`、`pnpm typecheck` —— 每个一个」*，然后看着它发生。

## 设计文档

文档紧贴代码：

- 紧邻代码的子区域 README：`src/plugins/`、`src/marketplace/`、`src/shell/dock/`、`src/stores/`、`electron/main/`
- 与相邻工具的定位对比：[POSITIONING.md](POSITIONING.md)
- 上手代码库：[CONTRIBUTING.md](CONTRIBUTING.md)
- 在本仓库中与 agent 协作：[AGENTS.md](AGENTS.md)
- 报告安全漏洞：[SECURITY.md](SECURITY.md)

## 许可证

MIT —— 见 [LICENSE](LICENSE)。第三方组件归属信息见 [LICENSE-3RD-PARTY.md](LICENSE-3RD-PARTY.md)。
