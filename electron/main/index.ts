import { app, BrowserWindow, dialog, ipcMain, Menu, shell } from 'electron';
import type {
  HandlerDetails,
  IpcMainEvent,
  MenuItemConstructorOptions,
  WindowOpenHandlerResponse,
} from 'electron';
import nodeFs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { registerIpc } from './ipc';
import { loadSettings } from './services/settings.service';
import { getMainT, type MainT } from './i18n';
import { setMenuRebuilder } from './ipc/i18n.ipc';
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
  pickArgvFolders,
  isWithinStartupPathLimit,
  MAX_STARTUP_DIRS,
} from './services/cli-args.service';
import { extractProtocolUrl } from './protocol-argv';
import {
  routeProtocolUrl,
  attachWindowDrain,
} from './protocol-dispatch';
import {
  clearWindow,
  getActiveSeqs,
  setWindowSeq,
} from './services/window-seq.service';
import { withExplorerFileMutex } from './lib/file-mutex';
import { atomicWriteJson } from './lib/atomic-write';
import { makeWindowResourceCleanup } from './window-resource-cleanup';
import { makeQuitCleanupGuard } from './quit-cleanup-guard';
import { PLUGINS_CHANNELS } from '../shared/plugins-channels';
import { ERROR_CODES } from '../shared/error-codes';
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
import { makeTerminalMcpTools } from './services/mcp-terminal-host';
import type { CreateSessionPtyInput } from './services/mcp-tools-terminal';
import * as terminalSessions from './services/terminal-sessions.service';
import * as termService from './services/terminal.service';
import { makeCreateHandler, setMcpEnvProvider, setStopHookCanceller } from './ipc/terminal.ipc';
import {
  cancelAgentAuthByWindow,
  requestAgentAuth,
  setMcpHostRef,
} from './services/agent-auth.service';
import { createContinuoMcpEnv } from './services/continuo-terminal-host-adapter';
import { buildClaudeAddCommand, setStdioConfig } from './services/mcp-stdio-config.service';
import {
  createAwaitStopHookTool,
  createHookFileBroker,
  inferRunner,
  installStopHookForSession,
} from './services/mcp-tools-hook-bridge';
import { startPluginMcpIpc } from './ipc/plugin-mcp.ipc';
import {
  defaultIsTrustedFrame,
  isTrustedRendererFileUrl,
  setTrustedRendererFile,
} from './safe-handle';
import {
  buildRendererQuery,
  stripSpikeQuery,
  spikeAllowed,
  installSpikeGate,
  parseDevRendererUrl,
} from './spike-gate';
import { buildCommonWebPreferences } from './continuo-meta-args';
import { isPopoutUrl } from './popout-url';
import { releaseFsWatchersForWindow } from './ipc/fs.ipc';
import { isAllowedExternalUrl } from './services/shell.service';
import { MAX_EXTERNAL_URL_LEN } from './../shared/url-limits';
import { cancelScopeRequestsForWebContents } from './ipc/plugin-fs.ipc';

// 窗口级资源清理器(scope 授权 / fs watcher / agent 授权)。挂在覆盖全窗口的
// browser-window-created(见下),主窗与 dockview popout 子窗一视同仁 —— popout 不走
// createMainWindow,旧实现把三项清理只挂在 createMainWindow 漏了 popout 兄弟入口。
const releaseWindowResources = makeWindowResourceCleanup({
  cancelScopeRequests: cancelScopeRequestsForWebContents,
  releaseFsWatchers: releaseFsWatchersForWindow,
  cancelAgentAuth: cancelAgentAuthByWindow,
});

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

