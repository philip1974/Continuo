import React from 'react';
import * as ReactNS from 'react';
import { createRoot } from 'react-dom/client';
import { z as zodNS } from 'zod';
import { App } from './shell/App';
import { initExplorerPersistence } from './lib/persist/explorer-persist';
import {
  parseInitialFresh,
  parseInitialWindowSeq,
  parseInitialWorkspace,
} from './lib/initial-workspace';
import { bootCorePlugins } from './core-plugins';
import { coApp, getPluginMcpRegistry } from './plugins/co-app';
import { startPluginMcpInvokeBridge } from './plugins/plugin-mcp-invoke-bridge';
import { Plugin } from './plugins/Plugin';
import { PluginManager, setUserPluginManager } from './plugins/PluginManager';
import { wirePluginReloadGate } from './plugins/plugin-reload-gate';
import { wireProtocolUrl } from './plugins/protocol/wire-protocol-url';
import { createWindowApiHost } from './lib/plugins-host';
import { IpcPermissionStore } from './plugins/permissions/IpcPermissionStore';
import { setUserPermissionStore } from './plugins/permissions/co-permission-store';
import { usePermissionPromptStore } from './plugins/permissions/promptStore';
import { startPluginFsScopeRequestBridge } from './plugins/permissions/usePluginFsScopeRequests';
import { PermissionError, type PermissionKey } from './plugins/permissions';
import { sandboxSweep } from './plugins/sandbox-sweep';
import { captureLmApi, coApi } from './lib/co-api';
import { useUpdateStore } from './marketplace/update-store';
import { useTerminalStore } from './stores/terminal.store';
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
  __continuoTest?: {
    openOrFocusPanel: (id: string, component: string, title: string) => void;
    focusPanel: (id: string) => void;
    setEditorContent: (tabId: string, content: string) => void;
    getEditorActiveTabId: () => string | null;
    setSettingValue: (id: string, value: string | number | boolean) => void;
    getSettingValue: (id: string) => unknown;
    /** 触发权限弹窗(plugin install 流程的核心交互). */
    // 可维护性 M9:复用真实权限键类型(与 promptStore.request 契约一致),不再用更宽的
    // string[] + impl 处 `as never` 掩盖非法键。
    requestPermissions: (
      pluginId: string,
      perms: readonly PermissionKey[],
    ) => Promise<readonly PermissionKey[]>;
    /** 命令数量(用于 e2e 验证内置命令注册数). */
    commandCount: () => number;
    /** 注册命令(测试动态命令出现).返 dispose. */
    registerCommand: (
      id: string,
      title: string,
      hotkey?: string,
    ) => () => void;
    /** 改 keybindings override(测试 hotkey 显示更新). */
    setHotkey: (commandId: string, hotkey: string) => void;
  };
};

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
      z: typeof zodNS;
    };
  }).co = {
    Plugin,
    React: ReactNS,
    PermissionError,
    z: zodNS,
  };

  const container = document.getElementById('root');
  if (!container) throw new Error('#root not found');

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

  // M-Plugin v1.7:渲染前同步注册内置插件(editor / terminal / output),
  // 使 coApp.panels 在 DockShell 首次 mount 时已含 3 个 panel 类型。
  bootCorePlugins();

  // v5 Phase 4:Plugin → MCP bridge 反向调用路由。preload.pluginMcp.onInvoke
  // 收 main 推过来的 INVOKE → 调 registry.invokeLocal → preload.replyInvoke 答 main。
  // fire-and-forget,卸载在窗口关闭时由 GC 处理(订阅 unsub 会泄漏一个 listener,
  // 单 renderer 生命周期级,可接受)。
  startPluginMcpInvokeBridge(getPluginMcpRegistry());
  startPluginFsScopeRequestBridge();

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
  });
  setUserPluginManager(userPluginManager);

  // M-Plugin v4.3.1:主进程 mtime watch 推 changed → 自动 reload。
  // race(R16):init() 与 onChanged 订阅经 reload-gate 解耦 —— init 仍在扫描时到达的变更先
  // 缓冲(去重),init 完成(成功/失败)后逐个 reload,避免窗口期变更被「Plugin not found」丢弃。
  wirePluginReloadGate({
    init: () => userPluginManager.init(),
    reload: (id) => userPluginManager.reload(id),
    onChanged: (cb) => coApi.plugins.onChanged(cb),
    onError: (where, err) =>
      console.warn(`[main] user plugin manager ${where} failed`, err),
  });

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
  // fire-and-forget:hydrate 在毫秒级完成,store setState 触发 React 重渲染,
  // EmptyWorkspace 自动切到 FolderTree。无需 splash。
  // 注入 coApi.fs:启动时按 explorer.json 的 editor.openFilePaths 异步读
  // 文件内容,恢复上次会话的 editor tabs。BDD: editor-session-restore。
  //
  // 多窗口 Phase 2B:从 query string 读 ?windowSeq=N(主窗 0,新窗自增)+
  // ?workspace=<path>。windowSeq 标识自己在 explorer.json windows[] 中的段,
  // 各窗 hydrate / persist 自己段不互相覆盖。query workspace 仅在自己段不存在
  // (全新窗口编号)时启动用。见 issue #23。
  const search = typeof window !== 'undefined' ? window.location.search : '';
  const initialWindowSeq = parseInitialWindowSeq(search);
  const initialWorkspace = parseInitialWorkspace(search);
  const initialFresh = parseInitialFresh(search);
  void initExplorerPersistence(
    {
      read: () => coApi.explorer.read(),
      write: (snap) => coApi.explorer.write(snap),
    },
    {
      fs: { readFile: (p) => coApi.fs.readFile(p) },
      windowSeq: initialWindowSeq,
      ...(initialWorkspace !== null ? { initialWorkspace } : {}),
      ...(initialFresh ? { fresh: true } : {}),
    },
  );

  // Marketplace Phase 3:启动时静默拉一次更新清单(IconSidebar 角标用)。
  // fire-and-forget,不阻塞 UI 渲染。失败 console.warn 不抛。
  void useUpdateStore.getState().refresh();

  // 注:reviews(卡片 ★)不再启动预拉(打磨 R53)。该数据只在 MarketplaceTab 可见
  // 时用,不像 update 清单驱动 IconSidebar 角标。改为 MarketplaceTab 首次挂载时拉,
  // 把隐藏功能的 GitHub API/网络/解析从冷启动路径移走。

  createRoot(container).render(
    React.createElement(React.StrictMode, null, React.createElement(App)),
  );

  // 按意图预热 Terminal lazy chunk(xterm 6MB+addons)(打磨 R55:恢复 lazy boundary)。
  // 原先无条件 idle prefetch 会让从不开终端的 session 也下载/解析这个大 chunk。改为只在
  // 出现终端会话(上次 session 恢复的终端,或用户新建)时 warm 一次 —— 与 React.lazy 的
  // 首开加载经模块缓存去重。普通无终端 session 不再触碰大 chunk 的网络/解析/内存。
  // (Phase-5:与 createUserTerminal 共用 preloadTerminalPanelChunk,specifier 与 React.lazy
  //  逐字符一致才能去重;此前这里用 '@/panels/Terminal' index 经共享模块去重,统一为精确入口。)
  watchTerminalIntent(useTerminalStore, preloadTerminalPanelChunk);

  if (window.__continuoE2E === true) {
    void Promise.all([
      import('@/shell/dock/dock-api-ref'),
      import('@/stores/editor.store'),
      import('@/plugins/settings/values-store'),
      import('@/plugins/permissions/promptStore'),
      import('@/plugins/co-app'),
      import('@/plugins/keybindings/keybindings-store'),
    ]).then(([dock, editor, values, perm, app, kb]) => {
      window.__continuoTest = {
        openOrFocusPanel: dock.openOrFocusPanel,
        focusPanel: dock.focusPanel,
        setEditorContent: (tabId, content) =>
          editor.useEditorStore.getState().updateContent(tabId, content),
        getEditorActiveTabId: () =>
          editor.useEditorStore.getState().activeTabId,
        setSettingValue: (id, v) =>
          values.useSettingsValuesStore.getState().setValue(id, v),
        getSettingValue: (id) =>
          values.useSettingsValuesStore.getState().values[id],
        requestPermissions: (pluginId, perms) =>
          perm.usePermissionPromptStore.getState().request(pluginId, perms),
        commandCount: () => app.coApp.commands.getAll().length,
        registerCommand: (id, title, hotkey) => {
          const d = app.coApp.commands.register({
            id,
            title,
            ...(hotkey ? { hotkey } : {}),
            fn: () => {},
          });
          return () => d.dispose();
        },
        setHotkey: (commandId, hotkey) =>
          kb.useKeybindingsStore.getState().setHotkey(commandId, hotkey),
      };
    });
  }
}

