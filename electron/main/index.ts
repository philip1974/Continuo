import { app, BrowserWindow, dialog, ipcMain, Menu, shell } from 'electron';
import type {
  HandlerDetails,
  IpcMainEvent,
  MenuItemConstructorOptions,
  WindowOpenHandlerResponse,
} from 'electron';
import nodeFs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { registerIpc } from './ipc';
import {
  allocateWindowSeq,
  defaultExplorerV3,
  ensureWindowEntry,
  loadExplorer,
  migrateExplorerFileToV3,
  pruneLRUClosed,
} from './persistence';
import { pickWindowsToRestore } from './services/window-restore.service';
import { pickStartupMode } from './services/startup-mode.service';
import {
  clearWindow,
  getActiveSeqs,
  setWindowSeq,
} from './services/window-seq.service';
import { withExplorerFileMutex } from './lib/file-mutex';
import { atomicWriteJson } from './lib/atomic-write';
import { PLUGINS_CHANNELS } from '../shared/plugins-channels';
import {
  createMcpHost,
  setMcpRevokers,
  type McpCallCtx,
  type McpHost,
} from './services/mcp-host.service';
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
import { defaultIsTrustedFrame } from './safe-handle';

// autorun delay:Win shell prompt 慢,默认更长。
const AUTORUN_DELAY_MS = process.platform === 'win32' ? 600 : 200;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const isDev = !app.isPackaged;
const PRELOAD = path.join(__dirname, '../preload/index.cjs');
const RENDERER_FILE = path.join(__dirname, '../renderer/index.html');

// dev 与 packaged Continuo.app 必须用不同 userData,否则:
// (a) requestSingleInstanceLock 互踩 → 后启动的 quit;
// (b) <userData>/mcp.sock 会被后者 unlink,冲掉前者正在监听的 socket;
// (c) explorer.json / LevelDB / Cookies 并发写报错。
// 必须在 requestSingleInstanceLock 与任何 getPath('userData') 之前调用。
if (isDev) {
  app.setPath('userData', path.join(app.getPath('appData'), 'Continuo Dev'));
}

const COMMON_WEB_PREFERENCES = {
  preload: PRELOAD,
  contextIsolation: true,
  sandbox: true,
  nodeIntegration: false,
} as const;

const LRU_MAX_CLOSED = Infinity;
const pendingFlushAcks = new Map<number, () => void>();
const flushedOnQuit = new Set<number>();

ipcMain.on('window:id', (event: IpcMainEvent) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  event.returnValue = win?.id ?? 0;
});

ipcMain.on('system:hostname', (event: IpcMainEvent) => {
  event.returnValue = os.hostname();
});

ipcMain.on('layout:flush-ack', (event: IpcMainEvent, windowId: unknown) => {
  if (!defaultIsTrustedFrame(event.senderFrame)) return;
  if (typeof windowId !== 'number') return;
  const senderWin = BrowserWindow.fromWebContents(event.sender);
  if (!senderWin || senderWin.id !== windowId) return;
  const cb = pendingFlushAcks.get(windowId);
  if (cb) cb();
});

function requestWindowFlush(win: BrowserWindow): Promise<void> {
  return new Promise((resolve) => {
    let doneCalled = false;
    let timer: NodeJS.Timeout | null = null;
    const done = () => {
      if (doneCalled) return;
      doneCalled = true;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      pendingFlushAcks.delete(win.id);
      resolve();
    };
    pendingFlushAcks.set(win.id, done);
    timer = setTimeout(done, 1000);
    try {
      win.webContents.send('layout:flush-request', { windowId: win.id });
    } catch {
      done();
    }
  });
}

function wireWindowCloseFlush(win: BrowserWindow): void {
  let flushed = flushedOnQuit.has(win.id);
  win.on('close', (event) => {
    if (flushed) return;
    event.preventDefault();
    void (async () => {
      await requestWindowFlush(win);
      flushed = true;
      flushedOnQuit.add(win.id);
      win.close();
    })();
  });
}

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

interface CreateMainWindowOpts {
  /** issue #23 Phase 1:新窗口直接打开此 workspace,通过 query string 注入. */
  readonly workspace?: string;
  /**
   * issue #23 Phase 2B:windowSeq 标识此窗口在 explorer.json windows[] 中的段。
   * 主窗(冷启动时第一个)硬编码 0;新窗由 IPC handler 从磁盘 nextWindowSeq 算。
   */
  readonly windowSeq: number;
}