const LRU_MAX_CLOSED = Infinity;
const pendingFlushAcks = new Map<number, () => void>();
const flushedOnQuit = new Set<number>();
// 关窗 flush 的 ack 等待上限。数据安全(codex 复查 P1):renderer 的 flush-ack 在 DockShell
// 依次 await layout/explorer/autosave 落盘后才发;此超时是**防挂死兜底**(renderer 崩溃/死循环
// 永不 ack 时仍能关窗),但旧值 1s 太短 —— 大 markdown autosave / 慢盘的合法 flush 可能 >1s,
// 超时先 fire → 在 renderer 写完前关窗 → 丢最后编辑。放宽到 10s:远超正常 flush(通常 <100ms),
// 给慢盘充足余量;真正挂死的 renderer 也只多等 9s 才关(罕见、可接受)。ack 一到立即 resolve,
// 不等满超时。webContents 已销毁则立即放行(见 requestWindowFlush)。
export const FLUSH_ACK_TIMEOUT_MS = 10_000;
// 退出清理(flush + PTY 强杀)只跑一次。原实现用 `wins.every(flushedOnQuit)` 兼当
// 守卫,但关掉最后一个窗口触发的 window-all-closed→quit 路径里 wins 已空,
// `[].every()` 恒 true → 提前 return 跳过 cleanupAll(),Linux/Windows 上长任务 PTY
// 孤儿化(window 'closed' 清理走 3s grace timer,进程退出不触发 SIGKILL)。改用独立
// 守卫:无论哪条 quit 路径,cleanupAll() 都在 app.quit() 前 await 一次。见第十三轮 P1-AI。
// 守卫区分 started/finished:清理在途时用户再次 quit 必须继续拦截,不能放行绕过 cleanupAll
// (codex 复审 F1,见 quit-cleanup-guard.ts)。
const quitGuard = makeQuitCleanupGuard();

ipcMain.on('window:id', (event: IpcMainEvent) => {
  // 与 layout:flush-ack / plugin-mcp INVOKE_REPLY 对齐:不受信 frame
  // (被注入的子 frame)拿不到窗口 id。合法 renderer 与 popout 子窗都走
  // file:// / 同源 dev URL → 受信。
  if (!defaultIsTrustedFrame(event.senderFrame)) {
    event.returnValue = 0;
    return;
  }
  const win = BrowserWindow.fromWebContents(event.sender);
  event.returnValue = win?.id ?? 0;
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
    // webContents 已销毁 → renderer 无法 flush/ack,立即放行(不空等满超时)。
    if (win.webContents.isDestroyed()) {
      done();
      return;
    }
    timer = setTimeout(done, FLUSH_ACK_TIMEOUT_MS);
    try {
      win.webContents.send('layout:flush-request', { windowId: win.id });
    } catch {
      done();
    }
  });
}

