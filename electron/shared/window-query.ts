// 窗口启动 URL 的 query 协议(单一来源):main 写入(spike-gate.buildRendererQuery、popoutUrl 校验),
// renderer 读取(initial-workspace、popout-mode、main.tsx 的 spike 路由)。只含常量,无依赖 ——
// renderer 最早入口(thin-entry)也会引用。

export const WINDOW_QUERY = {
  /** dockview popout 子窗口标记(值为 WINDOW_QUERY_FLAG_ON)。 */
  POPOUT: 'popout',
  /** 新主窗口要打开的目录。 */
  WORKSPACE: 'workspace',
  /** 窗口在 explorer.json 中的稳定段键。 */
  WINDOW_SEQ: 'windowSeq',
  /** 用户显式打开(跳过持久化恢复;值为 WINDOW_QUERY_FLAG_ON)。 */
  FRESH: 'fresh',
  /** spike 入口路由。 */
  SPIKE: 'spike',
} as const;

/** 布尔型 query(popout / fresh)的「开」取值。 */
export const WINDOW_QUERY_FLAG_ON = '1';
