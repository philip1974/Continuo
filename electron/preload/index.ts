import { contextBridge, ipcRenderer } from 'electron';
import type { IpcResult } from '../shared/ipc-result';
import type { FileEntry } from '../shared/fs-entry';
import { FS_CHANNELS } from '../shared/fs-channels';
import { TERMINAL_CHANNELS } from '../shared/terminal-channels';
import {
  PLUGINS_CHANNELS,
  type IpcPermissionsMap,
  type IpcPluginDir,
} from '../shared/plugins-channels';
import {
  SHELL_CHANNELS,
  type IpcShellExecInput,
  type IpcShellExecResult,
} from '../shared/shell-channels';
import {
  AGENT_AUTH_CHANNELS,
  type AgentAuthRequestPayload,
  type AgentAuthDecision,
} from '../shared/agent-auth-channels';
import {
  MCP_CHANNELS,
  type StdioMcpConfig,
} from '../shared/mcp-channels';

// terminal create 入参的轻量类型(与 main 端 zod schema 对齐)
// export 是为了 ContinuoApi 跨 module 引用时 TS 能 name 这些类型
// (lib/lm-api.ts 暴露 coApi: ContinuoApi 时需要)
export interface TerminalCreateOptions {
  readonly shell?: string;
  readonly args?: ReadonlyArray<string>;
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string>>;
  // P1 Agent Terminal MCP:metadata 字段
  readonly name?: string;
  readonly originHint?: 'user' | 'agent';
  readonly agentLabel?: string;
}

export interface TerminalExitPayload {
  readonly exitCode: number | undefined;
  readonly signal: number | undefined;
}

/** main 推过来的 session 形态;renderer cast 为 TerminalSession. */
export interface PreloadTerminalSession {
  readonly id: string;
  readonly title: string;
  readonly cwd: string;
  readonly originHint: 'user' | 'agent';
  readonly agentLabel?: string;
  readonly createdAt: number;
  readonly exitCode: number | null;
}

// 给 fs 入参用的轻量 ListDirOptions —— 与 main 端 zod schema 对齐字段
export interface PreloadListDirOptions {
  readonly maxDepth?: number;
  readonly exclude?: ReadonlyArray<string>;
  readonly followSymlinks?: boolean;
}

