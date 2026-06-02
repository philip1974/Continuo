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

// Keep in sync with package.json "version" field. Bumped to 0.2.4 (2026-05-31)
// for the dock.openPanel() and notifications.show() SDK additions. Plugins
// declaring minLMVersion >= 0.2.4 need this.
const APP_VERSION = '0.2.4';

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

    const state = useEditorStore.getState();
    const activeTab = state.tabs.find((t) => t.id === path);
    const inMilkdown =
      isMarkdownPath(path) && getEffectiveMode(activeTab ?? null) !== 'source';
    if (activeTab && inMilkdown) {
      return { ok: true, lineApplied: false, reason: 'milkdown-engine' };
    }

    const view = await useEditorStore.getState().waitForViewRef(path, 500);
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
    const spec = coApp.panels.list().find((panel) => panel.type === panelId);
    if (!spec) return;
    openOrFocusPanel(spec.type, spec.type, spec.title, spec.titleKey);
  },
};

const notifications: CoNotificationsApi = {
  show({ kind, message, code }) {
    const level = isNotificationLevel(kind) ? kind : 'info';
    notify(
      message,
      level,
      code === undefined ? undefined : { code },
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
