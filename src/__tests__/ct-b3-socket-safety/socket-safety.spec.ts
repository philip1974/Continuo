// BDD: ct-b3-socket-safety
// Continuo stdio socket keeps its private hello/dispatch path while adopting
// CT-B1 framing and socket safety semantics.

import { chmod, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { createConnection, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { splitLines as splitNdjsonLines } from '@continuo-terminal/server-node';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

vi.mock('electron', () => ({
  BrowserWindow: {
    fromId: vi.fn(() => ({
      isDestroyed: () => false,
    })),
    getAllWindows: vi.fn(() => []),
  },
}));

import {
  createStdioSocketServer,
  type StdioSocketServer,
} from '../../../electron/main/services/mcp-stdio-server.service';
import {
  _resetForTest,
  buildClaudeAddCommand,
  getStdioConfig,
  setStdioConfig,
} from '../../../electron/main/services/mcp-stdio-config.service';
import type {
  AnyMcpTool,
  McpCallCtx,
  ServerInfo,
} from '../../../electron/main/services/mcp-host.service';

const serverInfo: ServerInfo = {
  name: 'ct-b3-test',
  version: '0',
  protocolVersion: '2024-11-05',
};

async function makeSocketPath(): Promise<{ dir: string; socketPath: string }> {
  const dir = await mkdtemp(path.join(tmpdir(), 'ct-b3-test-'));
  return { dir, socketPath: path.join(dir, 'mcp.sock') };
}

function ownerTool(): AnyMcpTool {
  return {
    name: 'owner',
    description: 'return owner window id',
    jsonSchema: { type: 'object', additionalProperties: false },
    inputSchema: z.object({}).strict(),
    run: (_input: unknown, ctx: McpCallCtx) => ({ ownerWindowId: ctx.ownerWindowId }),
  };
}

function waitForConnect(socket: Socket): Promise<void> {
  return new Promise((resolve, reject) => {
    socket.once('connect', () => resolve());
    socket.once('error', reject);
  });
}

function waitForLine(socket: Socket): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let buffer = '';
    const timer = setTimeout(() => reject(new Error('timed out waiting for socket response')), 2000);
    socket.setEncoding('utf8');
    socket.on('data', (chunk) => {
      buffer += chunk;
      const idx = buffer.indexOf('\n');
      if (idx < 0) return;
      clearTimeout(timer);
      resolve(JSON.parse(buffer.slice(0, idx)) as Record<string, unknown>);
    });
    socket.once('error', reject);
  });
}

