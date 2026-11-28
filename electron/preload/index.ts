import { contextBridge, ipcRenderer, webFrame, webUtils } from 'electron';
import {
  EXPLORER_CHANNELS,
  LAYOUT_CHANNELS,
  WINDOW_ID_CHANNEL,
  isRecentRootsChangedPayload,
  type DirtyState,
  type FlushAckPayload,
  type FlushRequestPayload,
} from '../shared/persistence-channels';
import { guardedListener, subscribeAndAnnounce, subscribeIpc } from './subscribe-ipc';
import { createTerminalDataDemux } from './terminal-data-demux';
import type { IpcResult } from '../shared/ipc-result';
import type { FileEntry, FsScanFilesData } from '../shared/fs-entry';
import {
  DIR_CHANGED_FILES_MAX,
  FS_CHANNELS,
  isFsDirChangedPayload,
  readFsDirChangedChangeOnly,
  readFsDirChangedFiles,
  toFsReadFileResult,
  toFsStatResult,
  toFsWriteFileResult,
  type FsCreated,
  type FsFileStat,
  type FsReadFileData,
  type FsReadImageData,
  type FsUndoBackup,
  type FsReadFileResult,
  type FsListDirOptions,
} from '../shared/fs-channels';
import type { TextEncodingId } from '../shared/text-encoding';
import { FS_PATH_MAX } from '../shared/fs-limits';
import {
  isSearchEvent,
  SEARCH_CHANNELS,
  type SearchEvent,
  type SearchQuery,
  type SearchStartResult,
} from '../shared/workspace-search';
import {
  isTsLanguageEvent,
  TS_LANGUAGE_CHANNELS,
  type TsLanguageEvent,
  type TsRequestInput,
  type TsRequestReply,
} from '../shared/ts-language';
import { GIT_CHANNELS, type GitStatusResult } from '../shared/git-status';
import {
  SESSION_UPDATE_CWD_CHANNEL,
  TERMINAL_CHANNELS,
  type TerminalHistorySnapshot,
} from '../shared/terminal-channels';
import type { TerminalSessionSnapshot } from '../shared/terminal-session';
import type { TerminalCreateInput } from '../shared/terminal-create';
import {
  PLUGINS_CHANNELS,
  isPluginsChangedPayload,
  isPluginEnabledChangedPayload,
  isProtocolUrlPayload,
  type IpcPermissionMutation,
  type IpcPermissionsMap,
  type IpcPermissionRecord,
  type IpcPluginDirListing,
  type InstallFromGitResult,
} from '../shared/plugins-channels';
import {
  SHELL_CHANNELS,
  type IpcShellExecInput,
  type IpcShellExecResult,
} from '../shared/shell-channels';
import {
  AGENT_AUTH_CHANNELS,
  type AgentAuthDecision,
  type RevokeResult,
} from '../shared/agent-auth-channels';
import {
  MCP_CHANNELS,
  type StdioMcpConfig,
} from '../shared/mcp-channels';
import {
  PLUGIN_MCP_CHANNELS,
  type InvokeReply,
  type RegisterPayload,
} from '../shared/plugin-mcp-channels';
import {
  WINDOW_CHANNELS,
  type IpcWindowCreateInput,
  type WindowSwitchEntry,
  type WindowViewAction,
  type WindowViewActionTarget,
} from '../shared/window-channels';
import {
  MARKETPLACE_CHANNELS,
  type FetchReviewsResult,
} from '../shared/marketplace-channels';
import {
  I18N_CHANNELS,
  type I18nChangedPayload,
} from '../shared/i18n-channels';
import {
  DEBUG_VIEW_CHANNELS,
  type DebugGetStackInput,
  type DebugGetVariablesInput,
} from '../shared/debug-view-channels';
import type { Locale } from '../shared/i18n-types';
import {
  ACCESSIBILITY_CHANNELS,
  isAccessibilitySupportChangedPayload,
} from '../shared/accessibility-channels';
import { pluginDataRaw } from './plugin-data.preload';
import { pluginFsRaw } from './plugin-fs.preload';
import { pluginShellStreamRaw } from './plugin-shell-stream.preload';
import {
  parseContinuoHostnameFromArgv,
  parseContinuoWindowsBuildFromArgv,
} from './continuo-meta-parse';

// 可维护性 M24:terminal create 入参复用 shared TerminalCreateInput(= main zod schema
// z.infer),单一来源避免 main/preload 漂移(此前手写 interface 漏了 attachTarget)。
// export 是为了 ContinuoApi 跨 module 引用时 TS 能 name 这些类型(src/lib/co-api.ts 需要)。
export type TerminalCreateOptions = TerminalCreateInput;

/**
 * main 推过来的 session 形态;renderer cast 为 TerminalSession。
 * 可维护性 M14:复用 shared TerminalSessionSnapshot 单一来源(此前内联重复了同组字段)。
 */
export type PreloadTerminalSession = TerminalSessionSnapshot;

// fs:list-dir 选项(由 main 的 zod schema 推出,见 shared/fs-list-dir-schema.ts)。
export type PreloadListDirOptions = FsListDirOptions;

// 性能 P1:终端输出 'terminal:data' 整窗只挂一个 ipcRenderer listener,按 sessionId
// 分发(详见 terminal-data-demux.ts)。避免 N 个 panel = N 个 listener 的 O(N) fan-out。
const terminalDataDemux = createTerminalDataDemux();
let terminalDataListenerInstalled = false;
function ensureTerminalDataListener(): void {
  if (terminalDataListenerInstalled) return;
  ipcRenderer.on(
    TERMINAL_CHANNELS.DATA,
    (_: unknown, id: string, data: string, offset?: number) => {
      terminalDataDemux.dispatch(id, data, offset);
    },
  );
  terminalDataListenerInstalled = true;
}

// 关窗脏态上报(计数 + 脏 tab id,id 供 main 按身份比较已接受范围),形态见 shared DirtyState。
type DirtyReport = DirtyState;


