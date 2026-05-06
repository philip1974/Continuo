import { app, BrowserWindow, shell } from 'electron';
import type { HandlerDetails, WindowOpenHandlerResponse } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { registerIpc } from './ipc';
import { PLUGINS_CHANNELS } from '../shared/plugins-channels';
import { createMcpHost, type McpHost } from './services/mcp-host.service';
import {
  createStdioSocketServer,
  type StdioSocketServer,
} from './services/mcp-stdio-server.service';
import {
  makeListSessionsTool,
  makeCreateSessionTool,
  makeSendInputTool,
  makeSendTextTool,
  makePressKeyTool,
  makeReadOutputTool,
  makeKillTool,
  type CreateSessionPtyInput,
} from './services/mcp-tools-terminal';
import * as terminalSessions from './services/terminal-sessions.service';
import * as termService from './services/terminal.service';
import * as terminalBuffer from './services/terminal-buffer.service';
import { makeCreateHandler, setMcpEnvProvider } from './ipc/terminal.ipc';
import {
  requestAgentAuth,
  setMcpHostRef,
} from './services/agent-auth.service';
import { setStdioConfig } from './services/mcp-stdio-config.service';
import { startPluginMcpIpc } from './ipc/plugin-mcp.ipc';

// autorun delay:Win shell prompt 慢,默认更长。
const AUTORUN_DELAY_MS = process.platform === 'win32' ? 600 : 200;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const isDev = !app.isPackaged;
const PRELOAD = path.join(__dirname, '../preload/index.cjs');
const RENDERER_FILE = path.join(__dirname, '../renderer/index.html');

const COMMON_WEB_PREFERENCES = {
  preload: PRELOAD,
  contextIsolation: true,
  sandbox: true,
  nodeIntegration: false,
} as const;

// dockview popout 走 window.open(url),url 默认是当前 renderer URL。
// 同源 → allow + 注入我们的 preload + 安全 webPreferences。
// 外站 → 转交系统浏览器,deny 弹窗。
function windowOpenHandler({ url }: HandlerDetails): WindowOpenHandlerResponse {
  let allow = false;
  try {
    const target = new URL(url);
    const rendererOrigin = isDev
      ? new URL(process.env['ELECTRON_RENDERER_URL'] ?? '').origin
      : 'file://';
    allow = target.origin === rendererOrigin || target.protocol === 'file:';
  } catch {
    /* malformed URL → fall through to deny */
  }

  if (allow) {
    return {
      action: 'allow',
      overrideBrowserWindowOptions: {
        width: 800,
        height: 600,
        backgroundColor: '#020617',
        // 子窗口用系统默认标题栏:
        //   - 给用户一个明确的可拖区域(主窗口 hiddenInset 把 Continuo 文字
        //     做成可拖,popout 子窗里没有这条,需要原生 titlebar)
        //   - 避免 dockview tab bar 撞 macOS 红绿灯按钮
        webPreferences: COMMON_WEB_PREFERENCES,
      },
    };
  }
  shell.openExternal(url);
  return { action: 'deny' };
}

function createMainWindow() {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    titleBarStyle: 'hiddenInset',
    backgroundColor: '#020617',
    webPreferences: COMMON_WEB_PREFERENCES,
  });

  win.webContents.setWindowOpenHandler(windowOpenHandler);

  if (isDev && process.env['ELECTRON_RENDERER_URL']) {
    win.loadURL(process.env['ELECTRON_RENDERER_URL']);
  } else {
    win.loadFile(RENDERER_FILE);
  }

  return win;
}

// 给所有新创建的 webContents(包括 dockview popout 的子窗口)装上 windowOpenHandler。
// 这样从 popout 再 popout 也走我们的同一套安全策略。
app.on('web-contents-created', (_evt, contents) => {
  contents.setWindowOpenHandler(windowOpenHandler);
});

// popout 子窗口禁止刷新。
// 原因:dockview 用 portal 把 panel 注到子窗 body,reload 清空 portal 目标
// 但 main 端 dockview state 还在 → 子窗黑屏。
// did-start-navigation 是 "did" 事件不能 preventDefault,改成在键盘事件层吞掉
// Cmd+R / Ctrl+R / F5,并去掉 popout 的菜单(避免菜单里的 Reload)。
app.on('browser-window-created', (_evt, win) => {
  win.webContents.once('did-finish-load', () => {
    if (!win.webContents.getURL().includes('popout=1')) return;
    win.setMenu(null);
    win.webContents.on('before-input-event', (event, input) => {
      if (input.type !== 'keyDown') return;
      const isReloadKey =
        ((input.meta || input.control) && input.key.toLowerCase() === 'r') ||
        input.key === 'F5';
      if (isReloadKey) event.preventDefault();
    });
  });
});

