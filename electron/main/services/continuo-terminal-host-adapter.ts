import type { AgentEnv } from '@continuo-terminal/host';

export interface ContinuoMcpEnvInput {
  readonly windowId: number;
  readonly url: string;
  readonly issueToken: (windowId: number) => string;
}

export interface ContinuoMcpEnvResult {
  readonly env: Record<string, string>;
  readonly mcpToken: string;
  readonly subject: string;
}

/**
 * M4 downscoped adapter per codex advisory PROCEED-WITH-DOWNSCOPE:
 * bridge generic host terms to Continuo's legacy env contract without
 * replacing createMcpHost or its window-scoped token/auth behavior.
 */
export function subjectForWindow(windowId: number): string {
  return `window-${windowId}`;
}

export function toLegacyContinuoEnv(
  generic: Pick<AgentEnv, 'MCP_URL' | 'MCP_TOKEN'>,
  windowId: number,
): Record<string, string> {
  return {
    CONTINUO_MCP_URL: generic.MCP_URL,
    CONTINUO_MCP_TOKEN: generic.MCP_TOKEN,
    CONTINUO_WINDOW_ID: String(windowId),
    CONTINUO_HOST: 'desktop',
  };
}

export function createContinuoMcpEnv({
  windowId,
  url,
  issueToken,
}: ContinuoMcpEnvInput): ContinuoMcpEnvResult {
  const mcpToken = issueToken(windowId);
  return {
    env: toLegacyContinuoEnv(
      {
        MCP_URL: url,
        MCP_TOKEN: mcpToken,
      },
      windowId,
    ),
    mcpToken,
    subject: subjectForWindow(windowId),
  };
}
