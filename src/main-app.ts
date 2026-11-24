import './lib/zod-jitless';
import React from 'react';
import * as ReactNS from 'react';
import { createRoot } from 'react-dom/client';
import { pluginZod } from './plugins/plugin-zod';
import { App } from './shell/App';
import { initExplorerPersistence } from './lib/persist/explorer-persist';
import {
  parseInitialFresh,
  parseInitialWindowSeq,
  parseInitialWorkspace,
} from './lib/initial-workspace';
import { bootCorePlugins } from './core-plugins';
import { coApp } from './plugins/co-app';
import { startPluginMcpInvokeBridge } from './plugins/plugin-mcp-invoke-bridge';
import { Plugin } from './plugins/Plugin';
import { PluginManager, setUserPluginManager } from './plugins/PluginManager';
import { wirePluginEvents } from './plugins/plugin-events';
import { initPluginsThenCheckUpdates } from './marketplace/startup-update-check';
import { wireProtocolUrl } from './plugins/protocol/wire-protocol-url';
import { createWindowApiHost } from './lib/plugins-host';
import { IpcPermissionStore } from './plugins/permissions/IpcPermissionStore';
import { setUserPermissionStore } from './plugins/permissions/co-permission-store';
import { usePermissionPromptStore } from './plugins/permissions/promptStore';
import { startPluginFsScopeRequestBridge } from './plugins/permissions/usePluginFsScopeRequests';
import { PermissionError } from './plugins/permissions';
import type { ContinuoTestHooks } from './continuo-test-hooks';
import { sandboxSweep } from './plugins/sandbox-sweep';
import { captureLmApi, coApi } from './lib/co-api';
import { isPopoutWindow } from './lib/popout-mode';
import { prefetchDockLayout } from './shell/dock/layout-prefetch';
import { useUpdateStore } from './marketplace/update-store';
import { useKeybindingsStore } from './plugins/keybindings/keybindings-store';
import {
  getStoredSettingValue,
  useSettingsValuesStore,
} from './plugins/settings/values-store';
import { openOrFocusPanel, focusPanel } from './shell/dock/dock-api-ref';
import { useEditorStore } from './stores/editor.store';
import { useTerminalStore } from './stores/terminal.store';
import { startDebugStoreSync } from './stores/debug.store';
import {
  preloadTerminalPanelChunk,
  watchTerminalIntent,
} from './lib/terminal-chunk-warmup';
import { setLocale as setI18nModuleLocale } from '@/i18n';
import {
  subscribeToI18nBroadcast,
  useSettingsStore,
} from '@/stores/settings.store';
import './styles/tailwind.css';

// E2E hook:Playwright 通过 page.evaluate 调 dock 操作 / store 重置。
// 仅当 preload 探测到 `__continuoE2E` 标志时挂载;非测试环境完全无效.
// preload 通过 process.env.CONTINUO_E2E 转发(主进程在 e2e 时设这个变量).
declare const window: Window & {
  __continuoE2E?: boolean;
  __continuoTest?: ContinuoTestHooks;
};

function renderApp(container: HTMLElement): void {
  createRoot(container).render(
    React.createElement(React.StrictMode, null, React.createElement(App)),
  );
}