function wireWindowCloseFlush(win: BrowserWindow): void {
  let flushed = flushedOnQuit.has(win.id);
  // race(R45):flush 在途守卫。requestWindowFlush 是异步(等 renderer ack / 10s 超时),其间
  // `flushed` 仍为 false;若不挡住,快速重复关窗 / 系统关窗 / app.quit 触发的第二个 close 会再次
  // requestWindowFlush,用同 win.id 覆盖 pendingFlushAcks → renderer 的 ack 只 resolve 最新请求,
  // 旧 promise 干等满超时才放行,且 flush 完成后可能重复 win.close()。
  let flushing = false;
  win.on('close', (event) => {
    // flushedOnQuit 也要查:`before-quit` 路径可能已经 flush 过本窗并写入
    // flushedOnQuit,但本闭包的局部 `flushed` 不会被它更新 —— 只看局部量会让
    // app.quit() 触发 close 时对同一窗口重复 flush(多一次 IPC 往返 + preventDefault
    // 二次阻塞退出)。
    if (flushed || flushedOnQuit.has(win.id)) return;
    event.preventDefault();
    // race(R45):已有 flush 在途 → 只阻止本次关闭,不再发第二个 flush(避免覆盖 pending ack)。
    if (flushing) return;
    flushing = true;
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
  // 边界(E190,E179/E152 同族外链长度):window.open url 的类型/长度前置闸,先于 new URL 解析与
  // shell.openExternal。否则超长 url 让主进程先做大字符串 URL 解析,并可能把巨大 URL 交给系统协议
  // 处理器(绕过 shell.openExternal IPC 的 2048 上限与 Markdown 外链上限)。对齐共享 MAX_EXTERNAL_URL_LEN。
  if (
    typeof url !== 'string' ||
    url.length === 0 ||
    url.length > MAX_EXTERNAL_URL_LEN
  ) {
    return { action: 'deny' };
  }
  let allow = false;
  try {
    const target = new URL(url);
    // 安全 S1:dev 走 renderer origin;prod 只允许指向真实 renderer 入口 index.html
    // 的 file URL(精确 pathname),不再放行任意 file://(否则恶意 file:// 弹窗会被注入
    // 全量 preload → 越权 IPC)。
    if (isDev) {
      // 边界(E304,E302/E303 同族 dev URL 解析第三入口 / family sweep):此前 new URL(env) 无长度上限
      //(在 try/catch 内故不崩,但 windowOpenHandler 每次弹窗都解析一次无界 OS env)。复用 parseDevRendererUrl
      //(限长 MAX_RENDERER_URL_LEN + total),与 createMainWindow(E299)/safe-handle(E303)单一来源同源。
      const rendererUrl = parseDevRendererUrl(process.env['ELECTRON_RENDERER_URL']);
      allow = rendererUrl !== null && target.origin === rendererUrl.origin;
    } else {
      allow = isTrustedRendererFileUrl(url);
    }
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
        webPreferences: buildCommonWebPreferences({
          preload: PRELOAD,
          isPackaged: app.isPackaged,
        }),
      },
    };
  }
  // deny 分支会把任意 URL 交给系统打开 —— `target="_blank"` 锚点点击都走这里
  // (含 marketplace 不受信的 authorUrl / 评论 url)。必须复用 shell.service 的
  // scheme 白名单,否则 `smb://`、自定义协议等非 http(s) URL 会绕过白名单经 OS
  // 协议处理器打开,成为投放面。非白名单 scheme 直接静默 deny。
  if (isAllowedExternalUrl(url)) {
    shell.openExternal(url);
  }
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
  /**
   * Issue #45:`true` ⇒ this window opens the user-supplied workspace fresh
   * (dock open-file, CLI argv, open-folder-in-new-window IPC). Renderer
   * discards persisted per-window UI / editor for this windowSeq and uses
   * `opts.workspace` as the root. `false` / omitted ⇒ restore from
   * explorer.json segment (workspace query, if any, is fallback only).
   * Forgetting to set this for a true "open new folder" callsite means
   * the user gets the old workspace restored instead — verify against the
   * BDD scenarios at src/__tests__/cold-start-drag-folder/.
   */
  readonly fresh?: boolean;
}

// race(R40/R41):co:// 深链 FIFO 缓冲队列。无就绪窗口期间到达的深链全部入队;每个新窗口
// (createMainWindow)did-finish-load 后都尝试排空,确保「应用无窗口时收到的深链」由下一个创建的
// 窗口消费,而非只挂在 bootstrap 窗口上(声明在 createMainWindow 之前,供其闭包引用)。
const pendingProtocolUrls: string[] = [];

