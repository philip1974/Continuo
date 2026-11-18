// MCP host 的回收接线:HTTP session 释放 / 空闲驱逐的活跃资源判断 / 终端与窗口 token 吊销器。
//
// 从 index.ts 抽出(便于行为测试)。HTTP 调用方身份 = token(未带 Mcp-Session-Id)或 token + session id;
// 任一身份作废都要回收其名下的在途终端创建与 debug 会话,否则它们再无人能 disconnect(名额被占满、adapter 常驻)。
// session 身份统一由 host 在删除 session 时经 onHttpSessionReleased 逐个通知(带原因),吊销器只需处理 token 本身。

import type {
  HttpSessionReleaseCause,
  McpHost,
  McpHostOptions,
  McpRevokers,
} from './mcp-host.service';

export interface McpRevokerWiringDeps {
  readonly debugService: {
    killByController(controllerToken: string, reason: string): Promise<unknown>;
    listControllerTokens(): readonly string[];
  };
  readonly cancelAgentTerminalCreates: (callerSubject: string) => void;
  readonly hasAgentTerminalCreates: (callerSubject: string) => boolean;
  readonly hasLiveSessionForController: (callerSubject: string) => boolean;
}

export interface McpRevokerWiring {
  /** 传给 createMcpHost 的回调。 */
  readonly hostOptions: Required<Pick<McpHostOptions, 'onHttpSessionReleased' | 'hasLiveResources'>>;
  /** host 建好后传给 setMcpRevokers。 */
  revokers(host: Pick<McpHost, 'revokeToken' | 'revokeWindowTokens'>): McpRevokers;
}

export function createMcpRevokerWiring(deps: McpRevokerWiringDeps): McpRevokerWiring {
  const reclaim = (subject: string, reason: string, logCtx: string): void => {
    // 在途 create_session 同样失去调用方(同 stdio 断连 abort ctx.signal):取消,不留孤儿会话。
    deps.cancelAgentTerminalCreates(subject);
    void deps.debugService.killByController(subject, reason).catch((err) => {
      console.warn(`[debug] killByController failed on ${logCtx}`, err);
    });
  };

  return {
    hostOptions: {
      onHttpSessionReleased: (subject: string, cause: HttpSessionReleaseCause) => {
        switch (cause) {
          case 'closed': // DELETE 结束 / 空闲驱逐
            reclaim(subject, 'session-closed', 'http session release');
            return;
          case 'token-revoked': // 终端退出 / 创建回滚吊销终端专属 token
            reclaim(subject, 'terminal-exit', 'terminal token revoke');
            return;
          case 'window-revoked':
            // 窗口关闭:debug 会话由 killByOwner(window-closed) 按窗口回收,终端随窗口 kill,此处不重复。
            return;
        }
      },
      // 空闲驱逐跳过名下仍有 debug 会话 / 在途 launch、在途终端创建、其创建的存活终端的 session。
      hasLiveResources: (subject: string) =>
        deps.debugService.listControllerTokens().includes(subject) ||
        deps.hasAgentTerminalCreates(subject) ||
        deps.hasLiveSessionForController(subject),
    },
    revokers: (host) => ({
      byWindow: (windowId) => host.revokeWindowTokens(windowId),
      // byToken 只用于终端专属 token(终端退出 / 创建回滚):revokeToken 逐个释放其 session 身份(见
      // onHttpSessionReleased 'token-revoked'),这里再回收未带 session 的 token 身份本身。
      byToken: (token) => {
        host.revokeToken(token);
        reclaim(token, 'terminal-exit', 'terminal token revoke');
      },
    }),
  };
}
