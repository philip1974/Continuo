// 全局 CoApp 实例(M-Plugin v1)。
// 单例:registry 在此创建,贡献点跨整个 app 共享;Plugin 通过 app 字段访问。
//
// 后续(v2+)若加 events / fs / log 等,在此扩 CoApp 接口与实例。

import { CommandRegistry } from './registries/CommandRegistry';
import { EventBus } from './EventBus';
import { EditorActionRegistry } from './registries/EditorActionRegistry';
import { ExplorerContextMenuRegistry } from './registries/ExplorerContextMenuRegistry';
import { ExplorerDecoratorRegistry } from './registries/ExplorerDecoratorRegistry';
import { IpcPluginDataStore } from './PluginDataStore';
import { PanelRegistry } from './registries/PanelRegistry';
import { PluginMcpRegistry } from './registries/PluginMcpRegistry';
import { RibbonRegistry } from './registries/RibbonRegistry';
import { SettingItemRegistry } from './registries/SettingItemRegistry';
import { SettingTabRegistry } from './registries/SettingTabRegistry';
import { StatusBarRegistry } from './registries/StatusBarRegistry';
import { useWorkspaceStore } from '@/stores/workspace.store';
import { createIpcPluginMcpUpstream } from './plugin-mcp-upstream';
import { coApi } from '@/lib/co-api';
import { openFileByPath } from '@/panels/Editor/editor-file-actions';
import { findEditorFileTabByPath } from '@/panels/Editor/editor-tab-lookup';
import {
  isAbsolutePath,
  isMarkdownPath,
} from '@/panels/Editor/editor-path-utils';
import { scrollToLine } from '@/panels/Editor/scrollToLine';
import { getEffectiveMode, useEditorStore } from '@/stores/editor.store';
import { errorMessage } from '../../electron/shared/error-message';
import { openOrFocusPanel } from '@/shell/dock/dock-api-ref';
import { notify } from '@/notifications/notify';
import { isNotificationLevel } from '@/notifications/types';
import type {
  CoApp,
  CoDockApi,
  CoEditorApi,
  CoNotificationsApi,
  CoWorkspaceApi,
  EditorOpenFailureCode,
} from './types';

// Keep in sync with package.json "version" field. Bumped to 0.2.12 (2026-06-30)
// for the release-gate polish pass after the cross-platform hardening audit:
// 数据安全 + 跨平台正确性 + i18n + a11y + race-condition + 边界/畸形输入硬化).
// Plugins declaring minLMVersion >= 0.2.4 need this.
const APP_VERSION = '0.2.12';

// Workspace API — minimal v0.1 surface exposing the current renderer
// window's workspace root (null when no folder open). Plugins use this for
// project-scope features (e.g. resolving project skills root, project
// terminal cwd). Per-window because each Continuo window has its own root.
const workspace: CoWorkspaceApi = {
  async getRoot() {
    return useWorkspaceStore.getState().root;
  },
};

// v5 Phase 4:Plugin → MCP bridge — registry 持 IPC upstream,
// dispose 时通过 preload.pluginMcp.unregisterTool 上行,renderer 启动时
// 在 main.tsx 订阅 onInvoke 把反向调用路由到 registry.invokeLocal。
const pluginMcpRegistry = new PluginMcpRegistry(
  createIpcPluginMcpUpstream(),
);

function mapFsCodeToEditorCode(code: string): EditorOpenFailureCode {
  switch (code) {
    case 'FS_NOT_FOUND':
    case 'FS_NOT_FILE':
    case 'FS_DENIED':
    case 'FS_IO':
    case 'EXCEPTION':
      return code;
    default:
      return 'EXCEPTION';
  }
}