export function createMainWindow(opts: CreateMainWindowOpts) {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    // `hiddenInset` 是 macOS 专属语义(隐藏标题栏但保留内嵌红绿灯按钮);Windows/Linux
    // 上它是未定义行为,可能导致 chrome 显示异常 → 非 darwin 用 'default' 原生标题栏。
    // (Windows/Linux 的自定义 chrome + 窗口控件 overlay 精修留作 follow-up。跨平台审计 P2)
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    backgroundColor: '#020617',
    webPreferences: buildCommonWebPreferences({
      preload: PRELOAD,
      isPackaged: app.isPackaged,
    }),
  });

  const seq = opts.windowSeq;
  setWindowSeq(win.id, seq);
  wireWindowCloseFlush(win);

  win.on('closed', () => {
    clearWindow(win.id);
    // 窗口级资源清理(scope / fs watcher / agent 授权)已移到覆盖全窗口的
    // browser-window-created → releaseWindowResources,主窗与 popout 统一处理。
    // 此处只保留主窗专属的 explorer.json 段落持久化(popout 无 windowSeq 段)。
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
  // [topic 45 spike gate 二道防线]: buildRendererQuery 收集所有 query input;
  // stripSpikeQuery 在 spikeAllowed 拒绝时剥离 spike key (future-proof, P1.3)。
  const baseQuery = buildRendererQuery({
    windowSeq: String(seq),
    workspace: opts.workspace,
    fresh: opts.fresh,
    // opts.spike 当前 callsite 未注入,但 buildRendererQuery 支持 forward;
    // future-proof, 防 packaged spike key 直接绕过第一道 will-navigate gate
  });

  const targetUrl =
    isDev && process.env['ELECTRON_RENDERER_URL']
      ? process.env['ELECTRON_RENDERER_URL']
      : `file://${RENDERER_FILE}`;
  const gateResult = spikeAllowed({
    url: targetUrl,
    argv: process.argv,
    packaged: app.isPackaged,
  });
  const queryParts = stripSpikeQuery(baseQuery, gateResult.allowed);

  // 边界(E299):dev env URL 解析失败(缺失/畸形,开发误配)→ parseDevRendererUrl 返 null,回退 loadFile,
  // 不让 new URL 同步抛崩溃 createMainWindow(应用启动无窗口)。
  const devUrl = isDev ? parseDevRendererUrl(process.env['ELECTRON_RENDERER_URL']) : null;
  if (devUrl) {
    for (const [k, v] of Object.entries(queryParts)) {
      devUrl.searchParams.set(k, v);
    }
    win.loadURL(devUrl.toString());
  } else {
    win.loadFile(RENDERER_FILE, { query: queryParts });
  }

  // race(R41):每个新窗口就绪后都尝试排空协议队列 —— 无就绪窗口期入队的 co:// 由「下一个就绪的
  // 任意窗口」消费。此前 drain 只挂在 bootstrap 窗口上,后续 newWindow / openPathInNewWindow /
  // macOS activate 创建的窗口不 drain → 应用无窗口时收到的深链永久挂队列。见 attachWindowDrain。
  attachWindowDrain(win, PLUGINS_CHANNELS.PROTOCOL_URL, pendingProtocolUrls);

  return win;
}

// 给所有新创建的 webContents(包括 dockview popout 的子窗口)装上 windowOpenHandler。
// 这样从 popout 再 popout 也走我们的同一套安全策略。
app.on('web-contents-created', (_evt, contents) => {
  contents.setWindowOpenHandler(windowOpenHandler);
  installSpikeGate(contents, app.isPackaged); // [topic 45 spike gate 第一道] will-navigate + will-frame-navigate
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
  createMainWindow({ windowSeq, workspace: folder, fresh: true });
}

async function newWindow(): Promise<void> {
  const explorerFile = path.join(app.getPath('userData'), 'explorer.json');
  const windowSeq = await allocateWindowSeq(explorerFile);
  createMainWindow({ windowSeq });
}

function buildAppMenu(t: MainT): Menu {
  const isMac = process.platform === 'darwin';
  const fileSubmenu: MenuItemConstructorOptions[] = [
    {
      label: t('menu.file.new_window'),
      accelerator: 'CmdOrCtrl+Shift+N',
      click: () => {
        void newWindow();
      },
    },
    {
      label: t('menu.file.open_folder_in_new_window'),
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
    { label: t('menu.file.label'), submenu: fileSubmenu },
    { role: 'editMenu' },
    { role: 'viewMenu' },
    { role: 'windowMenu' },
  ];

  return Menu.buildFromTemplate(template);
}

/** macOS dock 右键菜单(locale 依赖)。启动 + setLocale 后都要(重)建,否则切语言
 * 后 dock 菜单标签永久停留旧语言。Linux/Windows 无 dock 跳过。 */
function setDockMenu(): void {
  if (process.platform !== 'darwin' || !app.dock) return;
  const t = getMainT();
  app.dock.setMenu(
    Menu.buildFromTemplate([
      {
        label: t('menu.file.new_window'),
        click: () => {
          void newWindow();
        },
      },
      {
        label: t('menu.file.open_folder_in_new_window'),
        click: () => {
          void openFolderInNewWindow();
        },
      },
    ]),
  );
}

/** 由 i18n.ipc setMenuRebuilder 注册；setLocale 后被调，整体重建 application menu + dock menu。 */
export function rebuildAppMenu(): void {
  if (process.env['CONTINUO_E2E'] === '1') return;
  Menu.setApplicationMenu(buildAppMenu(getMainT()));
  setDockMenu();
}

// popout 子窗口禁止刷新。
// 原因:dockview 用 portal 把 panel 注到子窗 body,reload 清空 portal 目标
// 但 main 端 dockview state 还在 → 子窗黑屏。
// did-start-navigation 是 "did" 事件不能 preventDefault,改成在键盘事件层吞掉
// Cmd+R / Ctrl+R / F5,并去掉 popout 的菜单(避免菜单里的 Reload)。
app.on('browser-window-created', (_evt, win) => {
  // 窗口级资源清理:主窗 / 新窗 / dockview popout 子窗一视同仁(popout 不走
  // createMainWindow,镜像 terminal.ipc 的 windowClosedCleanup 覆盖全窗口挂法)。
  // webContents id ≠ BrowserWindow id 且 'closed' 后 webContents 已销毁不可读 →
  // 在创建期(此刻 webContents 存活)先捕获 wcId。
  const wcId = win.webContents.id;
  win.once('closed', () => releaseWindowResources(win.id, wcId));

  win.webContents.once('did-finish-load', () => {
    if (!isPopoutUrl(win.webContents.getURL())) return;
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

function dispatchProtocolUrl(url: string): void {
  // race(R39):只投给已就绪(renderer did-finish-load 完成、preload onProtocolUrl 已挂)的窗口;
  // 无就绪窗口时入队 + 给 loading 窗口挂一次性 did-finish-load drain(冷启动「无窗口」仍入队,
  // 由 createMainWindow 的 drain 兜底)。见 routeProtocolUrl。
  routeProtocolUrl(url, {
    windows: BrowserWindow.getAllWindows(),
    channel: PLUGINS_CHANNELS.PROTOCOL_URL,
    pending: pendingProtocolUrls,
  });
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
    // co:// 深链(大小写无关,见 extractProtocolUrl)
    const url = extractProtocolUrl(argv, PROTOCOL);
    if (url) dispatchProtocolUrl(url);
    // Windows/Linux:运行中通过 OS/CLI 传入的目录 argv(如 "用 Continuo 打开文件夹")
    // 此前被忽略 → 在已有实例里按目录打开新窗口(跨平台审计 P2)。
    const folders = pickArgvFolders(
      argv,
      (p) => {
        try {
          return nodeFs.statSync(p).isDirectory();
        } catch {
          return false;
        }
      },
      { skipFirstArg: !!process.defaultApp, skipAll: false },
    );
    for (const folder of folders) void openPathInNewWindow(folder);
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
// Issue #45:CLI / dock 拖入(Windows/Linux 走 argv) 路径与 macOS open-file 共用同一
// 缓冲池;skipFirstArg 在 dev (electron .) 跳掉 argv[1] 的 cwd,skipAll 在 E2E 模式
// 完全禁用,避免 Playwright launcher 的 argv 误触发 dock mode。
pendingOpenPaths.push(
  ...pickArgvFolders(
    process.argv,
    (p) => {
      try {
        return nodeFs.statSync(p).isDirectory();
      } catch {
        return false;
      }
    },
    {
      skipFirstArg: !!process.defaultApp,
      skipAll: process.env['CONTINUO_E2E'] === '1',
    },
  ),
);

// 边界(E59,E58 运行期 sibling):macOS open-file 在 app ready 后直接走本入口,绕过冷启动
// pendingOpenPaths/pickStartupMode 的数量/长度上限。畸形/自动化 open-file 事件可在运行中连续送入
// 大量目录或超长路径 → 对每个先同步 statSync + 批量 allocateWindowSeq/createMainWindow,主进程
// 同步 I/O 卡顿 + 批量开窗。复用启动路径长度守卫(超长不 statSync)+ 运行期并发开窗上限。
let openInFlight = 0;
async function openPathInNewWindow(absPath: string): Promise<void> {
  // 超长/非法路径先跳过,绝不对其 statSync。
  if (!isWithinStartupPathLimit(absPath)) {
    console.warn('[open-file] dropping invalid/oversize path');
    return;
  }
  // 运行期并发开窗上限:挡 open-file 事件洪水批量开窗(冷启动有 pickStartupMode 上限,运行期靠此)。
  if (openInFlight >= MAX_STARTUP_DIRS) {
    console.warn(
      `[open-file] too many concurrent opens (>= ${MAX_STARTUP_DIRS}), dropping`,
    );
    return;
  }
  openInFlight += 1;
  try {
    let isDir = false;
    try {
      isDir = nodeFs.statSync(absPath).isDirectory();
    } catch {
      /* 路径不存在 / 无权限 → 跳过 */
    }
    if (!isDir) return;
    const explorerFile = path.join(app.getPath('userData'), 'explorer.json');
    const windowSeq = await allocateWindowSeq(explorerFile);
    createMainWindow({ windowSeq, workspace: absPath, fresh: true });
  } finally {
    openInFlight -= 1;
  }
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
      code: ERROR_CODES.TERMINAL_NO_WINDOW,
    });
  }
  // 安全 S3:把新会话归属到发起 create 的 MCP 调用方(ctx.callerSubject)。后续
  // read/send/kill 仅该调用方(同一 token / 同一 stdio 连接)可操作该会话。
  const r = await ptyCreateHandler(
    input,
    win,
    typeof ctx.callerSubject === 'string'
      ? { controllerToken: ctx.callerSubject }
      : undefined,
  );
  // P3 autorun:spawn 后 delay 200ms(Win 600)等 shell prompt 出现,然后键入命令。
  // 不严格保证 prompt 已就绪 — 平台差异大,简单 timer 是最务实的近似。
  if (input.autorun) {
    const cmd = input.autorun;
    setTimeout(() => {
      if (termService.has(r.id)) {
        // autorun 是尽力而为(prompt 就绪近似),写入结果无 UI 反馈通道 → fire-and-forget。
        // write 现返 Promise(R4),内部已 catch 不 reject,void 显式忽略避免 floating-promise。
        void termService.write(r.id, `${cmd}\n`);
      }
    }, AUTORUN_DELAY_MS);
  }
  return r;
}

async function startMcpHost(): Promise<void> {
  let brokerStarted = false;
  const hookEventsDir = path.join(app.getPath('userData'), 'hook-events');
  const broker = createHookFileBroker(hookEventsDir);
  try {
    await nodeFs.promises.mkdir(hookEventsDir, { recursive: true });
    try {
      await broker.start();
      brokerStarted = true;
      // 窗口关闭时取消该窗口仍在 block 的 await_stop_hook 等待者(审计 #3)。
      setStopHookCanceller((windowId) => {
        try {
          broker.cancelByWindow(windowId);
        } catch {
          // ignore — 关闭路径尽力而为
        }
      });
    } catch (err) {
      console.warn(
        '[hook-bridge] broker.start failed, await_stop_hook will be unavailable:',
        err,
      );
    }
    const installStopHook = async (
      cwd: string | undefined,
      agentLabel: string,
    ) => {
      const resolvedCwd = cwd ?? '';
      const runner = inferRunner({ id: '', cwd: resolvedCwd, agentLabel });
      return installStopHookForSession(resolvedCwd, runner, hookEventsDir);
    };
    const initialTools = [
      ...makeTerminalMcpTools({
        sessionStore: terminalSessions,
        service: termService,
        getSessionOwner,
        getSessionController: (id) => terminalSessions.getController(id),
        ensureAuthorized: (ownerWindowId?: number, method?: string) =>
          requestAgentAuth({
            method: method ?? 'terminal.create_session',
            ...(ownerWindowId !== undefined ? { ownerWindowId } : {}),
          }),
        createSession: createSessionForAgent,
        installStopHook,
      }),
    ];
    if (brokerStarted) {
      initialTools.push(
        createAwaitStopHookTool({
          broker,
          getSessionMeta: (sessionId, ctx) => {
            const session = terminalSessions.get(sessionId);
            if (!session || session.ownerWindowId !== ctx.ownerWindowId) {
              return null;
            }
            return session;
          },
        }),
      );
    }
    mcpHost = await createMcpHost({
      initialTools,
    });
    setMcpEnvProvider((windowId: number) => {
      if (!mcpHost) return { env: {} as Record<string, string>, mcpToken: '' };
      return createContinuoMcpEnv({
        windowId,
        url: mcpHost.url,
        issueToken: (id) => mcpHost!.issueWindowToken(id),
      });
    });
    // 给 agent-auth service 注入 host 引用,撤销时 rotate token。
    setMcpHostRef(mcpHost);
    setMcpRevokers({
      byWindow: (windowId) => mcpHost!.revokeWindowTokens(windowId),
      byToken: (token) => mcpHost!.revokeToken(token),
    });
    app.once('before-quit', async () => {
      if (!brokerStarted) return;
      try {
        await broker.stop();
      } catch {
        // ignore shutdown races
      }
    });
	 
    console.log(`[mcp-host] listening on ${mcpHost.url}`);
  } catch (err) {
    if (brokerStarted) {
      try {
        await broker.stop();
      } catch {
        // ignore cleanup races
      }
    }
	 
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
    const claudeAddCommand = buildClaudeAddCommand(cliPath);
     
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
  // 安全 S1:在建任何窗口 / IPC 之前注册真实 renderer 入口,让 defaultIsTrustedFrame
  // 与 windowOpenHandler 只信这个 file URL,拒绝任意 file:// 弹窗/frame 受信。放在
  // whenReady(而非模块顶层)以免被仅 import index 的单测污染全局注册态。
  setTrustedRendererFile(RENDERER_FILE);

  const userData = app.getPath('userData');
  const explorerFile = path.join(userData, 'explorer.json');
  const legacyLayoutFile = path.join(userData, 'layout.json');
  await migrateExplorerFileToV3(explorerFile, legacyLayoutFile);

  // topic 16 i18n: 必须先 hydrate settings.json，buildAppMenu 才能拿到正确 locale 的 label
  await loadSettings();

  // E2E 跑 Playwright 时,Electron 默认菜单的 CmdOrCtrl+P 绑定 Print 会先吞
  // ⌘P,导致 Quick Open 收不到 keydown。e2e 显式禁用菜单(只影响测试模式)。
  if (process.env['CONTINUO_E2E'] === '1') {
    Menu.setApplicationMenu(null);
  } else {
    Menu.setApplicationMenu(buildAppMenu(getMainT()));
    // macOS dock 右键菜单(快捷入口)。抽成 setDockMenu 复用,locale 切换时一并重建。
    setDockMenu();
  }

  registerIpc();
  // topic 16: 把 rebuildAppMenu 注入 i18n.ipc，setLocale 时菜单整体重建
  setMenuRebuilder(rebuildAppMenu);
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

  // 主窗由 createMainWindow 创建(有副作用:开窗 + 挂 attachWindowDrain);冷启动协议 URL 经
  // dispatchProtocolUrl 走统一队列消费(R69),不再需要持有主窗引用直发。
  if (startup.mode === 'dock') {
    // 第一个 dir 作主窗 workspace,覆盖持久化的 windows[0].workspace.root
    createMainWindow({
      windowSeq: 0,
      workspace: startup.dirs[0]!,
      fresh: true,
    });
    const extras = startup.dirs.slice(1);
    if (extras.length > 0) {
      void (async () => {
        for (const dir of extras) {
          const windowSeq = await allocateWindowSeq(explorerFile);
          createMainWindow({ windowSeq, workspace: dir, fresh: true });
        }
      })();
    }
  } else {
    // 正常启动:主窗 windowSeq=0(workspace 由 renderer 从 explorer.json 段恢复)
    createMainWindow({ windowSeq: 0 });
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

  // 冷启 + open-url 顺序处理:可能在 mainwindow 未就绪前已收 url。race(R41):协议队列 drain 已
  // 统一移入 createMainWindow(每个新窗口 did-finish-load 都排空),bootstrap 窗口同样经
  // createMainWindow 创建,故此处不再单独挂 drain(避免只覆盖 bootstrap 窗口)。

  if (!process.defaultApp) {
    const url = extractProtocolUrl(process.argv, PROTOCOL);
    // race(R69):此前在 did-finish-load 回调里直发 win.webContents.send,绕过统一 routeProtocolUrl
    // 的 FIFO 队列 + R63 的「send 成功才出队 / 失败保留队首」韧性逻辑。两个漏洞:(1)主窗在 load
    // 前关闭 → did-finish-load 永不触发 → 冷启动深链永久丢失;(2)load 后、send 前窗口销毁 → send
    // 抛 "Object has been destroyed" → 深链丢失 + 在事件回调里成未捕获异常。改为交统一协议路由:
    // win 经 createMainWindow 已挂 attachWindowDrain(line ~353),dispatchProtocolUrl 入
    // pendingProtocolUrls 后由该 drain 在就绪时韧性消费(send 失败保留队首,留给下个窗口)。
    if (url) dispatchProtocolUrl(url);
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
  const action = quitGuard.onBeforeQuit();
  // 清理已完成 → 内部 app.quit() 的重入,放行退出。
  if (action === 'allow') return;
  // 清理在途、用户/外部再次 quit → 继续拦截,等在途 cleanupAll 跑完由内部 quit 放行。
  if (action === 'block') {
    event.preventDefault();
    return;
  }
  // action === 'run':首次 quit,跑清理。
  event.preventDefault();
  const wins = BrowserWindow.getAllWindows().filter((w) => !w.isDestroyed());
  await Promise.all(
    wins.map(async (w) => {
      if (flushedOnQuit.has(w.id)) return;
      await requestWindowFlush(w);
      flushedOnQuit.add(w.id);
    }),
  );
  // force-kill 所有 PTY,防 agent 长任务子进程被孤儿化/zombie。无论是否有窗口要 flush
  // 都必须跑(关最后一个窗口触发的 quit 路径 wins 已空,旧 every() 守卫会跳过它)。
  // 在 app.quit() 前 await:window 'closed' 清理走 3s grace timer,进程退出不触发 SIGKILL。
  await termService.cleanupAll().catch(() => {});
  // race(R83):此前 mcpHost/mcpStdio close 是 void fire-and-forget,随后立即 markFinished() +
  // app.quit() → 进程可能在 HTTP/SSE server 关闭、unix socket server close + mcp.sock unlink
  // 完成前退出:SSE/keepalive/socket 清理与退出竞态,mcp.sock 残留到下次启动兜底清理,退出/测试
  // 路径也无法可靠等待资源释放。纳入与 cleanupAll 同一段 awaited 清理,等齐再退出。allSettled:
  // 单个 close 失败/reject 不阻断另一个,也不阻断退出。
  await Promise.allSettled([mcpHost?.close(), mcpStdio?.close()]);
  quitGuard.markFinished();
  app.quit();
});
