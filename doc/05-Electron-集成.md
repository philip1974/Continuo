# 05 · Electron 集成

## 范围

只做三件事：

1. **主窗口** + N 个 **popout 窗口**（拖出去的面板）
2. **layout.json** 持久化
3. **白名单 IPC**（layout 读写 + popout 创建）

不做：菜单深定制、自动更新、原生托盘——这些等核心走通后再加。

## main 进程

```ts
// electron/main/index.ts
import { app, BrowserWindow } from 'electron';
import { registerIpc } from './ipc';

function createMainWindow() {
  const win = new BrowserWindow({
    width: 1280, height: 800,
    titleBarStyle: 'hiddenInset',
    backgroundColor: '#020617',
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });
  win.loadURL(MAIN_URL);
  return win;
}

function createPopoutWindow(opts: { panelId: string; bounds?: Electron.Rectangle }) {
  const win = new BrowserWindow({
    width: 800, height: 600,
    ...opts.bounds,
    backgroundColor: '#020617',
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.cjs'),
      contextIsolation: true,
      sandbox: true,
    },
  });
  win.loadURL(`${MAIN_URL}?popout=1&panelId=${encodeURIComponent(opts.panelId)}`);
  return win;
}

app.whenReady().then(() => {
  registerIpc({ createPopoutWindow });
  createMainWindow();
});
```

## preload（白名单）

```ts
// electron/preload/index.ts
import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('api', {
  layout: {
    read: () => ipcRenderer.invoke('layout:read'),
    write: (json: unknown) => ipcRenderer.invoke('layout:write', json),
  },
  popout: {
    open: (panelId: string, bounds?: { x: number; y: number; width: number; height: number }) =>
      ipcRenderer.invoke('popout:open', { panelId, bounds }),
    onClosed: (cb: (panelId: string) => void) => {
      const listener = (_: unknown, panelId: string) => cb(panelId);
      ipcRenderer.on('popout:closed', listener);
      return () => ipcRenderer.off('popout:closed', listener);
    },
  },
});
```

## main 侧 IPC + Schema

```ts
// electron/main/ipc.ts
import { ipcMain, app } from 'electron';
import { z } from 'zod';
import fs from 'node:fs/promises';
import path from 'node:path';

const LayoutSchema = z.object({ version: z.literal(1).optional() }).passthrough();
const PopoutOpenSchema = z.object({
  panelId: z.string().min(1),
  bounds: z.object({
    x: z.number(), y: z.number(), width: z.number(), height: z.number()
  }).optional(),
});

export function registerIpc(deps: { createPopoutWindow: (o: any) => Electron.BrowserWindow }) {
  const layoutPath = path.join(app.getPath('userData'), 'layout.json');

  ipcMain.handle('layout:read', async () => {
    try {
      const raw = await fs.readFile(layoutPath, 'utf-8');
      return LayoutSchema.parse(JSON.parse(raw));
    } catch { return null; }
  });

  ipcMain.handle('layout:write', async (_evt, json) => {
    const safe = LayoutSchema.parse(json);
    await fs.writeFile(layoutPath, JSON.stringify(safe, null, 2));
    return true;
  });

  ipcMain.handle('popout:open', async (_evt, payload) => {
    const opts = PopoutOpenSchema.parse(payload);
    const win = deps.createPopoutWindow(opts);
    win.on('closed', () => {
      // 通知所有 renderer popout 关闭
      BrowserWindow.getAllWindows().forEach(w => w.webContents.send('popout:closed', opts.panelId));
    });
    return { ok: true, windowId: win.id };
  });
}
```

## 把 Dockview 的 popout 桥到 BrowserWindow

Dockview 的 popout 默认是 `window.open` 创建的浏览器子窗口。Electron 下这条路也能跑（默认就是开新 BrowserWindow），但**控制权在 Chromium，不在我们手里**——窗口尺寸、preload、安全策略都是默认值。

更稳的路子：**拦截 Dockview 的"想要 popout"事件**，自己用 `popout:open` IPC 走 `createPopoutWindow`：

```tsx
// src/shell/dock/popout.ts
import type { DockviewApi } from 'dockview-react';

export function bindNativePopout(api: DockviewApi) {
  api.onDidAddGroup(group => {
    // group 自带的 header 已有 "拖到屏幕外 → popout" 行为
    // 我们覆盖它的 popout 触发器：
    group.api.onDidLocationChange(evt => {
      if (evt.location?.type === 'popout') {
        // 1) 阻止默认 window.open 的弹出
        // 2) 通过我们的 IPC 起一个真正的 BrowserWindow
        window.api.popout.open(group.activePanel?.id ?? group.id);
        // 3) 把当前 group 在主窗口里恢复回正常 dock
        api.moveGroup({ from: { group }, to: { /* 上次原位 */ } });
      }
    });
  });
}
```

> 这里有个细节坑：Dockview 自己的 popout group 与我们用 BrowserWindow 重做的 popout 是**两套**。要让它们看起来"一致"，最稳的做法是**完全禁用 Dockview 自带的 popout**（如果可配置），由我们自己监听拖出屏幕外的事件来触发。
> 如果 Dockview 当前版本没暴露禁用开关，就在 v1 阶段保留 Dockview 自带 popout（仅在主屏内可用），把"native popout 到独立 BrowserWindow"放到 v2 实现。

## popout 窗口里加载什么

popout 窗口加载的 URL 里带 `?popout=1&panelId=xxx`。`App.tsx` 里读 query：

```tsx
const params = new URLSearchParams(location.search);
const popoutPanelId = params.get('popout') ? params.get('panelId') : null;

if (popoutPanelId) {
  // 渲染单个面板，不渲染 DockviewReact
  return <PopoutHost panelId={popoutPanelId} />;
}
```

`PopoutHost` 直接从 panel registry 拿 component 渲染，状态通过 IPC 与主窗口同步（v1 先做单向：主窗口推 → popout 拉，关闭即丢弃；v2 再做双向同步）。

## 安全清单

- `contextIsolation: true`，`sandbox: true`，`nodeIntegration: false`。
- preload 只暴露 `window.api.{layout, popout}` 三五个方法。
- 所有 IPC payload 走 `zod` schema 校验，校验失败即拒绝。
- 不允许 renderer 读写任意路径，layout.json 的路径由 main 控制。