const editor: CoEditorApi = {
  async openFile(path, opts) {
    if (!isAbsolutePath(path)) {
      return {
        ok: false,
        code: 'INVALID_PATH',
        message: 'path must be absolute',
      };
    }

    let openResult;
    try {
      openResult = await openFileByPath(path, {
        fs: coApi.fs,
        store: useEditorStore,
      });
    } catch (err) {
      return {
        ok: false,
        code: 'EXCEPTION',
        message: errorMessage(err),
      };
    }

    if (!openResult.ok) {
      return {
        ok: false,
        code: mapFsCodeToEditorCode(openResult.code),
        message: openResult.message,
      };
    }

    if (opts?.line === undefined) {
      return { ok: true, lineApplied: false, reason: 'no-line-arg' };
    }

    // 跨平台(codex 复查 P2,X10 的 SDK 兄弟):用平台感知 pathEquals 找已开 tab —— Windows
    // 上插件传的 path 与既有 tab id 仅大小写不同时,openFileByPath(X10)已切到既有 tab,但
    // 这里若用 `t.id === path` 找不到 activeTab、waitForViewRef 用错 key → 行号跳转失败。
    // viewRef 必须用**已开 tab 的真实 id**(大小写可能不同)查。
    const state = useEditorStore.getState();
    const activeTab = findEditorFileTabByPath(state.tabs, path);
    const viewKey = activeTab?.id ?? path;
    const inMilkdown =
      isMarkdownPath(path) && getEffectiveMode(activeTab ?? null) !== 'source';
    if (activeTab && inMilkdown) {
      return { ok: true, lineApplied: false, reason: 'milkdown-engine' };
    }

    const view = await useEditorStore.getState().waitForViewRef(viewKey, 500);
    if (!view) {
      return { ok: true, lineApplied: false, reason: 'tab-not-mounted' };
    }

    const outcome = scrollToLine(view, opts.line);
    if (outcome === 'out-of-range') {
      return {
        ok: true,
        lineApplied: false,
        reason: 'line-out-of-range',
      };
    }
    return { ok: true, lineApplied: true };
  },
};

const dock: CoDockApi = {
  openPanel(panelId) {
    const spec = coApp.panels.get(panelId);
    if (!spec) return;
    openOrFocusPanel(spec.type, spec.type, spec.title, spec.titleKey);
  },
};

// 边界(E52,插件 API 输入校验):app.notifications.show() 的 message/code 是插件直传,直接进
// notify() → console mirror → Toast DOM 渲染。单条通知不走 MAX_NOTIFICATIONS 队列上限,畸形/恶意
// 插件可传超大字符串造成 renderer 内存膨胀 + console/DOM 卡顿。入口校验:message 必须非空 string 且
// 截断到上限,code 非字符串/超长则丢弃(降级为无 code 通知,不渲染垃圾)。
const NOTIFY_MESSAGE_MAX = 4096;
const NOTIFY_CODE_MAX = 256;

const notifications: CoNotificationsApi = {
  // 边界(E271,E52 续 / 插件 API 对象形态守卫):opts 为插件直传 —— JS 插件可传 null/undefined/非对象。
  // 此前在参数处直接解构 `{ kind, message, code }`,对 null/非对象会抛 TypeError 冒泡到插件激活/命令执行
  // (本应按边界策略静默丢弃非法通知)。改按 unknown 接收(满足接口:参数逆变),先判对象形态再读字段。
  show(rawOpts: unknown) {
    if (rawOpts === null || typeof rawOpts !== 'object' || Array.isArray(rawOpts)) {
      return;
    }
    const { kind, message, code } = rawOpts as {
      kind?: unknown;
      message?: unknown;
      code?: unknown;
    };
    const level = isNotificationLevel(kind) ? kind : 'info';
    if (typeof message !== 'string' || message.length === 0) return; // 非法 message 不渲染
    const safeMessage =
      message.length > NOTIFY_MESSAGE_MAX
        ? message.slice(0, NOTIFY_MESSAGE_MAX)
        : message;
    const safeCode =
      typeof code === 'string' && code.length > 0 && code.length <= NOTIFY_CODE_MAX
        ? code
        : undefined;
    notify(
      safeMessage,
      level,
      safeCode === undefined ? undefined : { code: safeCode },
    );
  },
};

export const coApp: CoApp = {
  version: APP_VERSION,
  panels: new PanelRegistry(),
  commands: new CommandRegistry(),
  statusBar: new StatusBarRegistry(),
  ribbon: new RibbonRegistry(),
  events: new EventBus(),
  // Lazy IPC-backed; first plugin data read triggers load from userData.
  dataStore: new IpcPluginDataStore(),
  settingTabs: new SettingTabRegistry(),
  settingItems: new SettingItemRegistry(),
  explorerDecorators: new ExplorerDecoratorRegistry(),
  editorActions: new EditorActionRegistry(),
  explorerContextMenu: new ExplorerContextMenuRegistry(),
  mcp: pluginMcpRegistry,
  workspace,
  editor,
  dock,
  notifications,
};

/** 让 main.tsx 拿到 registry 引用,在启动时订阅 onInvoke 路由反向调用. */
export function getPluginMcpRegistry(): PluginMcpRegistry {
  return pluginMcpRegistry;
}
