// 启动/刷新黑屏诊断 IPC 通道。
// renderer 端通过 coApi.diagnostics.* / coApi.shell.openLogsDir / coApi.app.relaunch 调。
// renderer breadcrumb 仅做 append;读取 / 解析交给用户从日志目录手工查看。

export const DIAGNOSTICS_CHANNELS = {
  /** renderer 写一条 breadcrumb。payload 是 { event, ...任意字段 }. */
  BREADCRUMB: 'diagnostics:breadcrumb',
  /** 用系统文件管理器打开 userData/logs 目录(看门狗弹窗按钮触发). */
  OPEN_LOGS_DIR: 'diagnostics:openLogsDir',
  /** 触发 Electron app.relaunch + quit(看门狗弹窗按钮触发). */
  RELAUNCH: 'diagnostics:relaunch',
} as const;

/** breadcrumb 入参形态(对齐 main 端 lib/reload-breadcrumb BreadcrumbEntry). */
export interface IpcDiagnosticsBreadcrumbInput {
  readonly event: string;
  readonly [k: string]: unknown;
}
