// session_id 长度上限单一来源(E203)。session id 形如 `term-<uuid>`(~40 字符),256 是宽松防御天花板。
// 收口此前散落的副本(terminal.ipc.ts / terminal.store.ts 各有一份 SESSION_ID_MAX=256),并供 Continuo
// 侧 MCP terminal tools 的 bounded schema 用 —— 协议包 session_id 只 min(1) 无上限,1MB session_id 校验
// 通过后会进 Map/lookup 路径反复处理。main + renderer 共用(放 electron/shared)。
export const SESSION_ID_MAX = 256;