// M-Plugin v4.4:co:// 协议处理(原 co://,v0.2 改名 Continuo)
// macOS:open-url(用户点 co://...);Windows / Linux:single-instance argv

const PROTOCOL = 'co';
let pendingProtocolUrl: string | null = null;

function dispatchProtocolUrl(url: string): void {
  const wins = BrowserWindow.getAllWindows();
  if (wins.length === 0) {
    pendingProtocolUrl = url;
    return;
  }
  for (const win of wins) {
    if (!win.isDestroyed()) {
      win.webContents.send(PLUGINS_CHANNELS.PROTOCOL_URL, { url });
    }
  }
}

if (process.defaultApp) {
  if (process.argv.length >= 2) {
    app.setAsDefaultProtocolClient(PROTOCOL, process.execPath, [
      path.resolve(process.argv[1]!),
    ]);
  }
} else {
  app.setAsDefaultProtocolClient(PROTOCOL);
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', (_e, argv) => {
    const url = argv.find((a) => a.startsWith(`${PROTOCOL}://`));
    if (url) dispatchProtocolUrl(url);
    const wins = BrowserWindow.getAllWindows();
    if (wins[0]) {
      if (wins[0].isMinimized()) wins[0].restore();
      wins[0].focus();
    }
  });
}

app.on('open-url', (event, url) => {
  event.preventDefault();
  dispatchProtocolUrl(url);
});

// Agent Terminal MCP host(P1):启动 HTTP server,把 token / url 通过 env
// 注入到所有 PTY → 用户在 terminal 跑 claude / codex 时反连本机 host。
// P4+ C 方案:同时启 stdio server(unix socket),Claude Code 走 stdio 配置一次永久使用。
let mcpHost: McpHost | null = null;
let mcpStdio: StdioSocketServer | null = null;

// MCP tool 共享的 PTY create 入口:复用 IPC 端的 makeCreateHandler 工厂,
// 包一层 lazy mainWindow 查询(tool 调用时窗口必在,但 host 启动时还没创建)。
const ptyCreateHandler = makeCreateHandler();

async function createSessionForAgent(
  input: CreateSessionPtyInput,
): Promise<{ id: string }> {
  const wins = BrowserWindow.getAllWindows();
  const win = wins.find((w) => !w.isDestroyed()) ?? null;
  if (!win) {
    throw Object.assign(new Error('no main window for terminal create'), {
      code: 'TERMINAL_NO_WINDOW',
    });
  }
  const r = ptyCreateHandler(input, win);
  // P3 autorun:spawn 后 delay 200ms(Win 600)等 shell prompt 出现,然后键入命令。
  // 不严格保证 prompt 已就绪 — 平台差异大,简单 timer 是最务实的近似。
  if (input.autorun) {
    const cmd = input.autorun;
    setTimeout(() => {
      if (termService.has(r.id)) {
        termService.write(r.id, `${cmd}\n`);
      }
    }, AUTORUN_DELAY_MS);
  }
  return r;
}

async function startMcpHost(): Promise<void> {
  try {
    mcpHost = await createMcpHost({
      initialTools: [
        makeListSessionsTool({
          getSessions: () => terminalSessions.getAll(),
        }),
        makeCreateSessionTool({
          ensureAuthorized: () =>
            requestAgentAuth({ method: 'terminal.create_session' }),
          createSession: createSessionForAgent,
        }),
        makeSendInputTool({
          has: (id) => termService.has(id),
          write: (id, data) => termService.write(id, data),
        }),
        makeSendTextTool({
          has: (id) => termService.has(id),
          write: (id, data) => termService.write(id, data),
        }),
        makePressKeyTool({
          has: (id) => termService.has(id),
          write: (id, data) => termService.write(id, data),
        }),
        makeReadOutputTool({
          read: (id, opts) => terminalBuffer.read(id, opts),
        }),
        makeKillTool({
          has: (id) => termService.has(id),
          interrupt: (id) => termService.interrupt(id),
          kill: (id) => termService.kill(id),
          forceKill: (id) => termService.forceKill(id),
        }),
      ],
    });
    setMcpEnvProvider(() => ({
      CONTINUO_MCP_URL: mcpHost!.url,
      CONTINUO_MCP_TOKEN: mcpHost!.token,
      CONTINUO_HOST: 'desktop',
    }));
    // 给 agent-auth service 注入 host 引用,撤销时 rotate token。
    setMcpHostRef(mcpHost);
    // eslint-disable-next-line no-console
    console.log(`[mcp-host] listening on ${mcpHost.url}`);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(
      '[mcp-host] failed to start, agent terminal MCP unavailable',
      err,
    );
  }
}