describe('CT-B3 stdio socket safety', { timeout: 30_000 }, () => {
  const dirs: string[] = [];
  const servers: StdioSocketServer[] = [];

  afterEach(async () => {
    _resetForTest();
    vi.restoreAllMocks();
    await Promise.all(servers.splice(0).map((server) => server.close().catch(() => {})));
    await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  async function start(socketPath: string, options: Partial<Parameters<typeof createStdioSocketServer>[0]> = {}) {
    const server = await createStdioSocketServer({
      socketPath,
      tools: new Map(),
      serverInfo,
      resolveWindowId: () => null,
      ...options,
    });
    servers.push(server);
    return server;
  }

  it('creates private parent and socket modes', async () => {
    const { dir, socketPath } = await makeSocketPath();
    dirs.push(dir);

    await start(socketPath);

    expect((await stat(dir)).mode & 0o777).toBe(0o700);
    expect((await stat(socketPath)).mode & 0o777).toBe(0o600);
  });

  it('throws when a non-empty regular file exists at the socket path', async () => {
    const { dir, socketPath } = await makeSocketPath();
    dirs.push(dir);
    await writeFile(socketPath, 'not a socket');

    await expect(start(socketPath)).rejects.toThrow(/not a stale socket/);
  });

  it('uses the CT-B1 splitter with SDK CRLF parity', () => {
    const r = splitNdjsonLines('', 'a\r\nb\r\n');

    expect(r).toEqual({ buffer: '', lines: ['a', 'b'] });
  });

  it('auto-chmods an existing group/world-accessible parent directory and warns', async () => {
    const { dir, socketPath } = await makeSocketPath();
    dirs.push(dir);
    await chmod(dir, 0o755);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await start(socketPath);

    expect((await stat(dir)).mode & 0o777).toBe(0o700);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('0755 -> 0700'));
  });

  it('unlinks a zero-size regular file at the socket path and warns', async () => {
    const { dir, socketPath } = await makeSocketPath();
    dirs.push(dir);
    await writeFile(socketPath, '');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await start(socketPath);

    expect((await stat(socketPath)).mode & 0o777).toBe(0o600);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('zero-size stale socket placeholder'));
  });

  it('binds _continuo/hello before generic notification discard', async () => {
    const { dir, socketPath } = await makeSocketPath();
    dirs.push(dir);
    const resolveWindowId = vi.fn((token: string) => (token === 'tok-42' ? 42 : null));
    await start(socketPath, {
      tools: new Map([['owner', ownerTool()]]),
      resolveWindowId,
    });
    const socket = createConnection(socketPath);
    await waitForConnect(socket);

    socket.write(
      JSON.stringify({
        jsonrpc: '2.0',
        method: '_continuo/hello',
        params: { windowId: 42, token: 'tok-42' },
      }) + '\n',
    );
    socket.write(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'owner', arguments: {} },
      }) + '\n',
    );

    const response = await waitForLine(socket);
    socket.destroy();
    const result = response['result'] as { content: Array<{ text: string }> };
    const firstContent = result.content[0];
    expect(firstContent).toBeDefined();
    expect(JSON.parse(firstContent!.text)).toEqual({ ownerWindowId: 42 });
    expect(resolveWindowId).toHaveBeenCalledWith('tok-42');
  });

  it('buildClaudeAddCommand byte-exact format (CT-B3 UX invariant, source-side)', () => {
    // Byte-exact pin on the SOURCE-side helper that builds the "复制 MCP 配置"
    // content. Format must remain identical across CT-B3 (and future) commits
    // so users do NOT need to re-configure Claude Code MCP after Continuo
    // upgrades. Replaces manual UX verify (dev build → StatusBar 按钮 → paste
    // clipboard → diff) per ADR 0006 CT-B3 plan-v2 P1-1 byte-compat requirement.
    expect(buildClaudeAddCommand('/p')).toBe(
      'claude mcp add --transport stdio continuo -- /p',
    );
    expect(buildClaudeAddCommand('/Applications/Continuo.app/Contents/Resources/continuo-mcp-stdio.mjs')).toBe(
      'claude mcp add --transport stdio continuo -- /Applications/Continuo.app/Contents/Resources/continuo-mcp-stdio.mjs',
    );
  });

  it('preserves getStdioConfig claude add command byte-exact format (round-trip)', () => {
    // Byte-exact verify of the round-trip: setStdioConfig → getStdioConfig
    // returns identical bytes. Combined with buildClaudeAddCommand test above,
    // this pins both source construction AND consumer-visible content.
    const cliPath = '/Applications/Continuo.app/Contents/Resources/continuo-mcp-stdio.mjs';
    const expectedCommand = `claude mcp add --transport stdio continuo -- ${cliPath}`;
    const socketPath = '/Users/example/Library/Application Support/Continuo/mcp.sock';

    setStdioConfig({
      available: true,
      cliPath,
      socketPath,
      claudeAddCommand: expectedCommand,
    });

    const config = getStdioConfig();

    // Byte-exact assertions (no whitespace / flag / quote drift allowed)
    expect(config.available).toBe(true);
    expect(config.cliPath).toBe(cliPath);
    expect(config.socketPath).toBe(socketPath);
    expect(config.claudeAddCommand).toBe(expectedCommand);
    // Format anchored explicitly so future regressions are caught
    expect(config.claudeAddCommand).toBe(
      'claude mcp add --transport stdio continuo -- /Applications/Continuo.app/Contents/Resources/continuo-mcp-stdio.mjs',
    );
  });
});
