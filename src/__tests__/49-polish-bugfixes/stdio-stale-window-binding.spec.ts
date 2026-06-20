// topic 49 第八轮 · P2-W:stdio MCP 连接绑定的窗口关闭后不永久失效。
//
// 根因:socketCtx 在 `_continuo/hello` 时把 socket 一次性绑到某 windowId,窗口
// 关闭清理(revokeWindowTokens/cancelByWindow)不触碰 socketCtx,而 proxy 进程
// 没退、socket 仍连着。旧 dispatch 直接用 socketCtx.get(sock) 的 windowId 构造
// ctx —— 该窗口已死时 ctx 仍非 null,跳过"fallback 到活窗"分支 → 所有 tools/call
// 撞 TERMINAL_NO_WINDOW/SESSION_NOT_FOUND,该 proxy 连接对所有工具永久损坏
// (即使别的窗口活着),直到 proxy 重连。
//
// 修复:resolveStdioCallOwnerWindow 在每次 dispatch 校验绑定窗口存活,死则返回
// null → 走 fallback 到当前活窗。

import { describe, it, expect } from 'vitest';
import { resolveStdioCallOwnerWindow } from '../../../electron/main/services/mcp-stdio-server.service';

describe('topic49 P2-W · stdio 绑定窗口死后不卡死', () => {
  it('绑定窗口存活 → 返回该 windowId', () => {
    const r = resolveStdioCallOwnerWindow(7, { isWindowAlive: (id) => id === 7 });
    expect(r).toBe(7);
  });

  it('绑定窗口已关闭 → 返回 null(交给 fallback)', () => {
    const r = resolveStdioCallOwnerWindow(7, { isWindowAlive: () => false });
    expect(r).toBeNull();
  });

  it('未绑定(undefined,无 hello 的外部 proxy)→ 返回 null', () => {
    let probed = false;
    const r = resolveStdioCallOwnerWindow(undefined, {
      isWindowAlive: () => {
        probed = true;
        return true;
      },
    });
    expect(r).toBeNull();
    // 未绑定时不应去探测窗口存活
    expect(probed).toBe(false);
  });

  it('windowId=0(合法 id)且存活 → 返回 0,不被当作 falsy 丢弃', () => {
    const r = resolveStdioCallOwnerWindow(0, { isWindowAlive: (id) => id === 0 });
    expect(r).toBe(0);
  });
});