/**
 * stdio CLI proxy 路径:
 *  - packaged app:`<resourcesPath>/continuo-mcp-stdio.mjs`(electron-builder
 *    extraResources 拷过去)
 *  - dev:`scripts/continuo-mcp-stdio.mjs`(项目根)
 */
function resolveStdioCliPath(): string {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'continuo-mcp-stdio.mjs');
  }
  // dev:从 main 的 __dirname(out/main/)往上找项目根
  return path.resolve(__dirname, '..', '..', 'scripts', 'continuo-mcp-stdio.mjs');
}

/**
 * stdio socket / named pipe 路径(跨平台):
 *  - macOS / Linux:`<userData>/mcp.sock`(unix socket,文件系统)
 *  - Windows:`\\.\pipe\continuo-mcp`(named pipe,不在文件系统;
 *    单实例 lock 已防双实例,无需 pid 后缀)
 *
 * CLI proxy(scripts/continuo-mcp-stdio.mjs)有同款默认值算法,两边对齐。
 */
function resolveStdioSocketPath(): string {
  if (process.platform === 'win32') {
    return '\\\\.\\pipe\\continuo-mcp';
  }
  return path.join(app.getPath('userData'), 'mcp.sock');
}

async function startMcpStdioServer(): Promise<void> {
  if (!mcpHost) {
    // eslint-disable-next-line no-console
    console.warn('[mcp-stdio] http host not started, skipping stdio');
    return;
  }
  const socketPath = resolveStdioSocketPath();
  try {
    mcpStdio = await createStdioSocketServer({
      socketPath,
      tools: mcpHost.tools,
      serverInfo: mcpHost.serverInfo,
    });
    const cliPath = resolveStdioCliPath();
    const claudeAddCommand = `claude mcp add --transport stdio continuo -- ${cliPath}`;
    // eslint-disable-next-line no-console
    console.log(`[mcp-stdio] listening on ${mcpStdio.socketPath}`);
    // 打印推荐的 claude mcp add 命令,用户复制即可一次配置永久使用
    // eslint-disable-next-line no-console
    console.log(
      '[mcp-stdio] one-shot config (Claude Code):\n' +
        `  ${claudeAddCommand}`,
    );
    // 缓存配置给状态栏"复制 MCP 配置"按钮用
    setStdioConfig({
      available: true,
      cliPath,
      socketPath: mcpStdio.socketPath,
      claudeAddCommand,
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(
      '[mcp-stdio] failed to start, stdio MCP transport unavailable',
      err,
    );
  }
}

app.whenReady().then(async () => {
  registerIpc();
  // 在 createMainWindow 之前启 host,确保 renderer autoSpawn 的第一个 PTY
  // env 已含 MCP url / token。
  await startMcpHost();
  await startMcpStdioServer();
  // Plugin → MCP bridge 接线(host 已就绪,renderer 通过 IPC 注册的 tool 走它)
  if (mcpHost) startPluginMcpIpc(mcpHost);
  const win = createMainWindow();

  // 冷启 + open-url 顺序处理:可能在 mainwindow 未就绪前已收 url
  if (pendingProtocolUrl) {
    win.webContents.once('did-finish-load', () => {
      if (pendingProtocolUrl) {
        win.webContents.send(PLUGINS_CHANNELS.PROTOCOL_URL, {
          url: pendingProtocolUrl,
        });
        pendingProtocolUrl = null;
      }
    });
  }

  if (!process.defaultApp) {
    const url = process.argv.find((a) => a.startsWith(`${PROTOCOL}://`));
    if (url) {
      win.webContents.once('did-finish-load', () => {
        win.webContents.send(PLUGINS_CHANNELS.PROTOCOL_URL, { url });
      });
    }
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  // best-effort 关 MCP host + stdio socket(连接 / 文件一并清)
  void mcpHost?.close().catch(() => {});
  void mcpStdio?.close().catch(() => {});
});