// 所有跨 IPC 的方法都返回 IpcResult<T>(详见 ADR-010),
// renderer 拿到后按 ok 分流,不再 throw。
const api = {
  ping: () => 'pong' as const,
  layout: {
    read: (): Promise<IpcResult<unknown | null>> =>
      ipcRenderer.invoke('layout:read'),
    write: (json: unknown): Promise<IpcResult<void>> =>
      ipcRenderer.invoke('layout:write', json),
  },
  popout: {
    open: (panelId: string): Promise<IpcResult<unknown>> =>
      ipcRenderer.invoke('popout:open', { panelId }),
    onClosed: (cb: (panelId: string) => void): (() => void) => {
      const listener = (_: unknown, panelId: string) => cb(panelId);
      ipcRenderer.on('popout:closed', listener);
      return () => ipcRenderer.off('popout:closed', listener);
    },
  },
  explorer: {
    // ExplorerPayload 形态由 src/lib/persist/explorer-persist 保证;preload 透传 unknown
    read: (): Promise<IpcResult<unknown | null>> =>
      ipcRenderer.invoke('explorer:read'),
    write: (json: unknown): Promise<IpcResult<void>> =>
      ipcRenderer.invoke('explorer:write', json),
  },
  fs: {
    listDir: (
      path: string,
      options?: PreloadListDirOptions,
    ): Promise<IpcResult<ReadonlyArray<FileEntry>>> =>
      ipcRenderer.invoke(FS_CHANNELS.LIST_DIR, { path, options }),
    readFile: (path: string): Promise<IpcResult<string>> =>
      ipcRenderer.invoke(FS_CHANNELS.READ_FILE, { path }),
    writeFile: (path: string, content: string): Promise<IpcResult<void>> =>
      ipcRenderer.invoke(FS_CHANNELS.WRITE_FILE, { path, content }),
    writeBinary: (path: string, content: Uint8Array): Promise<IpcResult<void>> =>
      ipcRenderer.invoke(FS_CHANNELS.WRITE_BINARY, { path, content }),
    rename: (path: string, newName: string): Promise<IpcResult<string>> =>
      ipcRenderer.invoke(FS_CHANNELS.RENAME, { path, newName }),
    remove: (path: string): Promise<IpcResult<void>> =>
      ipcRenderer.invoke(FS_CHANNELS.REMOVE, { path }),
    createFile: (dir: string, name: string): Promise<IpcResult<string>> =>
      ipcRenderer.invoke(FS_CHANNELS.CREATE_FILE, { dir, name }),
    createDir: (parent: string, name: string): Promise<IpcResult<string>> =>
      ipcRenderer.invoke(FS_CHANNELS.CREATE_DIR, { parent, name }),
    trash: (path: string): Promise<IpcResult<void>> =>
      ipcRenderer.invoke(FS_CHANNELS.TRASH, { path }),
    selectDirectory: (): Promise<IpcResult<string | null>> =>
      ipcRenderer.invoke(FS_CHANNELS.SELECT_DIRECTORY),
    watchDir: (path: string): Promise<IpcResult<void>> =>
      ipcRenderer.invoke(FS_CHANNELS.WATCH, { path }),
    unwatchDir: (path: string): Promise<IpcResult<void>> =>
      ipcRenderer.invoke(FS_CHANNELS.UNWATCH, { path }),
    /** 订阅目录变更 push 事件;返回 unsubscribe. */
    onDirChanged: (cb: (path: string) => void): (() => void) => {
      const listener = (_: unknown, payload: { path: string }) =>
        cb(payload.path);
      ipcRenderer.on(FS_CHANNELS.DIR_CHANGED, listener);
      return () => ipcRenderer.off(FS_CHANNELS.DIR_CHANGED, listener);
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
    interrupt: (id: string): Promise<IpcResult<void>> =>
      ipcRenderer.invoke(TERMINAL_CHANNELS.INTERRUPT, { id }),
    kill: (id: string): Promise<IpcResult<void>> =>
      ipcRenderer.invoke(TERMINAL_CHANNELS.KILL, { id }),
    destroy: (id: string): Promise<IpcResult<void>> =>
      ipcRenderer.invoke(TERMINAL_CHANNELS.DESTROY, { id }),
    // P1 Agent Terminal MCP:session metadata 真相源在 main
    listSessions: (): Promise<
      IpcResult<{ sessions: ReadonlyArray<PreloadTerminalSession> }>
    > => ipcRenderer.invoke(TERMINAL_CHANNELS.LIST_SESSIONS, {}),
    remove: (id: string): Promise<IpcResult<void>> =>
      ipcRenderer.invoke(TERMINAL_CHANNELS.REMOVE, { id }),
    /** 订阅 main 推的 snapshot;返回 unsubscribe. */
    onSessionsChanged: (
      cb: (sessions: ReadonlyArray<PreloadTerminalSession>) => void,
    ): (() => void) => {
      const listener = (
        _: unknown,
        sessions: ReadonlyArray<PreloadTerminalSession>,
      ) => cb(sessions);
      ipcRenderer.on(TERMINAL_CHANNELS.SESSIONS_CHANGED, listener);
      return () => ipcRenderer.off(TERMINAL_CHANNELS.SESSIONS_CHANGED, listener);
    },
    /** 订阅 stdout 字节流;返回 unsubscribe. */
    onData: (cb: (id: string, data: string) => void): (() => void) => {
      const listener = (_: unknown, id: string, data: string) => cb(id, data);
      ipcRenderer.on(TERMINAL_CHANNELS.DATA, listener);
      return () => ipcRenderer.off(TERMINAL_CHANNELS.DATA, listener);
    },
    onExit: (
      cb: (id: string, payload: TerminalExitPayload) => void,
    ): (() => void) => {
      const listener = (
        _: unknown,
        id: string,
        payload: TerminalExitPayload,
      ) => cb(id, payload);
      ipcRenderer.on(TERMINAL_CHANNELS.EXIT, listener);
      return () => ipcRenderer.off(TERMINAL_CHANNELS.EXIT, listener);
    },
    onOverflow: (cb: (id: string) => void): (() => void) => {
      const listener = (_: unknown, id: string) => cb(id);
      ipcRenderer.on(TERMINAL_CHANNELS.OVERFLOW, listener);
      return () => ipcRenderer.off(TERMINAL_CHANNELS.OVERFLOW, listener);
    },
    onOverflowRecovered: (cb: (id: string) => void): (() => void) => {
      const listener = (_: unknown, id: string) => cb(id);
      ipcRenderer.on(TERMINAL_CHANNELS.OVERFLOW_RECOVERED, listener);
      return () => ipcRenderer.off(TERMINAL_CHANNELS.OVERFLOW_RECOVERED, listener);
    },
  },
  plugins: {
    listDirs: (): Promise<IpcResult<readonly IpcPluginDir[]>> =>
      ipcRenderer.invoke(PLUGINS_CHANNELS.LIST_DIRS),
    readEnabled: (): Promise<IpcResult<readonly string[]>> =>
      ipcRenderer.invoke(PLUGINS_CHANNELS.READ_ENABLED),
    writeEnabled: (ids: readonly string[]): Promise<IpcResult<void>> =>
      ipcRenderer.invoke(PLUGINS_CHANNELS.WRITE_ENABLED, { ids }),
    readPermissions: (): Promise<IpcResult<IpcPermissionsMap>> =>
      ipcRenderer.invoke(PLUGINS_CHANNELS.READ_PERMISSIONS),
    writePermissions: (data: IpcPermissionsMap): Promise<IpcResult<void>> =>
      ipcRenderer.invoke(PLUGINS_CHANNELS.WRITE_PERMISSIONS, { data }),
    /** v4.3.1 订阅 plugin 文件 mtime 变化,返 unsubscribe. */
    onChanged: (cb: (id: string) => void): (() => void) => {
      const listener = (_: unknown, payload: { id: string }) => cb(payload.id);
      ipcRenderer.on(PLUGINS_CHANNELS.CHANGED, listener);
      return () => ipcRenderer.off(PLUGINS_CHANNELS.CHANGED, listener);
    },
    /** v4.4 订阅 co:// 外部唤起,返 unsubscribe. */
    onProtocolUrl: (cb: (url: string) => void): (() => void) => {
      const listener = (_: unknown, payload: { url: string }) => cb(payload.url);
      ipcRenderer.on(PLUGINS_CHANNELS.PROTOCOL_URL, listener);
      return () => ipcRenderer.off(PLUGINS_CHANNELS.PROTOCOL_URL, listener);
    },
    /** v4.5 从 git URL 安装插件,返回 manifest 元信息. */
    installFromGit: (
      url: string,
    ): Promise<
      IpcResult<{ id: string; name: string; version: string }>
    > => ipcRenderer.invoke(PLUGINS_CHANNELS.INSTALL_FROM_GIT, { url }),
    /** v4.6 卸载插件:rm -rf plugins/<id>/ + 清 _enabled / _permissions. */
    uninstall: (id: string): Promise<IpcResult<void>> =>
      ipcRenderer.invoke(PLUGINS_CHANNELS.UNINSTALL, { id }),
  },
  shell: {
    /** plugin app.shell.exec 后端:一次性 spawn + buffered + 超时. */
    exec: (input: IpcShellExecInput): Promise<IpcResult<IpcShellExecResult>> =>
      ipcRenderer.invoke(SHELL_CHANNELS.EXEC, input),
  },
  agentAuth: {
    /** 订阅 main 推的授权请求(MCP tool 调时);返回 unsubscribe. */
    onRequest: (
      cb: (payload: AgentAuthRequestPayload) => void,
    ): (() => void) => {
      const listener = (_: unknown, payload: AgentAuthRequestPayload) =>
        cb(payload);
      ipcRenderer.on(AGENT_AUTH_CHANNELS.REQUEST, listener);
      return () => ipcRenderer.off(AGENT_AUTH_CHANNELS.REQUEST, listener);
    },
    /** 用户决定后回应 main(对应 requestId). */
    respond: (
      requestId: string,
      decision: AgentAuthDecision,
    ): Promise<IpcResult<void>> =>
      ipcRenderer.invoke(AGENT_AUTH_CHANNELS.RESPOND, { requestId, decision }),
    /** 撤销 session 授权 + 终止全部 agent terminal(状态栏按钮触发). */
    revoke: (): Promise<IpcResult<{ killed: number; rotated: boolean }>> =>
      ipcRenderer.invoke(AGENT_AUTH_CHANNELS.REVOKE, {}),
  },
  mcp: {
    /** 拿当前 stdio MCP 配置(状态栏"复制 MCP 配置"按钮用). */
    getStdioConfig: (): Promise<IpcResult<StdioMcpConfig>> =>
      ipcRenderer.invoke(MCP_CHANNELS.GET_STDIO_CONFIG, {}),
  },
} as const;

export type ContinuoApi = typeof api;

// v5 Phase 4.B (refined):暴露名字改 `__lmApi` 而非 `api`。
// contextBridge 设置的属性 non-configurable 删不掉,但至少
// `window.api` 不存在,plugin 写 `window.api.fs.*` 直接 TypeError。
// 仍可通过 `window.__lmApi.*` 绕,见 doc/11 §Phase 4.B 残留说明。
contextBridge.exposeInMainWorld('__lmApi', api);