export function createMainWindow(opts: CreateMainWindowOpts) {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    titleBarStyle: 'hiddenInset',
    backgroundColor: '#020617',
    webPreferences: COMMON_WEB_PREFERENCES,
  });

  const seq = opts.windowSeq;
  setWindowSeq(win.id, seq);
  wireWindowCloseFlush(win);

  win.on('closed', () => {
    clearWindow(win.id);
    const explorerFile = path.join(app.getPath('userData'), 'explorer.json');
    void withExplorerFileMutex(async () => {
      const payload = (await loadExplorer(explorerFile)) ?? defaultExplorerV3();
      const entry = ensureWindowEntry(payload, seq);
      entry.lastClosedAt = Date.now();
      pruneLRUClosed(payload, LRU_MAX_CLOSED, getActiveSeqs());
      await atomicWriteJson(explorerFile, payload);
    });
  });

  win.webContents.setWindowOpenHandler(windowOpenHandler);

  // 多窗口:opts.workspace + opts.windowSeq 走 query string,renderer
  // parseInitialWorkspace / parseInitialWindowSeq 接收。dev loadURL 与 prod
  // loadFile 都加 query;loadFile 第二参支持 query 字段。
  const queryParts: Record<string, string> = {
    windowSeq: String(seq),
  };
  if (opts.workspace) queryParts['workspace'] = opts.workspace;

  if (isDev && process.env['ELECTRON_RENDERER_URL']) {
    const url = new URL(process.env['ELECTRON_RENDERER_URL']);
    for (const [k, v] of Object.entries(queryParts)) {
      url.searchParams.set(k, v);
    }
    win.loadURL(url.toString());
  } else {
    win.loadFile(RENDERER_FILE, { query: queryParts });
  }

  return win;
}

// 给所有新创建的 webContents(包括 dockview popout 的子窗口)装上 windowOpenHandler。
// 这样从 popout 再 popout 也走我们的同一套安全策略。
app.on('web-contents-created', (_evt, contents) => {
  contents.setWindowOpenHandler(windowOpenHandler);
});

// ─────────────────────────────────────────────────────
// Application menu(issue #23 衍生 UX:可见入口)
// macOS 标准 template + File 项加 New Window / Open Folder in New Window…
// 跨平台:Linux/Windows menu 同款 File 项。
// ─────────────────────────────────────────────────────

async function openFolderInNewWindow(): Promise<void> {
  const r = await dialog.showOpenDialog({ properties: ['openDirectory'] });
  if (r.canceled || r.filePaths.length === 0) return;
  const folder = r.filePaths[0]!;
  const explorerFile = path.join(app.getPath('userData'), 'explorer.json');
  const windowSeq = await allocateWindowSeq(explorerFile);
  createMainWindow({ windowSeq, workspace: folder });
}

async function newWindow(): Promise<void> {
  const explorerFile = path.join(app.getPath('userData'), 'explorer.json');
  const windowSeq = await allocateWindowSeq(explorerFile);
  createMainWindow({ windowSeq });
}

function buildAppMenu(): Menu {
  const isMac = process.platform === 'darwin';
  const fileSubmenu: MenuItemConstructorOptions[] = [
    {
      label: 'New Window',
      accelerator: 'CmdOrCtrl+Shift+N',
      click: () => {
        void newWindow();
      },
    },
    {
      label: 'Open Folder in New Window…',
      click: () => {
        void openFolderInNewWindow();
      },
    },
    { type: 'separator' },
    isMac ? { role: 'close' } : { role: 'quit' },
  ];

  const template: MenuItemConstructorOptions[] = [
    ...(isMac
      ? ([
          {
            label: app.name,
            submenu: [
              { role: 'about' },
              { type: 'separator' },
              { role: 'services' },
              { type: 'separator' },
              { role: 'hide' },
              { role: 'hideOthers' },
              { role: 'unhide' },
              { type: 'separator' },
              { role: 'quit' },
            ],
          },
        ] satisfies MenuItemConstructorOptions[])
      : []),
    { label: 'File', submenu: fileSubmenu },
    { role: 'editMenu' },
    { role: 'viewMenu' },
    { role: 'windowMenu' },
  ];

  return Menu.buildFromTemplate(template);
}

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

// ─────────────────────────────────────────────────────
// macOS open-file:用户拖文件夹到 Dock 图标 / 用 "Open With Continuo"。
// 拿到目录路径 → 在新窗口打开;文件路径暂忽略(后续 Phase 接 editor)。
// 冷启时事件可能在 whenReady 之前触发,缓冲到 ready 后处理。
// ─────────────────────────────────────────────────────
const pendingOpenPaths: string[] = [];