// 所有跨 IPC 的方法都返回 IpcResult<T>(详见 ADR-010),
// renderer 拿到后按 ok 分流,不再 throw。
const api = {
  layout: {
    read: (): Promise<IpcResult<unknown | null>> =>
      ipcRenderer.invoke(LAYOUT_CHANNELS.READ),
    write: (json: unknown): Promise<IpcResult<void>> =>
      ipcRenderer.invoke(LAYOUT_CHANNELS.WRITE, json),
    onFlushRequest: (
      cb: (payload?: FlushRequestPayload) => void | Promise<void>,
    ): (() => void) => {
      // main 发 `{ windowId, requestId, save?, discard?, pendingAutoSave? }`(save / discard:用户在脏文件确认框选了「保存」/
      // 「不保存」;requestId 须在回执里原样带回,main 只接受匹配在途请求的回执);透传给回调(不暴露 IpcRendererEvent)。
      const listener = (_event: unknown, payload?: FlushRequestPayload) => {
        void cb(payload);
      };
      // 挂上后告诉 main「本窗口现在能应答 flush 请求了」。没上报过的窗口(启动中 / 加载失败)关窗时 main 不发
      // 请求、不等回执 —— 否则没人回 ack,只能干等满超时。
      return subscribeAndAnnounce(LAYOUT_CHANNELS.FLUSH_REQUEST, LAYOUT_CHANNELS.FLUSH_READY, listener);
    },
    // result 形态见 shared FlushAckPayload(remaining / state 语义注释在那里)。
    sendFlushAck: (windowId: number, result?: FlushAckPayload): void => {
      ipcRenderer.send(LAYOUT_CHANNELS.FLUSH_ACK, windowId, result);
    },
    /** 上报本窗口关窗会丢的脏 tab 计数与 id(main 关窗 / 退出前据此弹保存确认、按身份做最终检查)。 */
    reportDirtyState: (state: DirtyReport): void => {
      ipcRenderer.send(LAYOUT_CHANNELS.DIRTY_STATE, state);
    },
  },
  system: {
    windowId: ipcRenderer.sendSync(WINDOW_ID_CHANNEL) as number,
    /** 本机 hostname(main 经 additionalArguments 注入;OSC7 acceptedHosts 用)。 */
    hostname: parseContinuoHostnameFromArgv(process.argv),
    /** Windows 系统 build 号(仅 win32 由 main 注入;其余平台 null)。终端 xterm windowsPty 用。 */
    windowsBuild: parseContinuoWindowsBuildFromArgv(process.argv),
  },
  explorer: {
    // ExplorerPayload 形态由 src/lib/persist/explorer-persist 保证;preload 透传 unknown
    read: (): Promise<IpcResult<unknown | null>> =>
      ipcRenderer.invoke(EXPLORER_CHANNELS.READ),
    write: (json: unknown): Promise<IpcResult<void>> =>
      ipcRenderer.invoke(EXPLORER_CHANNELS.WRITE, json),
    /** 把一项置顶到全局「最近打开」(main 锁内与盘上合并后广播 onRecentChanged). */
    touchRecent: (path: string): Promise<IpcResult<void>> =>
      ipcRenderer.invoke(EXPLORER_CHANNELS.TOUCH_RECENT, { path }),
    /** 从全局「最近打开」移除一项(main 锁内移除后广播 onRecentChanged). */
    removeRecent: (path: string): Promise<IpcResult<void>> =>
      ipcRenderer.invoke(EXPLORER_CHANNELS.REMOVE_RECENT, { path }),
    /** 同一窗口切换 root:存切走前的状态为旧 root 的快照,返回切到的 root 的快照(无则 null;形态由 main zod 校验). */
    switchWorkspace: (input: { save: unknown; open: string | null }): Promise<IpcResult<unknown | null>> =>
      ipcRenderer.invoke(EXPLORER_CHANNELS.SWITCH_WORKSPACE, input),
    /** 订阅「最近打开」变更广播(任一窗口 touch 成功后 main 推给所有窗口),返 unsubscribe. */
    onRecentChanged: (cb: (recentRoots: string[]) => void): (() => void) =>
      subscribeIpc(
        EXPLORER_CHANNELS.RECENT_CHANGED,
        guardedListener(isRecentRootsChangedPayload, '[explorer] dropped malformed recent-changed payload', (payload) =>
          cb(payload.recentRoots),
        ),
      ),
  },
  /**
   * 资源管理器 git 状态装饰:根由 main 取自本窗口工作区;非仓库 / 未装 git / 失败 → data=null;root(renderer 期望的根)
   * 与登记根不符 → data=GIT_STATUS_STALE。
   */
  git: {
    status: (root: string): Promise<IpcResult<GitStatusResult>> => ipcRenderer.invoke(GIT_CHANNELS.STATUS, { root }),
  },
  /**
   * 在文件中查找(workspace-search):根由 main 取自本窗口工作区(root = renderer 当前的根,只用于比对,不符 → STALE);
   * 结果经 onEvent 分批推送。
   */
  search: {
    start: (searchId: string, query: SearchQuery, root: string): Promise<IpcResult<SearchStartResult>> =>
      ipcRenderer.invoke(SEARCH_CHANNELS.START, { searchId, query, root }),
    cancel: (searchId: string): Promise<IpcResult<void>> => ipcRenderer.invoke(SEARCH_CHANNELS.CANCEL, { searchId }),
    onEvent: (cb: (event: SearchEvent) => void): (() => void) =>
      subscribeIpc(
        SEARCH_CHANNELS.EVENT,
        guardedListener(isSearchEvent, '[search] dropped malformed search event', cb),
      ),
  },
  /** TS / JS 语言服务(转到定义;BDD: src/__tests__/editor-go-to-definition/):根由 main 取自本窗口工作区;崩溃经 onEvent 推送。 */
  tsLanguage: {
    request: (input: TsRequestInput): Promise<IpcResult<TsRequestReply>> =>
      ipcRenderer.invoke(TS_LANGUAGE_CHANNELS.REQUEST, input),
    onEvent: (cb: (event: TsLanguageEvent) => void): (() => void) =>
      subscribeIpc(
        TS_LANGUAGE_CHANNELS.EVENT,
        guardedListener(isTsLanguageEvent, '[ts-language] dropped malformed event', cb),
      ),
  },
  fs: {
    listDir: (
      path: string,
      options?: PreloadListDirOptions,
    ): Promise<IpcResult<ReadonlyArray<FileEntry>>> =>
      ipcRenderer.invoke(FS_CHANNELS.LIST_DIR, { path, options }),
    /** 递归扫描(Quick Open):data.skippedDirs = 读不了而跳过的子目录数;根读不了才失败. */
    scanFiles: (
      path: string,
      options?: PreloadListDirOptions,
    ): Promise<IpcResult<FsScanFilesData>> =>
      ipcRenderer.invoke(FS_CHANNELS.SCAN_FILES, { path, options }),
    /**
     * data = 文件内容(不含 BOM);realPath = leaf 为符号链接时的真实目标(可选,FS_PATH_MAX 与 PATH_STR_MAX 同值);
     * encoding = 解码所用编码(缺省 = utf8)。opts.encoding:按该编码解码(「通过编码重新打开」),缺省自动识别 BOM / UTF-8.
     */
    readFile: async (path: string, opts?: { readonly encoding?: TextEncodingId }): Promise<FsReadFileResult> =>
      toFsReadFileResult(
        (await ipcRenderer.invoke(
          FS_CHANNELS.READ_FILE,
          opts?.encoding === undefined ? { path } : { path, encoding: opts.encoding },
        )) as IpcResult<FsReadFileData>,
        FS_PATH_MAX,
      ),
    /**
     * 只读图片预览 / Markdown 图片:data = { dataUrl, size }。opts.workspaceOnly:仅允许本窗口工作区内(主进程 realpath 判定);
     * opts.documentPath:引用图片的 Markdown 文档 —— 本窗口打开过它时,主进程另放行其所在目录(工作区外的文档)。
     */
    readImage: (
      path: string,
      opts?: { readonly workspaceOnly?: boolean; readonly documentPath?: string },
    ): Promise<IpcResult<FsReadImageData>> =>
      ipcRenderer.invoke(
        FS_CHANNELS.READ_IMAGE,
        opts?.workspaceOnly === true
          ? opts.documentPath !== undefined
            ? { path, workspaceOnly: true, documentPath: opts.documentPath }
            : { path, workspaceOnly: true }
          : { path },
      ),
    /** 成功时 data = 写入内容的 { mtimeMs, size, ino }(无法确认 → undefined),供编辑器识别自己保存的回声. */
    /** opts.overwriteReadonly:用户已确认覆盖写保护文件(FS_READONLY 后的「覆盖」)。opts.encoding:按该编码写回(缺省 UTF-8 无 BOM)。 */
    writeFile: async (
      path: string,
      content: string,
      opts?: { readonly overwriteReadonly?: boolean; readonly encoding?: TextEncodingId },
    ): Promise<IpcResult<FsFileStat | undefined>> =>
      toFsWriteFileResult(
        (await ipcRenderer.invoke(FS_CHANNELS.WRITE_FILE, {
          path,
          content,
          ...(opts?.overwriteReadonly === true && { overwriteReadonly: true }),
          ...(opts?.encoding !== undefined && opts.encoding !== 'utf8' && { encoding: opts.encoding }),
        })) as IpcResult<unknown>,
      ),
    /** 跟随 symlink 的廉价 stat({ mtimeMs, size, ino });畸形结果映射为失败. */
    stat: async (path: string): Promise<IpcResult<FsFileStat>> =>
      toFsStatResult((await ipcRenderer.invoke(FS_CHANNELS.STAT, { path })) as IpcResult<unknown>),
    writeBinary: (path: string, content: Uint8Array): Promise<IpcResult<void>> =>
      ipcRenderer.invoke(FS_CHANNELS.WRITE_BINARY, { path, content }),
    /** 资源管理器删除前为撤销读回该项(不跟随符号链接;文件 ≤ 5MB 带内容,文件夹只标记;见 FsUndoBackup). */
    readForUndo: (path: string): Promise<IpcResult<FsUndoBackup>> =>
      ipcRenderer.invoke(FS_CHANNELS.READ_FOR_UNDO, { path }),
    /** Markdown 文档里粘贴 / 拖入的图片落盘到文档所在目录(须在工作区内;main 生成文件名、重名加序号);data = 新文件路径. */
    saveDocumentImage: (documentPath: string, fileName: string, data: Uint8Array): Promise<IpcResult<string>> =>
      ipcRenderer.invoke(FS_CHANNELS.SAVE_DOCUMENT_IMAGE, { documentPath, fileName, data }),
    rename: (path: string, newName: string): Promise<IpcResult<string>> =>
      ipcRenderer.invoke(FS_CHANNELS.RENAME, { path, newName }),
    /** name 可带中间目录(`a/b/c.ts`,逐级创建);data.created = 本次新建的最上层项(见 FsCreated)。 */
    createFile: (dir: string, name: string): Promise<IpcResult<FsCreated>> =>
      ipcRenderer.invoke(FS_CHANNELS.CREATE_FILE, { dir, name }),
    createDir: (parent: string, name: string): Promise<IpcResult<FsCreated>> =>
      ipcRenderer.invoke(FS_CHANNELS.CREATE_DIR, { parent, name }),
    trash: (path: string): Promise<IpcResult<void>> =>
      ipcRenderer.invoke(FS_CHANNELS.TRASH, { path }),
    /** 永久删除(不可撤销):仅在「无法移到废纸篓,是否永久删除?」确认后调用. */
    deletePermanently: (path: string): Promise<IpcResult<void>> =>
      ipcRenderer.invoke(FS_CHANNELS.DELETE_PERMANENTLY, { path }),
    reveal: (path: string): Promise<IpcResult<void>> =>
      ipcRenderer.invoke(FS_CHANNELS.REVEAL, { path }),
    move: (src: string, dest: string): Promise<IpcResult<void>> =>
      ipcRenderer.invoke(FS_CHANNELS.MOVE, { src, dest }),
    copy: (src: string, dest: string): Promise<IpcResult<void>> =>
      ipcRenderer.invoke(FS_CHANNELS.COPY, { src, dest }),
    selectDirectory: (): Promise<IpcResult<string | null>> =>
      ipcRenderer.invoke(FS_CHANNELS.SELECT_DIRECTORY),
    /** 另存为:原生保存对话框,defaultPath = 绝对路径或只有文件名(主目录下);返回选定路径,取消 → null(不写盘). */
    showSaveDialog: (defaultPath: string): Promise<IpcResult<string | null>> =>
      ipcRenderer.invoke(FS_CHANNELS.SHOW_SAVE_DIALOG, { defaultPath }),
    watchDir: (path: string): Promise<IpcResult<void>> =>
      ipcRenderer.invoke(FS_CHANNELS.WATCH, { path }),
    unwatchDir: (path: string): Promise<IpcResult<void>> =>
      ipcRenderer.invoke(FS_CHANNELS.UNWATCH, { path }),
    /**
     * 订阅目录变更 push 事件;返回 unsubscribe。files:该目录本次变更项名字(可选,
     * undefined = 未知,按整个目录处理;畸形/超限同样退化为 undefined)。changeOnly:true = 仅内容
     * 变化、目录列表不变(缺省 / 畸形 → false).
     */
    onDirChanged: (
      cb: (path: string, files?: readonly string[], changeOnly?: boolean) => void,
    ): (() => void) => {
      // 边界(E173,E168-E172 同族 IPC ingress 纵深防御):fs:dir-changed payload 此前直接 cb(payload.path)。
      // 畸形 IPC payload(null/非对象/path 非字符串/超长)→ preload listener 抛错(null.path),或把非法
      // key 送进 Explorer watcher / external-file-sync(目录刷新异常、debounce Map 污染、外部同步失效)。
      // runtime guard:非对象/path 非字符串/超长 → console.warn drop;不抛、不下传脏 path。
      const listener = guardedListener(isFsDirChangedPayload, '[fs] invalid dir-changed payload, dropped', (payload) =>
        cb(
          payload.path,
          readFsDirChangedFiles(payload, DIR_CHANGED_FILES_MAX),
          readFsDirChangedChangeOnly(payload),
        ),
      );
      return subscribeIpc(FS_CHANNELS.DIR_CHANGED, listener);
    },
    /** 订阅本窗口持有的 watcher 失效被驱逐事件(payload 守卫同 onDirChanged);返回 unsubscribe. */
    onWatchLost: (cb: (path: string) => void): (() => void) => {
      return subscribeIpc(
        FS_CHANNELS.WATCH_LOST,
        guardedListener(isFsDirChangedPayload, '[fs] invalid watch-lost payload, dropped', (payload) =>
          cb(payload.path),
        ),
      );
    },
    /** 订阅「工作区根自身消失 / 重新出现」事件(payload 守卫同 onDirChanged);返回 unsubscribe. */
    onRootPresenceChanged: (cb: (path: string) => void): (() => void) => {
      return subscribeIpc(
        FS_CHANNELS.ROOT_PRESENCE_CHANGED,
        guardedListener(isFsDirChangedPayload, '[fs] invalid root-presence-changed payload, dropped', (payload) =>
          cb(payload.path),
        ),
      );
    },
  },
  terminal: {
    create: (
      options?: TerminalCreateOptions,
    ): Promise<IpcResult<{ id: string }>> =>
      ipcRenderer.invoke(TERMINAL_CHANNELS.CREATE, options ?? {}),
    write: (id: string, data: string): Promise<IpcResult<void>> =>
      ipcRenderer.invoke(TERMINAL_CHANNELS.WRITE, { id, data }),
    resize: (
      id: string,
      cols: number,
      rows: number,
    ): Promise<IpcResult<void>> =>
      ipcRenderer.invoke(TERMINAL_CHANNELS.RESIZE, { id, cols, rows }),
    // P1 Agent Terminal MCP:session metadata 真相源在 main
    listSessions: (): Promise<
      IpcResult<{ sessions: ReadonlyArray<PreloadTerminalSession> }>
    > => ipcRenderer.invoke(TERMINAL_CHANNELS.LIST_SESSIONS, {}),
    remove: (id: string): Promise<IpcResult<void>> =>
      ipcRenderer.invoke(TERMINAL_CHANNELS.REMOVE, { id }),
    /** 关闭前确认:前台正在运行的子程序名(只有 shell 时为 null)。 */
    runningProcess: (id: string): Promise<IpcResult<{ process: string | null }>> =>
      ipcRenderer.invoke(TERMINAL_CHANNELS.RUNNING_PROCESS, { id }),
    updateCwd: (id: string, cwd: string): Promise<IpcResult<void>> =>
      ipcRenderer.invoke(SESSION_UPDATE_CWD_CHANNEL, { id, cwd }),
    /** tab 右键「重命名…」:非空固定标题;空串清除,回到自动标题。 */
    rename: (id: string, title: string): Promise<IpcResult<void>> =>
      ipcRenderer.invoke(TERMINAL_CHANNELS.RENAME, { id, title }),
    /** 终端本地文件链接:每个候选 → 存在的普通文件的绝对路径,否则 null(按终端 cwd / 工作区根解析)。 */
    resolveLinks: (id: string, paths: readonly string[]): Promise<IpcResult<(string | null)[]>> =>
      ipcRenderer.invoke(TERMINAL_CHANNELS.RESOLVE_LINKS, { id, paths }),
    /**
     * 读 main 端 buffer 的全部历史 raw chunks(保留 ANSI)。
     * topic-07:dockview lazy-mount inactive panel 错过初始 PTY 输出,
     * renderer mount 时调此 + 灌给 xterm 补齐。
     */
    readHistory: (
      id: string,
    ): Promise<IpcResult<TerminalHistorySnapshot>> =>
      ipcRenderer.invoke(TERMINAL_CHANNELS.READ_HISTORY, { id }),
    /** 订阅 main 推的 snapshot;返回 unsubscribe。payload 未经校验(renderer filterByOwnerWindow 校验),如实标 unknown。 */
    onSessionsChanged: (cb: (sessions: unknown) => void): (() => void) => {
      const listener = (_: unknown, sessions: unknown) => cb(sessions);
      return subscribeIpc(TERMINAL_CHANNELS.SESSIONS_CHANGED, listener);
    },
    /**
     * 订阅指定 session 的 stdout 字节流;返回 unsubscribe。
     * 性能 P1:整窗共享单个 'terminal:data' listener,按 id 路由到本 cb(O(1)/chunk),
     * cb 只收已过滤的 data(旧版收 (id,data) 让调用方自己 `if(id!==termId)return`)。
     */
    onData: (id: string, cb: (data: string, offset?: number) => void): (() => void) => {
      ensureTerminalDataListener();
      return terminalDataDemux.add(id, cb);
    },
  },
  plugins: {
    listDirs: (): Promise<IpcResult<readonly IpcPluginDirListing[]>> =>
      ipcRenderer.invoke(PLUGINS_CHANNELS.LIST_DIRS),
    /**
     * perf:激活时按目录名拉 main 源码(列举不再携带),不可用 → null。manifestHash 为列举项令牌,
     * manifest 已变 → PLUGIN_MANIFEST_CHANGED。
     */
    readMainByDir: (dir: string, manifestHash: string): Promise<IpcResult<string | null>> =>
      ipcRenderer.invoke(PLUGINS_CHANNELS.READ_MAIN_BY_DIR, { dir, manifestHash }),
    readEnabled: (): Promise<IpcResult<readonly string[]>> =>
      ipcRenderer.invoke(PLUGINS_CHANNELS.READ_ENABLED),
    /** 数据安全:按单 plugin 启用/禁用 delta 写,防多窗口整表 RMW 互相覆盖. */
    mutateEnabled: (id: string, enabled: boolean): Promise<IpcResult<void>> =>
      ipcRenderer.invoke(PLUGINS_CHANNELS.MUTATE_ENABLED, { id, enabled }),
    readPermissions: (): Promise<IpcResult<IpcPermissionsMap>> =>
      ipcRenderer.invoke(PLUGINS_CHANNELS.READ_PERMISSIONS),
    /**
     * 终审 P1:按权限项增量变更单 plugin 授权(main 合并当前落盘记录),返回合并后的记录(条目删除 → null)。
     * 不再发整条记录覆盖写,陈旧窗口保存不会把别窗的撤销写回。
     */
    mutatePluginPermissions: (
      id: string,
      mutation: IpcPermissionMutation,
    ): Promise<IpcResult<IpcPermissionRecord | null>> =>
      ipcRenderer.invoke(PLUGINS_CHANNELS.MUTATE_PLUGIN_PERMISSIONS, {
        id,
        mutation,
      }),
    /** 订阅「插件授权已变更」广播(任一窗口变更成功后 main 推给所有窗口),返 unsubscribe. */
    onPermissionsChanged: (cb: (id: string) => void): (() => void) => {
      // 同 onChanged:payload 形态 `{ id }`,复用同一守卫(畸形 warn+drop)。
      return subscribeIpc(
        PLUGINS_CHANNELS.PERMISSIONS_CHANGED,
        guardedListener(isPluginsChangedPayload, '[plugins] dropped malformed plugins:permissions-changed payload', (payload) => cb(payload.id)),
      );
    },
    /** v4.3.1 订阅 plugin 文件 mtime 变化,返 unsubscribe. */
    onChanged: (cb: (id: string) => void): (() => void) => {
      // 边界(E242):runtime 守卫 push payload,畸形(null/非字符串/超长 id)warn+drop 不调 cb。
      return subscribeIpc(
        PLUGINS_CHANNELS.CHANGED,
        guardedListener(isPluginsChangedPayload, '[plugins] dropped malformed plugins:changed payload', (payload) => cb(payload.id)),
      );
    },
    /** 订阅「插件已卸载」广播(任一窗口卸载成功后 main 推给所有窗口),返 unsubscribe. */
    onUninstalled: (cb: (id: string) => void): (() => void) => {
      // 同 onChanged:payload 形态 `{ id }`,复用同一守卫(畸形 warn+drop)。
      return subscribeIpc(
        PLUGINS_CHANNELS.UNINSTALLED,
        guardedListener(isPluginsChangedPayload, '[plugins] dropped malformed plugins:uninstalled payload', (payload) => cb(payload.id)),
      );
    },
    /** 订阅「插件已在别的窗口安装」广播(main 推给发起窗口以外的窗口),返 unsubscribe. */
    onInstalled: (cb: (id: string) => void): (() => void) => {
      // 同 onChanged:payload 形态 `{ id }`,复用同一守卫(畸形 warn+drop)。
      return subscribeIpc(
        PLUGINS_CHANNELS.INSTALLED,
        guardedListener(isPluginsChangedPayload, '[plugins] dropped malformed plugins:installed payload', (payload) => cb(payload.id)),
      );
    },
    /** 订阅「插件启用状态已变更」广播(任一窗口启用 / 禁用成功后 main 推给所有窗口),返 unsubscribe. */
    onEnabledChanged: (cb: (id: string, enabled: boolean) => void): (() => void) => {
      return subscribeIpc(
        PLUGINS_CHANNELS.ENABLED_CHANGED,
        guardedListener(isPluginEnabledChangedPayload, '[plugins] dropped malformed plugins:enabled-changed payload', (payload) => cb(payload.id, payload.enabled)),
      );
    },
    /** v4.4 订阅 co:// 外部唤起,返 unsubscribe. */
    onProtocolUrl: (cb: (url: string) => void): (() => void) => {
      // 边界(E242):同 onChanged,孪生 push 入口同款守卫(畸形 url warn+drop)。
      const listener = guardedListener(
        isProtocolUrlPayload,
        '[plugins] dropped malformed protocol-url payload',
        (payload) => cb(payload.url),
      );
      // 监听挂上 → 告诉 main「本窗口能接收 co:// 了」,main 才排空冷启动期间缓冲的深链(同 FLUSH_READY)。
      return subscribeAndAnnounce(PLUGINS_CHANNELS.PROTOCOL_URL, PLUGINS_CHANNELS.PROTOCOL_READY, listener);
    },
    /**
     * v4.5 从 git URL 安装插件,返回 manifest 元信息.
     * overwrite=true:原子覆盖已装版本(用于「更新」,无需先卸载,失败保留旧版本)。
     * opts.branch:clone 指定分支;opts.expectedId:manifest.id 须等于它(marketplace entry 用)。
     */
    installFromGit: (
      url: string,
      overwrite?: boolean,
      opts?: { branch?: string; expectedId?: string },
    ): Promise<IpcResult<InstallFromGitResult>> =>
      ipcRenderer.invoke(PLUGINS_CHANNELS.INSTALL_FROM_GIT, {
        url,
        overwrite,
        branch: opts?.branch,
        expectedId: opts?.expectedId,
      }),
    /** v4.6 卸载插件:rm -rf plugins/<id>/ + 清 _enabled / _permissions. */
    uninstall: (id: string): Promise<IpcResult<void>> =>
      ipcRenderer.invoke(PLUGINS_CHANNELS.UNINSTALL, { id }),
  },
  shell: {
    /** plugin app.shell.exec 后端:一次性 spawn + buffered + 超时. */
    exec: (input: IpcShellExecInput): Promise<IpcResult<IpcShellExecResult>> =>
      ipcRenderer.invoke(SHELL_CHANNELS.EXEC, input),
    /**
     * 用系统默认 app 打开 URL — markdown 链接点击走这条路(http/https/mailto/file)。
     * main process 白名单 scheme,其他抛错。
     */
    openExternal: (url: string): Promise<IpcResult<void>> =>
      ipcRenderer.invoke(SHELL_CHANNELS.OPEN_EXTERNAL, { url }),
    /** 终止本窗口内某插件启动的全部 shell 进程(插件停用/卸载时 PluginManager 调用). */
    killPluginProcesses: (pluginId: string): Promise<IpcResult<void>> =>
      ipcRenderer.invoke(SHELL_CHANNELS.KILL_PLUGIN_PROCESSES, { pluginId }),
  },
  marketplace: {
    /**
     * 安全 S4:拉 marketplace reviews。token + GitHub fetch 在 main(运行时
     * GITHUB_TOKEN,绝不内联进 renderer);main 跑固定查询,返回聚合前 nodes。
     * 无 token → { available:false, nodes:[] },renderer 降级 cache。
     */
    fetchReviews: (): Promise<IpcResult<FetchReviewsResult>> =>
      ipcRenderer.invoke(MARKETPLACE_CHANNELS.FETCH_REVIEWS, {}),
  },
  window: {
    /**
     * 多窗口支持(issue #23 Phase 1):在已有 main process 内开新主窗口。
     * 可选 workspace 绝对路径 — 新窗口启动时直接打开此目录(query string 注入)。
     * 不传 workspace = 空白主窗,用户进 app 后可选 folder。
     */
    create: (
      input: IpcWindowCreateInput,
    ): Promise<IpcResult<void>> =>
      ipcRenderer.invoke(WINDOW_CHANNELS.CREATE, input),
    /**
     * renderer 在 workspace.root 变化时通知 main,维护 windowId→root 映射。
     * 供 MCP agent terminal_create_session 路径 cwd 默认解析使用。
     */
    notifyRoot: (
      root: string | null,
    ): Promise<IpcResult<void>> => ipcRenderer.invoke(WINDOW_CHANNELS.NOTIFY_ROOT, { root }),
    /**
     * 在本窗口打开文件夹前调用:该文件夹已在别的主窗口打开 → main 聚焦那个窗口,data=true(调用方不再切本窗口 root);
     * 否则 data=false。
     */
    focusWorkspaceWindow: (root: string): Promise<IpcResult<boolean>> =>
      ipcRenderer.invoke(WINDOW_CHANNELS.FOCUS_WORKSPACE_WINDOW, { root }),
    /** 设置项「启动时恢复所有窗口」:写入 main 的启动偏好(下次启动生效)。 */
    setRestoreWindows: (enabled: boolean): Promise<IpcResult<void>> =>
      ipcRenderer.invoke(WINDOW_CHANNELS.SET_RESTORE_WINDOWS, { enabled }),
    /** 设置项「缩放级别」(window.zoomLevel):main 夹到 [-8, 8] 后套用到所有窗口(主窗 + popout)并缓存供冷启动。 */
    setZoomLevel: (level: number): Promise<IpcResult<void>> =>
      ipcRenderer.invoke(WINDOW_CHANNELS.SET_ZOOM_LEVEL, { level }),
    /**
     * renderer 解析出的主题(light / dark)变化时通知 main:所有窗口底色改为对应画布色,新窗口 / popout 沿用;
     * main 同时持久化(含主题模式 mode,system 时冷启动按 OS 外观),下次冷启动首窗即用。
     */
    notifyTheme: (
      theme: 'light' | 'dark',
      mode?: 'light' | 'dark' | 'system',
    ): Promise<IpcResult<void>> =>
      ipcRenderer.invoke(WINDOW_CHANNELS.NOTIFY_THEME, mode === undefined ? { theme } : { theme, mode }),
    /**
     * 本窗口当前的界面缩放系数(⌘- / ⌘+ / ⌘0 的页面缩放,1 = 100%)。同步读取(webFrame,沙箱 preload 可用);变化时 renderer
     * 收到 resize。macOS 标题栏据此反向缩放,保持与原生红绿灯等高(VSCode titlebarPart counter-zoom)。
     */
    getZoomFactor: (): number => webFrame.getZoomFactor(),
    /** 本窗口当前是否全屏(macOS 标题栏非全屏时给红绿灯留位)。 */
    isFullScreen: (): Promise<IpcResult<boolean>> => ipcRenderer.invoke(WINDOW_CHANNELS.IS_FULL_SCREEN, {}),
    /** 订阅本窗口进入 / 退出全屏(参数 = 现在是否全屏;非 boolean 的畸形推送丢弃);返回 unsubscribe。 */
    onFullScreenChange: (cb: (fullScreen: boolean) => void): (() => void) =>
      subscribeIpc(WINDOW_CHANNELS.FULL_SCREEN_CHANGED, (_event, payload: unknown) => {
        if (typeof payload === 'boolean') cb(payload);
      }),
    /** 关闭本窗口(经 main win.close(),走关窗脏确认)。⌘W 已无可关的编辑器 / 面板时调用(对齐 VSCode)。 */
    close: (): Promise<IpcResult<void>> => ipcRenderer.invoke(WINDOW_CHANNELS.CLOSE, {}),
    /** 激活本窗口(主窗 renderer 把面板 / 选择器打开在主窗、而系统焦点在 popout 子窗时调用)。 */
    focus: (): Promise<IpcResult<void>> => ipcRenderer.invoke(WINDOW_CHANNELS.FOCUS, {}),
    /**
     * 切换窗口的列表:各主窗口及其 popout 子窗(标题、所属主窗、是否当前窗口)。target.popoutName → 当前窗口是本窗口打开的那个子窗
     *(在子窗里触发)。
     */
    listWindows: (target?: WindowViewActionTarget): Promise<IpcResult<WindowSwitchEntry[]>> =>
      ipcRenderer.invoke(
        WINDOW_CHANNELS.LIST_WINDOWS,
        target?.popoutName === undefined ? {} : { popoutName: target.popoutName },
      ),
    /** 切换窗口:聚焦列表里的那个窗口(最小化的先还原)。 */
    focusWindow: (id: number): Promise<IpcResult<void>> => ipcRenderer.invoke(WINDOW_CHANNELS.FOCUS_WINDOW, { id }),
    /** 重启应用(插件安装后「立即重启」):main 走与 ⌘Q 相同的退出流程(脏文件确认),通过后重新启动。 */
    relaunchApp: (): Promise<IpcResult<void>> => ipcRenderer.invoke(WINDOW_CHANNELS.RELAUNCH_APP, {}),
    /**
     * 对本窗口执行应用菜单 View 同款动作(重新加载 / 切换全屏);重新加载走脏确认。target.popoutName → 作用于本窗口打开的
     * 那个 dockview popout 子窗(子窗界面跑在本 renderer,IPC 发起方总是主窗)。
     */
    viewAction: (action: WindowViewAction, target?: WindowViewActionTarget): Promise<IpcResult<void>> =>
      ipcRenderer.invoke(
        WINDOW_CHANNELS.VIEW_ACTION,
        target?.popoutName === undefined ? { action } : { action, popoutName: target.popoutName },
      ),
    /**
     * Electron 38+ File.path 已弃用,改 webUtils.getPathForFile(file)。
     * renderer 拖文件 / 文件夹到窗口时,需要绝对路径才能调 fs / setRoot。
     * 此 helper 在 preload realm 调 webUtils,sandbox renderer 拿不到原生对象。
     */
    getPathForFile: (file: File): string => webUtils.getPathForFile(file),
    /** 订阅 main 的「执行菜单命令」请求(应用菜单项即 renderer 命令,如 文件 → 打开文件夹… ⌘O);返回 unsubscribe。payload 未经校验。 */
    onMenuCommand: (cb: (payload: unknown) => void): (() => void) =>
      subscribeIpc(WINDOW_CHANNELS.RUN_MENU_COMMAND, (_event, payload: unknown) => cb(payload)),
    /** 订阅 main 的「编辑 → 撤销 / 重做」(鼠标点击菜单项,按焦点分派);返回 unsubscribe。payload 未经校验。 */
    onEditUndoRedo: (cb: (payload: unknown) => void): (() => void) =>
      subscribeIpc(WINDOW_CHANNELS.EDIT_UNDO_REDO, (_event, payload: unknown) => cb(payload)),
    /** 推送菜单命令当前生效的主键(归一后的 hotkey,未绑定为 null):main 换算成菜单 accelerator 显示并重建菜单。 */
    setMenuKeybindings: (keybindings: Readonly<Record<string, string | null>>): Promise<IpcResult<void>> =>
      ipcRenderer.invoke(WINDOW_CHANNELS.SET_MENU_KEYBINDINGS, { keybindings }),
    /** 推送勾选类菜单项的勾选状态(如 文件 → 自动保存):main 据此重建菜单。 */
    setMenuChecked: (checked: Readonly<Record<string, boolean>>): Promise<IpcResult<void>> =>
      ipcRenderer.invoke(WINDOW_CHANNELS.SET_MENU_CHECKED, { checked }),
  },
  agentAuth: {
    /** 订阅 main 推的授权请求(MCP tool 调时);返回 unsubscribe。payload 未经校验(renderer isAgentAuthRequestPayload 校验)。 */
    onRequest: (cb: (payload: unknown) => void): (() => void) => {
      const listener = (_: unknown, payload: unknown) => cb(payload);
      // 监听挂上 → 告诉 main「本窗口能显示授权弹窗了」(同 PROTOCOL_READY):reload 后新文档就绪之前到达的
      // 请求 main 直接拒绝,不发给收不到的文档。
      return subscribeAndAnnounce(AGENT_AUTH_CHANNELS.REQUEST, AGENT_AUTH_CHANNELS.READY, listener);
    },
    /** 用户决定后回应 main(对应 requestId). */
    respond: (
      requestId: string,
      decision: AgentAuthDecision,
    ): Promise<IpcResult<void>> =>
      ipcRenderer.invoke(AGENT_AUTH_CHANNELS.RESPOND, { requestId, decision }),
    /** 订阅 main 对单个请求的结算通知(超时 / 取消):撤掉对应弹窗;返回 unsubscribe. */
    onCancelled: (cb: (payload: unknown) => void): (() => void) =>
      subscribeIpc(AGENT_AUTH_CHANNELS.CANCELLED, (_: unknown, payload: unknown) => cb(payload)),
    /** 订阅 main 广播的「撤销已生效」(任一窗口撤销后推给所有窗口);返回 unsubscribe. */
    onRevoked: (cb: () => void): (() => void) =>
      subscribeIpc(AGENT_AUTH_CHANNELS.REVOKED, () => cb()),
    /** 撤销 session 授权 + 终止全部 agent terminal(状态栏按钮触发). */
    revoke: (): Promise<IpcResult<RevokeResult>> =>
      ipcRenderer.invoke(AGENT_AUTH_CHANNELS.REVOKE, {}),
    /** 全部窗口的 agent terminal 数(撤销会终止的数量;撤销确认框用). */
    countAgentTerminals: (): Promise<IpcResult<{ count: number }>> =>
      ipcRenderer.invoke(AGENT_AUTH_CHANNELS.COUNT_AGENT_TERMINALS, {}),
  },
  debug: {
    subscribe: (): Promise<IpcResult<unknown>> =>
      ipcRenderer.invoke(DEBUG_VIEW_CHANNELS.SUBSCRIBE, {}),
    // payload 未经校验(renderer debug.store 的 asDebugEvent 负责校验 + 截断),如实标 unknown。
    onEvent: (listener: (payload: unknown) => void): (() => void) => {
      const wrapped = (_evt: unknown, payload: unknown) => listener(payload);
      return subscribeIpc(DEBUG_VIEW_CHANNELS.EVENT, wrapped);
    },
    getStack: (input: DebugGetStackInput): Promise<IpcResult<unknown>> =>
      ipcRenderer.invoke(DEBUG_VIEW_CHANNELS.GET_STACK, input),
    getVariables: (
      input: DebugGetVariablesInput,
    ): Promise<IpcResult<unknown>> =>
      ipcRenderer.invoke(DEBUG_VIEW_CHANNELS.GET_VARIABLES, input),
  },
  i18n: {
    /** 同步初值用 — main settings.service 已 hydrate 后返当前 locale。 */
    getLocale(): Promise<IpcResult<Locale>> {
      return ipcRenderer.invoke(I18N_CHANNELS.GET_LOCALE);
    },
    /** 系统默认 locale(首启默认);语言设置项的「默认值」/「恢复默认」目标。 */
    getSystemLocale(): Promise<IpcResult<Locale>> {
      return ipcRenderer.invoke(I18N_CHANNELS.GET_SYSTEM_LOCALE);
    },
    /** 设置新 locale；main 持久化 + 广播 i18n:changed；返回 { locale, gen }。 */
    setLocale(locale: Locale): Promise<IpcResult<I18nChangedPayload>> {
      return ipcRenderer.invoke(I18N_CHANNELS.SET_LOCALE, locale);
    },
    /** 订阅 main 广播;返 unsubscribe。payload 未经校验(renderer isValidI18nChangedPayload 校验,用 gen 排序去过期)。 */
    onChange(listener: (payload: unknown) => void): () => void {
      const wrapped = (_evt: unknown, payload: unknown) => listener(payload);
      return subscribeIpc(I18N_CHANNELS.CHANGED, wrapped);
    },
  },
  /** 系统读屏检测(VSCode accessibilitySupport 的平台侧):终端 screenReaderMode 按它 + 设置 editor.accessibilitySupport 判定。 */
  accessibility: {
    /** 当前是否检测到辅助技术(main app.isAccessibilitySupportEnabled())。 */
    getSupport: (): Promise<IpcResult<boolean>> => ipcRenderer.invoke(ACCESSIBILITY_CHANNELS.GET_SUPPORT),
    /** 订阅系统辅助技术状态变化(main 广播);畸形 payload 丢弃。返 unsubscribe。 */
    onSupportChanged: (cb: (enabled: boolean) => void): (() => void) =>
      subscribeIpc(
        ACCESSIBILITY_CHANNELS.SUPPORT_CHANGED,
        guardedListener(
          isAccessibilitySupportChangedPayload,
          '[accessibility] dropped malformed support-changed payload',
          (payload) => cb(payload.enabled),
        ),
      ),
  },
  mcp: {
    /** 拿当前 stdio MCP 配置(状态栏"复制 MCP 配置"按钮用). */
    getStdioConfig: (): Promise<IpcResult<StdioMcpConfig>> =>
      ipcRenderer.invoke(MCP_CHANNELS.GET_STDIO_CONFIG, {}),
  },
  pluginMcp: {
    /** 上行注册 tool 元数据;失败返 IpcFail(含 TOOL_NAME_TAKEN 等 code). */
    registerTool: (payload: RegisterPayload): Promise<IpcResult<void>> =>
      ipcRenderer.invoke(PLUGIN_MCP_CHANNELS.REGISTER, payload),
    /** 上行摘 tool;unknown name 静默 ok. */
    unregisterTool: (name: string): Promise<IpcResult<void>> =>
      ipcRenderer.invoke(PLUGIN_MCP_CHANNELS.UNREGISTER, { name }),
    /** main 反向调 tool.run 时推过来的 invoke 请求(订阅;返 unsubscribe). */
    // payload 未经校验(renderer InvokePayloadSchema.safeParse 校验),如实标 unknown。
    onInvoke: (cb: (payload: unknown) => void): (() => void) => {
      const listener = (_: unknown, payload: unknown) => cb(payload);
      return subscribeIpc(PLUGIN_MCP_CHANNELS.INVOKE, listener);
    },
    /** renderer 答 main(单向 send,无 IpcResult). */
    replyInvoke: (reply: InvokeReply): void => {
      ipcRenderer.send(PLUGIN_MCP_CHANNELS.INVOKE_REPLY, reply);
    },
  },
  pluginDataRaw,
  pluginFsRaw,
  pluginShellStreamRaw,
} as const;

export type ContinuoApi = typeof api;

let rendererApiClaimed = false;

// v5 Phase 4.C:不要把全量 IPC bridge 挂在 plugin 同 realm 的全局对象上。
// renderer main-app.ts(init)启动最早调用 captureLmApi() 领取一次完整 api 并缓存到
// module-local;用户插件加载发生在之后,再次 claim 只能得到 null。
contextBridge.exposeInMainWorld('__lmApi', {
  claimRendererApi: (): ContinuoApi | null => {
    if (rendererApiClaimed) return null;
    rendererApiClaimed = true;
    return api;
  },
});

// E2E 模式标志:preload 读 process.env.CONTINUO_E2E === '1' 后 expose,
// renderer main-app.ts 看到 → 挂 testing helpers 到 window.__continuoTest.
// 非 e2e 环境完全不存在,无副作用.
if (process.env['CONTINUO_E2E'] === '1') {
  contextBridge.exposeInMainWorld('__continuoE2E', true);
}