// topic 16: 把后续 boot 流程包 async init，等 locale 真值后再 bootCorePlugins/createRoot
export async function init(): Promise<void> {
  // Phase 4.B:**最早**调,把 window.api 缓存到 module-local。
  // 之后 sandboxSweep 删掉 window.api 也不影响 LM UI(走 coApi)。
  captureLmApi();

  // M-Plugin v4.1 SDK 暴露:user-installed plugin 通过 globalThis.co 拿到
  // Plugin 基类 + React(用 Blob URL import 时无法走 ESM bare import)。
  // v5 Phase 3 增 PermissionError,plugin 可 instanceof 区分权限错误与其它。
  // v5 Phase 4 增 z(zod),让 plugin 写 MCP tool 的 inputSchema 时不需 bare import.
  // 后续若改 Vite plugin 注入 'lm' 模块,本块可移除。
  (globalThis as unknown as {
    co: {
      Plugin: typeof Plugin;
      React: typeof ReactNS;
      PermissionError: typeof PermissionError;
      z: typeof pluginZod;
    };
  }).co = {
    Plugin,
    React: ReactNS,
    PermissionError,
    z: pluginZod,
  };

  const container = document.getElementById('root');
  if (!container) throw new Error('#root not found');

  // 性能(冷启动关键路径):两个只读启动 IPC 不再串在 await getLocale 之后,在此并发发起。
  // - layout.read(main 端读+解析+Zod explorer.json)预取,DockShell 首次 onReady 消费(见 layout-prefetch)。
  // - explorer.read 先发起,下方 initExplorerPersistence 的 read() 取用这同一个 promise(只取一次)。
  //   只是提前发 IPC:hydrate 逻辑与 root 选择守卫仍在 initExplorerPersistence 原位置执行。
  // getLocale 仍在 bootCorePlugins / createRoot 之前 await —— i18n 首次渲染前就绪的契约不变。
  // popout 子窗口两者都不发(见下方 popout 早退)。
  const popout = isPopoutWindow();
  let explorerReadPrefetch: ReturnType<typeof coApi.explorer.read> | null = null;
  if (!popout) {
    prefetchDockLayout();
    try {
      // Promise.resolve:非 promise 返回值(桩 / 异常桥)与原先 `await api.read()` 同样交给 initExplorerPersistence 处理。
      explorerReadPrefetch = Promise.resolve(coApi.explorer.read());
    } catch (err) {
      // 同步抛错与原先在 initExplorerPersistence 的 try 内调用 read() 等价:转成 rejected promise 交给它处理。
      explorerReadPrefetch = Promise.reject(err);
    }
    // 被 initExplorerPersistence 取用前 reject 不应成为 unhandled rejection(取用方 await 仍拿到 reject)。
    explorerReadPrefetch.catch(() => {});
  }

  try {
    const initial = await coApi.i18n.getLocale();
    if (initial.ok) {
      const initialLocale = initial.data;
      useSettingsStore.setState({ locale: initialLocale, currentGen: 0 });
      setI18nModuleLocale(initialLocale);
    }
  } catch (err) {
    console.warn('[i18n] bootstrap getLocale failed', err);
  }

  subscribeToI18nBroadcast();

  // perf:dockview popout 子窗口是独立 BrowserWindow(独立 JS 上下文,同一 renderer 入口 ?popout=1),App 只渲染
  // PopoutHost;弹出的面板由父窗口 React 经 portal 渲染,用的是父窗口的 store / 插件实例。子窗口自己跑完整 init
  // 只有代价与隐患:按同一 windowSeq(popout URL 沿用主窗 query)hydrate explorer 段并全量 readFile 恢复 tab、
  // 注册写回订阅;再 import + onload 一遍全部已启用插件,其 MCP 工具按 webContents 注册进 main(可能抢走路由);
  // 协议深链广播到所有就绪窗口(子窗口会重复执行命令)。main 侧无一依赖 popout 注册这些:debug 事件按
  // ownerWindowId 只发主窗,MCP / 协议路由在 popout 不注册时自然落到主窗。故只保留渲染所需(i18n + App)与 PROD 下的 sandboxSweep。
  if (popout) {
    // 安全:弹出的插件面板 portal 进本窗口 DOM,插件可经 el.ownerDocument.defaultView 取本窗口的原生 fetch /
    // navigator.clipboard 绕过权限门 → 与主窗口同口径清洗(PROD)。
    if (import.meta.env.PROD) sandboxSweep();
    renderApp(container);
    return;
  }

  // M-Plugin v1.7:渲染前同步注册内置插件,
  // 使 coApp.panels 在 DockShell 首次 mount 时已含全部内置 panel 类型。
  bootCorePlugins();

  // v5 Phase 4:Plugin → MCP bridge 反向调用路由。preload.pluginMcp.onInvoke
  // 收 main 推过来的 INVOKE → 调 registry.invokeLocal → preload.replyInvoke 答 main。
  // fire-and-forget,卸载在窗口关闭时由 GC 处理(订阅 unsub 会泄漏一个 listener,
  // 单 renderer 生命周期级,可接受)。
  startPluginMcpInvokeBridge(coApp.mcp);
  startPluginFsScopeRequestBridge();

  // Debug 视图事件同步(断点红点 / 停靠行 / Debug 面板的数据源)必须随 renderer 启动,不能等懒加载的
  // DebugPanel 挂载:默认布局没有 Debug 面板,agent 命中断点时事件无人接收,事后打开面板也恢复不了
  //(main 只推增量事件)。main 按 ownerWindowId 只发给本窗口;模块级幂等,不受 StrictMode 双挂载影响。
  startDebugStoreSync();

  // M-Plugin v5 Phase 4:plugin import 之前清掉 globalThis.fetch +
  // navigator.clipboard,plugin 直接调 raw API 抛 TypeError。
  // scoped-app 走 cached refs 不受影响,LM UI 不直接用这些 API。
  // dev 模式保留(Vite HMR 可能依赖 raw fetch),PROD 才严格执行。
  if (import.meta.env.PROD) {
    sandboxSweep();
  }

  // M-Plugin v4.1+v4.2:用户插件 PluginManager + 权限决策持久化。
  // permissionStore 走 IPC 持久化到 userData/plugins/_permissions.json。
  // promptFn 桥到 design Modal(用户首次启用插件时弹授权)。
  const userPermissionStore = new IpcPermissionStore();
  setUserPermissionStore(userPermissionStore);
  const userPluginManager = new PluginManager(coApp, {
    ...createWindowApiHost(),
    permissionStore: userPermissionStore,
    promptFn: (pid, perms) =>
      usePermissionPromptStore.getState().request(pid, perms),
    // 终审 P1:插件被别的窗口卸载 → 取消其待决授权弹窗(不写决策)。
    cancelPermissionPrompt: (pid, reason) =>
      usePermissionPromptStore.getState().cancel(pid, reason),
  });
  setUserPluginManager(userPluginManager);
  // 终审 P1:任一窗口(含本窗口)变更插件授权成功 → main 广播,本窗口失效授权缓存(下次读重新加载),
  // 再重查该插件 mcp-tools 授权:已撤销 → 注销其 MCP 工具(调用期逐次重查是兜底)。
  coApi.plugins.onPermissionsChanged((id) => {
    userPermissionStore.invalidate();
    void userPluginManager
      .handlePermissionsChanged(id)
      .catch((err) => console.warn('[main] plugin permissions-changed recheck failed', err));
  });

  // Marketplace Phase 3:启动时静默拉一次更新清单(IconSidebar 角标用),排在插件扫描完成之后 —— refresh 按
  // listAll() 裁剪,扫描前为空会直接落空;不等激活(可能挂在授权弹窗上)。popout 已在上方早退,此处恒为主窗。
  // fire-and-forget,不阻塞 UI 渲染;失败 console.warn 不抛。
  void initPluginsThenCheckUpdates(userPluginManager, () => useUpdateStore.getState().refresh()).catch(
    (err) => console.warn('[main] user plugin manager init failed', err),
  );
  // M-Plugin v4.3.1 mtime watch → 热重载;终审 P1 跨窗口卸载 / 启停广播 → 本窗口同步(幂等、不触盘)。
  // race(R16):启动门控在 PluginManager 内 —— 扫描完成前到达的事件等条目登记后再处理,不等全部插件激活完
  //(某插件授权弹窗无人理会时 init 可能永不结束,其它插件的事件须照常生效)。须在 init() 发起之后接线。
  wirePluginEvents(
    userPluginManager,
    {
      onChanged: (cb) => coApi.plugins.onChanged(cb),
      onUninstalled: (cb) => coApi.plugins.onUninstalled(cb),
      onEnabledChanged: (cb) => coApi.plugins.onEnabledChanged(cb),
    },
    (where, err) => console.warn(`[main] user plugin manager ${where} failed`, err),
  );

  // M-Plugin v4.4:co:// 外部唤起 → 路由到 commands.execute
  // race(R33):同步注册 onProtocolUrl 监听、handler 懒加载。此前订阅写在 import().then 里,
  // 监听要等动态 import 微任务 resolve 才挂;而 main 冷启动在 did-finish-load 只推一次
  // PROTOCOL_URL 无 replay → import 晚于 did-finish-load 时深链丢失。见 wireProtocolUrl。
  wireProtocolUrl({
    onProtocolUrl: (cb) => coApi.plugins.onProtocolUrl(cb),
    loadHandler: () => import('./plugins/protocol/handler'),
    app: coApp,
  });

  // 资源管理器持久化(M-Explorer Step 3 + Step 4)+ Editor session 恢复(Step E5)。
  // fire-and-forget:hydrate 完成后 store setState 触发 React 重渲染,EmptyWorkspace 切到 FolderTree。
  // Splash 屏障经 rootRestored(终端首个快照对齐前提)间接等待 explorer 恢复。
  // 注入 coApi.fs:启动时按 explorer.json 的 editor.openFilePaths 异步读
  // 文件内容,恢复上次会话的 editor tabs。BDD: editor-session-restore。
  //
  // 多窗口 Phase 2B:从 query string 读 ?windowSeq=N(主窗 0,新窗自增)+
  // ?workspace=<path>。windowSeq 标识自己在 explorer.json windows[] 中的段,
  // 各窗 hydrate / persist 自己段不互相覆盖。query workspace 仅在自己段不存在
  // (全新窗口编号)时启动用。见 issue #23。
  const search = window.location.search;
  const initialWindowSeq = parseInitialWindowSeq(search);
  const initialWorkspace = parseInitialWorkspace(search);
  const initialFresh = parseInitialFresh(search);
  void initExplorerPersistence(
    {
      // 取用上方提前发起的 explorer.read(仅一次);之后若再调用则照常发新 IPC。
      read: () => {
        const p = explorerReadPrefetch ?? coApi.explorer.read();
        explorerReadPrefetch = null;
        return p;
      },
      write: (snap) => coApi.explorer.write(snap),
    },
    {
      fs: { readFile: (p) => coApi.fs.readFile(p) },
      windowSeq: initialWindowSeq,
      ...(initialWorkspace !== null ? { initialWorkspace } : {}),
      ...(initialFresh ? { fresh: true } : {}),
    },
  );

  // 注:reviews(卡片 ★)不再启动预拉(打磨 R53)。该数据只在 MarketplaceTab 可见
  // 时用,不像 update 清单驱动 IconSidebar 角标。改为 MarketplaceTab 首次挂载时拉,
  // 把隐藏功能的 GitHub API/网络/解析从冷启动路径移走。

  renderApp(container);

  // 按意图预热 Terminal lazy chunk(xterm 6MB+addons)(打磨 R55:恢复 lazy boundary)。
  // 原先无条件 idle prefetch 会让从不开终端的 session 也下载/解析这个大 chunk。改为只在
  // 出现终端会话(上次 session 恢复的终端,或用户新建)时 warm 一次 —— 与 React.lazy 的
  // 首开加载经模块缓存去重。普通无终端 session 不再触碰大 chunk 的网络/解析/内存。
  // (Phase-5:与 createUserTerminal 共用 preloadTerminalPanelChunk,specifier 与 React.lazy
  //  逐字符一致才能去重;此前这里用 '@/panels/Terminal' index 经共享模块去重,统一为精确入口。)
  watchTerminalIntent(useTerminalStore, preloadTerminalPanelChunk);

  if (window.__continuoE2E === true) {
    window.__continuoTest = {
      openOrFocusPanel,
      focusPanel,
      setEditorContent: (tabId, content) =>
        useEditorStore.getState().updateContent(tabId, content),
      getEditorActiveTabId: () => useEditorStore.getState().activeTabId,
      setSettingValue: (id, v) =>
        useSettingsValuesStore.getState().setValue(id, v),
      getSettingValue: (id) => getStoredSettingValue(id),
      requestPermissions: (pluginId, perms) =>
        usePermissionPromptStore.getState().request(pluginId, perms),
      commandCount: () => coApp.commands.getAll().length,
      executeCommand: async (commandId) => {
        const command = coApp.commands.get(commandId);
        if (!command) return false;
        await command.fn();
        return true;
      },
      registerCommand: (id, title, hotkey) => {
        const d = coApp.commands.register({
          id,
          title,
          ...(hotkey ? { hotkey } : {}),
          fn: () => {},
        });
        return () => d.dispose();
      },
      setHotkey: (commandId, hotkey) =>
        useKeybindingsStore.getState().setHotkey(commandId, hotkey),
    };
  }
}