async function openPathInNewWindow(absPath: string): Promise<void> {
  let isDir = false;
  try {
    isDir = nodeFs.statSync(absPath).isDirectory();
  } catch {
    /* 路径不存在 / 无权限 → 跳过 */
  }
  if (!isDir) return;
  const explorerFile = path.join(app.getPath('userData'), 'explorer.json');
  const windowSeq = await allocateWindowSeq(explorerFile);
  createMainWindow({ windowSeq, workspace: absPath });
}

app.on('open-file', (event, filePath) => {
  event.preventDefault();
  if (!app.isReady()) {
    pendingOpenPaths.push(filePath);
    return;
  }
  void openPathInNewWindow(filePath);
});

// Agent Terminal MCP host(P1):启动 HTTP server,把 token / url 通过 env
// 注入到所有 PTY → 用户在 terminal 跑 claude / codex 时反连本机 host。
// P4+ C 方案:同时启 stdio server(unix socket),Claude Code 走 stdio 配置一次永久使用。
let mcpHost: McpHost | null = null;
let mcpStdio: StdioSocketServer | null = null;

// MCP tool 共享的 PTY create 入口:复用 IPC 端的 makeCreateHandler 工厂,
// 包一层 lazy mainWindow 查询(tool 调用时窗口必在,但 host 启动时还没创建)。
const ptyCreateHandler = makeCreateHandler();
const getSessionOwner = (id: string): number | null =>
  terminalSessions.get(id)?.ownerWindowId ?? null;

async function createSessionForAgent(
  input: CreateSessionPtyInput,
  ctx: McpCallCtx,
): Promise<{ id: string }> {
  const win = BrowserWindow.fromId(ctx.ownerWindowId);
  if (!win || win.isDestroyed()) {
    throw Object.assign(new Error('no window for terminal create'), {
      code: 'TERMINAL_NO_WINDOW',
    });
  }
  const r = await ptyCreateHandler(input, win);
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
          getSessionOwner,
        }),
        makeSendTextTool({
          has: (id) => termService.has(id),
          write: (id, data) => termService.write(id, data),
          getSessionOwner,
        }),
        makePressKeyTool({
          has: (id) => termService.has(id),
          write: (id, data) => termService.write(id, data),
          getSessionOwner,
        }),
        makeReadOutputTool({
          read: (id, opts) => terminalBuffer.read(id, opts),
          getSessionOwner,
        }),
        makeKillTool({
          has: (id) => termService.has(id),
          interrupt: (id) => termService.interrupt(id),
          kill: (id) => termService.kill(id),
          forceKill: (id) => termService.forceKill(id),
          getSessionOwner,
        }),
      ],
    });
    setMcpEnvProvider((windowId: number) => {
      if (!mcpHost) return { env: {} as Record<string, string>, mcpToken: '' };
      const token = mcpHost.issueWindowToken(windowId);
      return {
        env: {
          CONTINUO_MCP_URL: mcpHost.url,
          CONTINUO_MCP_TOKEN: token,
          CONTINUO_WINDOW_ID: String(windowId), // internal diagnostic env, exposed to user shell intentionally for debug
          CONTINUO_HOST: 'desktop',
        },
        mcpToken: token,
      };
    });
    // 给 agent-auth service 注入 host 引用,撤销时 rotate token。
    setMcpHostRef(mcpHost);
    setMcpRevokers({
      byWindow: (windowId) => mcpHost!.revokeWindowTokens(windowId),
      byToken: (token) => mcpHost!.revokeToken(token),
    });
     
    console.log(`[mcp-host] listening on ${mcpHost.url}`);
  } catch (err) {
     
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
     
    console.warn('[mcp-stdio] http host not started, skipping stdio');
    return;
  }
  const socketPath = resolveStdioSocketPath();
  try {
    mcpStdio = await createStdioSocketServer({
      socketPath,
      tools: mcpHost.tools,
      serverInfo: mcpHost.serverInfo,
      resolveWindowId: (token) => mcpHost!.resolveWindowId(token),
    });
    const cliPath = resolveStdioCliPath();
    const claudeAddCommand = `claude mcp add --transport stdio continuo -- ${cliPath}`;
     
    console.log(`[mcp-stdio] listening on ${mcpStdio.socketPath}`);
    // 打印推荐的 claude mcp add 命令,用户复制即可一次配置永久使用
     
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
     
    console.warn(
      '[mcp-stdio] failed to start, stdio MCP transport unavailable',
      err,
    );
  }
}

