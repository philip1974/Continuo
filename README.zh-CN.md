# Continuo —— 面向终端原生 agent 的开源 GUI 基座

[English](README.md) · **简体中文** · [한국어](README.ko.md)

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Latest release](https://img.shields.io/github/v/release/philip1974/Continuo)](https://github.com/philip1974/Continuo/releases/latest)
[![GitHub stars](https://img.shields.io/github/stars/philip1974/Continuo?style=social)](https://github.com/philip1974/Continuo)

在一个可停靠的多终端 GUI 中运行 Claude Code、Codex CLI、Aider 或你自己的 agent。每个 agent 都在明确的「按插件」权限边界内工作。**自带你的 agent。**

## 演示

真实的 Claude Code 通过 Continuo 的 MCP 驱动 Codex —— Claude Code 自己打开*第二个*终端面板，把任务交给 Codex，再读回结果，全部在同一个窗口内完成：

![Continuo 演示 —— Claude Code 与 Codex 在同一窗口内协作](docs/assets/demo.gif)

▶️ [带音频 / 完整画质观看](https://github.com/philip1974/Continuo/releases/download/v0.2.4-early/continuo-demo.mp4)

## 下载

想直接试用 Continuo，不想从源码构建？

**macOS（Apple Silicon）** —— 抢先体验版，**未签名**构建：

- [DMG](https://github.com/philip1974/Continuo/releases/download/v0.2.4-early/Continuo-0.2.4-arm64.dmg)
- [ZIP 备用下载](https://github.com/philip1974/Continuo/releases/download/v0.2.4-early/Continuo-0.2.4-arm64-mac.zip)
- [SHA256 校验和](https://github.com/philip1974/Continuo/releases/download/v0.2.4-early/SHA256SUMS.txt)

更喜欢用 release 页面？[下载最新 release](https://github.com/philip1974/Continuo/releases/latest)。

> 未签名构建：挂载 `.dmg` 后，**右键点击 app → 打开 → 打开**以绕过 Gatekeeper。代码签名 / 公证会在后续 release 中加入。Windows / Linux 构建正在路上。更想从源码构建？见下方 **快速开始**。

## 首次运行反馈

1. 下载上方的 macOS Apple Silicon 构建。
2. 用右键 -> 打开，启动这个未签名 app。
3. 通过 MCP stdio 桥接，把你平常用的终端 agent 接进来。
4. 告诉我们发生了什么：操作系统、agent，以及安装或 MCP 在哪一步出问题。

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

需要 **Node 24** 和 **pnpm**。

> **平台支持：** Continuo 目前只在 **macOS** 上运行和测试过。Windows 和 Linux 尚未测试 —— 可能可以运行，但请预期会有粗糙之处。欢迎反馈与修复。

**1 · 安装 + 运行 dev 构建**

```bash
pnpm install
pnpm dev
```

**2 · 把 Continuo 作为 MCP server 接入 Claude Code**

Continuo 附带一个 stdio 桥接（`scripts/continuo-mcp-stdio.mjs`），它通过 Unix socket / Windows 命名管道，把 MCP 流量代理进正在运行的 Continuo app。

```bash
claude mcp add --transport stdio continuo -- /absolute/path/to/Continuo/scripts/continuo-mcp-stdio.mjs
```

Codex CLI / Aider 有类似的 stdio-MCP server 配置 —— 指向同一个脚本即可。

**3 · 让 agent 驱动 UI**

一旦 Continuo 运行起来并注册了 MCP server，agent 就可以调用：

| 工具 | 用途 |
|------|------|
| `terminal.create_session` | 新建一个终端面板（成为可停靠的瓦片） |
| `terminal.send_text` | 向某个 session 输入文本 |
| `terminal.press_key` | 发送一个具名按键（Enter、Ctrl+C 等） |
| `terminal.read_output` | 读取已滚动过的输出 |
| `terminal.list_sessions` | 枚举活跃面板 |
| `terminal.kill` | 拆掉一个面板 |

让 Claude Code 试试：*「打开 4 个面板，分别运行 `pnpm test:unit`、`pnpm test:integration`、`pnpm test:contract`、`pnpm e2e` —— 每个一个」*，然后看着它发生。

## 设计文档

架构、历史与 ADR 深度内容存放在独立的 **ContinuoWiki** 仓库（相对本代码库为只读）。本 README 是表层 —— wiki 才是深度。给贡献者的本地快速参考：

- 紧邻代码的子区域 README：`src/plugins/`、`src/marketplace/`、`src/shell/dock/`、`src/stores/`、`electron/main/`
- ADR：`doc/adr/`
- 与相邻工具的定位对比：[POSITIONING.md](POSITIONING.md)
- 上手代码库：[CONTRIBUTING.md](CONTRIBUTING.md)
- 在本仓库中与 agent 协作：[AGENTS.md](AGENTS.md)

## 许可证

MIT —— 见 [LICENSE](LICENSE)。第三方组件归属信息见 [LICENSE-3RD-PARTY.md](LICENSE-3RD-PARTY.md)。
