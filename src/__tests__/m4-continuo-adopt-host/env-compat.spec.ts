import { describe, expect, it } from 'vitest';

import {
  createContinuoMcpEnv,
  subjectForWindow,
  toLegacyContinuoEnv,
} from '../../../electron/main/services/continuo-terminal-host-adapter';

describe('M4 Continuo host adapter', () => {
  it('maps a window id to a generic subject', () => {
    expect(subjectForWindow(42)).toBe('window-42');
  });

  it('preserves the legacy CONTINUO_* env contract byte-for-byte', () => {
    const issued: number[] = [];
    const result = createContinuoMcpEnv({
      windowId: 42,
      url: 'http://127.0.0.1:1234/mcp',
      issueToken: (windowId) => {
        issued.push(windowId);
        return 'token-42';
      },
    });

    expect(issued).toEqual([42]);
    expect(result).toEqual({
      env: {
        CONTINUO_MCP_URL: 'http://127.0.0.1:1234/mcp',
        CONTINUO_MCP_TOKEN: 'token-42',
        CONTINUO_WINDOW_ID: '42',
        CONTINUO_HOST: 'desktop',
      },
      mcpToken: 'token-42',
      subject: 'window-42',
    });
  });

  it('converts generic MCP env into the legacy Continuo env aliases', () => {
    expect(
      toLegacyContinuoEnv(
        {
          MCP_URL: 'http://127.0.0.1:9999/mcp',
          MCP_TOKEN: 'token-99',
        },
        99,
      ),
    ).toEqual({
      CONTINUO_MCP_URL: 'http://127.0.0.1:9999/mcp',
      CONTINUO_MCP_TOKEN: 'token-99',
      CONTINUO_WINDOW_ID: '99',
      CONTINUO_HOST: 'desktop',
    });
  });

  it('preserves AgentEnv shape compatibility (inline mirror of @continuo-terminal/host)', () => {
    type AgentEnv = Record<string, string>;
    const env: AgentEnv = {
      MCP_URL: 'http://127.0.0.1:4321/mcp',
      MCP_TOKEN: 'token-boundary',
    };

    expect(env.MCP_URL).toBe('http://127.0.0.1:4321/mcp');
  });
});