app.whenReady().then(async () => {
  const userData = app.getPath('userData');
  const explorerFile = path.join(userData, 'explorer.json');
  const legacyLayoutFile = path.join(userData, 'layout.json');
  await migrateExplorerFileToV3(explorerFile, legacyLayoutFile);

  // E2E 跑 Playwright 时,Electron 默认菜单的 CmdOrCtrl+P 绑定 Print 会先吞
  // ⌘P,导致 Quick Open 收不到 keydown。e2e 显式禁用菜单(只影响测试模式)。
  if (process.env['CONTINUO_E2E'] === '1') {
    Menu.setApplicationMenu(null);
  } else {
    Menu.setApplicationMenu(buildAppMenu());
    // macOS dock 右键菜单(快捷入口)— Linux/Windows 没 dock 跳过。
    if (process.platform === 'darwin' && app.dock) {
      app.dock.setMenu(
        Menu.buildFromTemplate([
          {
            label: 'New Window',
            click: () => {
              void newWindow();
            },
          },
          {
            label: 'Open Folder in New Window…',
            click: () => {
              void openFolderInNewWindow();
            },
          },
        ]),
      );
    }
  }

  registerIpc();
  // 在 createMainWindow 之前启 host,确保 renderer autoSpawn 的第一个 PTY
  // env 已含 MCP url / token。
  await startMcpHost();
  await startMcpStdioServer();
  // Plugin → MCP bridge 接线(host 已就绪,renderer 通过 IPC 注册的 tool 走它)。
  // tools/list_changed 通知同时推 HTTP SSE + stdio 客户端,Codex/Claude Code 收到自动重拉.
  if (mcpHost) startPluginMcpIpc(mcpHost, mcpStdio ?? undefined);
  // 冷启动开窗模式决策(issue #30):有 dock 缓冲目录 → dock 模式,
  // 第一个目录作主窗 workspace,其余各开新窗,**不**恢复历史;
  // 否则 → restore 模式,主窗用持久化 workspace,异步恢复历史 windows[]。
  const isDir = (p: string): boolean => {
    try {
      return nodeFs.statSync(p).isDirectory();
    } catch {
      return false;
    }
  };
  const startup = pickStartupMode(pendingOpenPaths.splice(0), isDir);

  let win: BrowserWindow;
  if (startup.mode === 'dock') {
    // 第一个 dir 作主窗 workspace,覆盖持久化的 windows[0].workspace.root
    win = createMainWindow({ windowSeq: 0, workspace: startup.dirs[0]! });
    const extras = startup.dirs.slice(1);
    if (extras.length > 0) {
      void (async () => {
        for (const dir of extras) {
          const windowSeq = await allocateWindowSeq(explorerFile);
          createMainWindow({ windowSeq, workspace: dir });
        }
      })();
    }
  } else {
    // 正常启动:主窗 windowSeq=0(workspace 由 renderer 从 explorer.json 段恢复)
    win = createMainWindow({ windowSeq: 0 });
    // Phase 2C(issue #23):上次会话的非主窗(windowSeq>0)逐个恢复
    void (async () => {
      try {
        const data = await loadExplorer(explorerFile);
        if (!data) return;
        for (const entry of pickWindowsToRestore(data, isDir)) {
          createMainWindow({
            windowSeq: entry.windowSeq,
            workspace: entry.workspace,
          });
        }
      } catch (err) {
        console.warn('[window-restore] 启动恢复失败,只开主窗', err);
      }
    })();
  }

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
    if (BrowserWindow.getAllWindows().length === 0) {
      createMainWindow({ windowSeq: 0 });
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', async (event) => {
  const wins = BrowserWindow.getAllWindows().filter((w) => !w.isDestroyed());
  if (wins.every((w) => flushedOnQuit.has(w.id))) {
    void mcpHost?.close().catch(() => {});
    void mcpStdio?.close().catch(() => {});
    return;
  }
  event.preventDefault();
  await Promise.all(
    wins.map(async (w) => {
      if (flushedOnQuit.has(w.id)) return;
      await requestWindowFlush(w);
      flushedOnQuit.add(w.id);
    }),
  );
  void mcpHost?.close().catch(() => {});
  void mcpStdio?.close().catch(() => {});
  app.quit();
});
