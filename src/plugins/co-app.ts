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
import {
  findPluginOpenedTab,
  openFileByPath,
  openFileWithContent,
  type FileOpResult,
  type OpenFileOptions,
} from '@/panels/Editor/editor-file-actions';
import { mapFsCodeToEditorCode } from './editor-open-codes';
import { ensurePluginOpenedTabTracking, releasePluginOpenedPath } from './plugin-opened-tabs';
import {
  findEditorFileTabById,
  findEditorFileTabByPath,
} from '@/panels/Editor/editor-tab-lookup';
import { preloadCodeEditorEngine } from '@/panels/Editor/editor-engine-loaders';
import { revealInMarkdown, type MarkdownRevealOutcome } from '@/panels/Editor/markdown-reveal-registry';
import type { EditorView } from '@codemirror/view';
import { isAbsolutePath } from '@/lib/path-cross';
import { useEditorStore, usesMilkdownEngine } from '@/stores/editor.store';
import { errorMessage } from '../../electron/shared/error-message';
import { openOrFocusPanel } from '@/shell/dock/dock-api-ref';
import { notify } from '@/notifications/notify';
import { isNotifyLevel } from '../../electron/shared/notify-channels';
import type {
  CoApp,
  CoDockApi,
  CoHostEditorApi,
  CoNotificationsApi,
  CoWorkspaceApi,
  EditorOpenOptions,
  EditorOpenResult,
} from './types';
import { editorFileDeps } from '@/panels/Editor/editor-file-deps';
import { APP_VERSION } from '@/lib/app-version';

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
// 在 main-app.ts 订阅 onInvoke 把反向调用路由到 registry.invokeLocal。
const pluginMcpRegistry = new PluginMcpRegistry(
  createIpcPluginMcpUpstream(),
);


/**
 * 等待 viewKey 的 CodeMirror view 挂载,并确认返回时它仍是当前注册的 view(waitForViewRef
 * resolve 到续体之间隔 microtask,期间可能被替换);被替换则按新值再等一次。
 */
async function waitForCurrentView(viewKey: string): Promise<EditorView | null> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const view = await useEditorStore.getState().waitForViewRef(viewKey, 500);
    if (!view) return null;
    if (useEditorStore.getState().viewRefs.get(viewKey) === view) return view;
  }
  return null;
}

const OPENED: FileOpResult = { ok: true, data: undefined };

const invalidPathResult = {
  ok: false,
  code: 'INVALID_PATH',
  message: 'path must be absolute',
} as const;

/**
 * 宿主内部的「打开并定位」(同 editor.openFile),可指定打开方式(OpenFileOptions.preview:搜索结果单击以预览方式、⌘P 常驻;
 * BDD: src/__tests__/editor-preview-tab/)。插件 API 不暴露打开方式。
 */
export async function openFileInEditor(
  path: string,
  opts: EditorOpenOptions | undefined,
  openOpts?: OpenFileOptions,
): Promise<EditorOpenResult> {
  if (!isAbsolutePath(path)) return invalidPathResult;
  return openInEditor(path, opts, undefined, () => openFileByPath(path, editorFileDeps, openOpts));
}

const editor: CoHostEditorApi = {
  openFile: (path, opts) => openFileInEditor(path, opts),
  // 安全:插件发起的 openFile 由 scoped app 先经主进程「持锁校验 + 读取」,再用这份内容开标签(见 CoHostEditorApi)。
  // 那次读取在主进程记下的一份「插件打开的路径」归这里处置:新建了标签 → 交给标签(关闭时释放,见
  // plugin-opened-tabs);否则当即释放。
  async openVerifiedFile(canonicalPath, content, opts, requestedPath) {
    ensurePluginOpenedTabTracking();
    let adopted = false;
    try {
      if (!isAbsolutePath(canonicalPath)) return invalidPathResult;
      return await openInEditor(canonicalPath, opts, requestedPath, async () => {
        const r = await openFileWithContent(canonicalPath, content, requestedPath);
        if (!r.ok) return r;
        adopted = r.data;
        return OPENED;
      });
    } finally {
      if (!adopted) releasePluginOpenedPath(canonicalPath);
    }
  },
};

