import { app, BrowserWindow, shell } from 'electron';
import type { HandlerDetails, WindowOpenHandlerResponse } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { registerIpc } from './ipc';
import { PLUGINS_CHANNELS } from '../shared/plugins-channels';

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
        //   - 给用户一个明确的可拖区域(主窗口 hiddenInset 把 LayoutMotion 文字
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

app.whenReady().then(() => {
  registerIpc();
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
