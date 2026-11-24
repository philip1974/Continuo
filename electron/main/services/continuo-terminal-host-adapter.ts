import type { AgentEnv } from '@continuo-terminal/host';
import { CONTINUO_MCP_TOKEN_ENV } from '../lib/continuo-env-keys';

export interface ContinuoMcpEnvInput {
  readonly windowId: number;
  readonly url: string;
  readonly issueToken: (windowId: number) => string;
  /**
   * stdio MCP 端点(Windows 每次启动随机的命名管道名)。给出时注入 CONTINUO_MCP_SOCKET,终端里的 proxy
   * 直接连本实例,不靠可预测名 / 发现文件。
   */
  readonly stdioSocketPath?: string;
}

export interface ContinuoMcpEnvResult {
  readonly env: Record<string, string>;
  readonly mcpToken: string;
}

/**
 * M4 downscoped adapter (design review decision: proceed with downscope):
 * bridge generic host terms to Continuo's legacy env contract without
 * replacing createMcpHost or its window-scoped token/auth behavior.
 * (调用方身份由 MCP token / stdio 连接自身决定,这里不另产出 subject。)
 */
export function toLegacyContinuoEnv(
  generic: Pick<AgentEnv, 'MCP_URL' | 'MCP_TOKEN'>,
  windowId: number,
): Record<string, string> {
  return {
    CONTINUO_MCP_URL: generic.MCP_URL,
    [CONTINUO_MCP_TOKEN_ENV]: generic.MCP_TOKEN,
    CONTINUO_WINDOW_ID: String(windowId),
    CONTINUO_HOST: 'desktop',
  };
}

export function createContinuoMcpEnv({
  windowId,
  url,
  issueToken,
  stdioSocketPath,
}: ContinuoMcpEnvInput): ContinuoMcpEnvResult {
  const mcpToken = issueToken(windowId);
  const env = toLegacyContinuoEnv(
    {
      MCP_URL: url,
      MCP_TOKEN: mcpToken,
    },
    windowId,
  );
  return {
    env: stdioSocketPath === undefined ? env : { ...env, CONTINUO_MCP_SOCKET: stdioSocketPath },
    mcpToken,
  };
}