async function openInEditor(
  path: string,
  opts: EditorOpenOptions | undefined,
  /** 插件原路径(openVerifiedFile):找标签跳行与打开时的判重同一口径(findPluginOpenedTab)。 */
  requestedPath: string | undefined,
  open: () => Promise<FileOpResult>,
): Promise<EditorOpenResult> {
  let openResult;
  try {
    openResult = await open();
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

  // 跨平台(复查 P2,X10 的 SDK 兄弟):用平台感知 pathEquals 找已开 tab —— Windows
  // 上插件传的 path 与既有 tab id 仅大小写不同时,openFileByPath(X10)已切到既有 tab,但
  // 这里若用 `t.id === path` 找不到 activeTab、waitForViewRef 用错 key → 行号跳转失败。
  // viewRef 必须用**已开 tab 的真实 id**(大小写可能不同)查。
  const state = useEditorStore.getState();
  const activeTab =
    requestedPath === undefined
      ? findEditorFileTabByPath(state.tabs, path)
      : findPluginOpenedTab(state.tabs, path, requestedPath);
  const viewKey = activeTab?.id ?? path;
  // 按标签实际的打开路径判引擎(与 EditorPanel 同口径):经链接打开时其扩展名可能与 canonical 不同。
  const inMilkdown = usesMilkdownEngine(activeTab?.filePath ?? path, activeTab ?? null);
  if (activeTab && inMilkdown) {
    // Markdown 编辑 / 预览(Milkdown):视图就绪后按源码行 / 列定位并选中(在文件中查找打开结果;BDD: src/__tests__/search-open-markdown/)
    let outcome: MarkdownRevealOutcome;
    try {
      outcome = await revealInMarkdown(viewKey, { line: opts.line, column: opts.column, length: opts.length });
    } catch (err) {
      return { ok: false, code: 'EXCEPTION', message: errorMessage(err) };
    }
    if (outcome === 'applied') return { ok: true, lineApplied: true };
    return { ok: true, lineApplied: false, reason: outcome === 'out-of-range' ? 'line-out-of-range' : 'tab-not-mounted' };
  }

  // perf E1:scrollToLine 运行时依赖 @codemirror/view。co-app 在 main-app 启动路径上,静态
  // import 会把整套 CodeMirror 拖进启动包、破坏 Editor 懒加载边界,故动态 import。
  // 冷加载(复审 #1):Editor 面板与 CodeEditor 是串行两级 lazy chunk,固定 500ms 的挂载等待
  // 可能在 chunk 下载期间就超时 → 永久漏跳。先并行拉齐 scrollToLine 与 CodeEditor 引擎 chunk,
  // 模块就绪后才开始有界等待:剩余工作只有 React 提交 + EditorView 构造,500ms 足够;热路径
  // 模块均已缓存,只多几个 microtask。
  // 并发(复审 #2):view 在模块就绪**之后**取,并按当前注册值复核 —— 加载期间切 tab / 切 mode
  // 销毁的旧 view 不会被跳行(destroy 后 dispatch 不抛错,会谎报成功)。
  // 错误契约(复审 #4):chunk 加载失败 / 跳行抛错同样映射为 EXCEPTION 结果,不让 openFile reject。
  let outcome: ReturnType<
    typeof import('@/panels/Editor/scrollToLine').scrollToLine
  >;
  try {
    const [{ scrollToLine }] = await Promise.all([
      import('@/panels/Editor/scrollToLine'),
      preloadCodeEditorEngine(),
    ]);
    const view = await waitForCurrentView(viewKey);
    if (!view) {
      return { ok: true, lineApplied: false, reason: 'tab-not-mounted' };
    }
    // 并发(复审 r3 #2):切 tab / Source→Edit 时 store 同步变化,但旧 view 要到 useEffect
    // cleanup 才 unregister —— 这一窗口内 Map 里仍是将被销毁的旧 view。跳行前紧挨着按 store
    // 当前态复核:目标仍为活动 tab、仍处 CodeMirror 模式(与上方 inMilkdown 同口径)。
    const now = useEditorStore.getState();
    const nowTab = findEditorFileTabById(now.tabs, viewKey);
    if (usesMilkdownEngine(nowTab?.filePath ?? path, nowTab)) {
      return { ok: true, lineApplied: false, reason: 'milkdown-engine' };
    }
    if (now.activeTabId !== viewKey || now.viewRefs.get(viewKey) !== view) {
      return { ok: true, lineApplied: false, reason: 'tab-not-mounted' };
    }
    outcome = scrollToLine(view, opts.line, opts.column, opts.length);
  } catch (err) {
    return {
      ok: false,
      code: 'EXCEPTION',
      message: errorMessage(err),
    };
  }
  if (outcome === 'out-of-range') {
    return {
      ok: true,
      lineApplied: false,
      reason: 'line-out-of-range',
    };
  }
  return { ok: true, lineApplied: true };
}

const dock: CoDockApi = {
  openPanel(panelId) {
    const spec = coApp.panels.get(panelId);
    if (!spec) return;
    openOrFocusPanel(spec.type, spec.type, spec.title, spec.titleKey);
  },
};

// 边界(E52,插件 API 输入校验):app.notifications.show() 的 message/code 是插件直传,直接进
// notify() → console mirror → Toast DOM 渲染。单条通知不走 MAX_NOTIFICATIONS 队列上限,畸形/恶意
// 插件可传超大字符串造成 renderer 内存膨胀 + console/DOM 卡顿。入口只做类型校验(message 非空 string、
// code 非字符串则丢弃);限长(message 截断、超长 / 空 code 丢弃)统一在 notify 的唯一入口 notifyCore。

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
    const level = isNotifyLevel(kind) ? kind : 'info';
    if (typeof message !== 'string' || message.length === 0) return; // 非法 message 不渲染
    // 这里只做类型校验;限长(message 截断、超长 / 空 code 丢弃)统一在 notify 的唯一入口 notifyCore。
    notify(message, level, typeof code === 'string' ? { code } : undefined);
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

