/**
 * Inline mirror of @continuo-terminal/host AgentEnv shape.
 * M4 downscope (per OP5-FAIL recovery):Continuo cannot physically depend on
 * @continuo-terminal/host via pnpm file:due to workspace:* internal deps
 * (cross-workspace resolution). The adapter pattern + generic-terms boundary
 * still applies; future M4b can re-attempt physical dep when
 * @continuo-terminal/host publishes or resolves the dep model.
 */
type AgentEnv = Record<string, string>;

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
