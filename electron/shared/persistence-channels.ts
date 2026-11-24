// layout / explorer 持久化与窗口 id 的 IPC 通道名。main / preload 两侧 import 同一份
// (此前两侧各写字符串字面量,是唯一没有共享常量的通道族)。

export const LAYOUT_CHANNELS = {
  // invoke(renderer → main)
  READ: 'layout:read',
  WRITE: 'layout:write',
  // 关窗 / 退出握手:main → renderer 请求落盘,renderer → main 回执
  FLUSH_REQUEST: 'layout:flush-request',
  FLUSH_ACK: 'layout:flush-ack',
  // renderer → main:已订阅 flush 请求(DockShell 挂载完成)。main 只对上报过的窗口发请求并等回执。
  FLUSH_READY: 'layout:flush-ready',
  // renderer → main:本窗口关窗会丢的脏 tab 状态 `{ dirty, untitled, ids, untitledIds }`(变化时上报;形态见 parseDirtyState)。main 据此在关窗 /
  // 退出前弹「是否保存」确认;选保存时 FLUSH_REQUEST 带 `save: true`(不保存带 `discard: true`),FLUSH_ACK
  // 第二参带 `{ requestId, saveFailed, remaining?, state? }`(缺 requestId 的回执不结算;remaining:全部 flush 后仍有未保存改动,main 中止关闭)。
  DIRTY_STATE: 'layout:dirty-state',
} as const;

/**
 * 关窗脏态(renderer 经 DIRTY_STATE 上报、FLUSH_ACK 回执里的 remaining / state;main 经 parseDirtyState 运行时校验)。
 * main / preload / renderer 三处共用这一份形态。
 */
export interface DirtyState {
  /** 关窗会丢的脏 tab 数(含 untitled)。 */
  readonly dirty: number;
  /** 其中 untitled 草稿数(无路径,MVP 不支持另存为,「保存」时跳过)。 */
  readonly untitled: number;
  /**
   * 脏 tab 的身份 `${tabId}#${变脏代际}`(tabId:file tab = 路径;untitled = 其 id)。main 按身份比较「本轮已接受」
   * 的范围(复审:只比数量会被同数量替换绕过;只比 tab id 会被「保存后再编辑同一文件」绕过)。
   */
  readonly ids: readonly string[];
  /** 其中 untitled 的 id(⊆ ids)。 */
  readonly untitledIds: readonly string[];
  /**
   * 未计入 ids、依赖关窗 flush 才能落盘的脏 .md(autosave 开启的活动 tab;非空才有)。终审 P1:读盘挂起的网络卷上
   * flush 可能超时,未弹框的关闭此时不能放行(否则丢编辑);为空时超时照常放行(renderer 卡死也能关窗)。
   */
  readonly pendingAutoSave?: readonly string[];
}

/** FLUSH_REQUEST(main → renderer)的 payload。 */
export interface FlushRequestPayload {
  readonly windowId: number;
  readonly save?: boolean;
  readonly discard?: boolean;
  /** save 时:确认框告知用户会丢弃的 untitled id(renderer 只放过这些 id)。 */
  readonly untitledIds?: string[];
  /** discard 时:确认时未列入框的待 autosave .md 身份(flush 后仍脏 → renderer 回执 remaining)。 */
  readonly pendingAutoSave?: string[];
  /** renderer 回执原样带回,main 只结算对应请求。 */
  readonly requestId?: number;
}

/**
 * FLUSH_ACK 第二参(renderer → main;main 经 parseFlushAck 运行时校验并归一化)。
 * remaining:全部 flush 后仍有未保存改动(未选「不保存」时)的计数,main 据此中止关闭 / 退出。
 * state:flush 后的最终脏态(始终携带,含空集合),main 以其更新脏态记账。
 */
export interface FlushAckPayload {
  readonly saveFailed?: boolean;
  /** FlushRequestPayload.requestId 原样带回。 */
  readonly requestId?: number;
  readonly remaining?: DirtyState;
  readonly state?: DirtyState;
}

export const EXPLORER_CHANNELS = {
  READ: 'explorer:read',
  WRITE: 'explorer:write',
} as const;

/** preload 启动时 sendSync 取本窗口 id。 */
export const WINDOW_ID_CHANNEL = 'window:id';
