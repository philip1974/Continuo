import { describe, expect, it, vi } from 'vitest';
import * as os from 'node:os';
import { z } from 'zod';
import {
  createInputSchema,
  makeCreateHandler,
  resolveTerminalCwd,
} from '../../../electron/main/ipc/terminal.ipc';
import { processIpcCall } from '../../../electron/main/safe-handle';
import { makeCreateSessionTool } from '../../../electron/main/services/mcp-tools-terminal';
import { dispatchRpc } from '../../../electron/main/services/mcp-host.service';

const trustedFrame = { url: 'file:///renderer/index.html' };
const trusted = () => true;
const ctx = { ownerWindowId: 42 };
const serverInfo = {
  name: 'continuo-test',
  version: '0.0.0',
  protocolVersion: '2024-11-05',
};

function unresolvedError(message = 'cwd'): Error & { code: string } {
  return Object.assign(new Error(message), {
    code: 'TERMINAL_CWD_UNRESOLVED',
  });
}

describe('window-workspace-roots-map: terminal cwd fallback errors', () => {
  it('T12: resolveTerminalCwd(undefined) throws TERMINAL_CWD_UNRESOLVED', () => {
    expect(() => resolveTerminalCwd(undefined)).toThrowError(
      /cwd unresolved/i,
    );
    try {
      resolveTerminalCwd(undefined);
    } catch (err) {
      expect(err).toMatchObject({ code: 'TERMINAL_CWD_UNRESOLVED' });
    }
  });

  it('T13: resolveTerminalCwd(invalid path) throws TERMINAL_CWD_UNRESOLVED', () => {
    expect(() =>
      resolveTerminalCwd('/this/does/not/exist/xyz123'),
    ).toThrowError(/cwd invalid/i);
    try {
      resolveTerminalCwd('/this/does/not/exist/xyz123');
    } catch (err) {
      expect(err).toMatchObject({ code: 'TERMINAL_CWD_UNRESOLVED' });
    }
  });

  it('T14: resolveTerminalCwd(valid absolute dir) returns it', () => {
    expect(resolveTerminalCwd(os.tmpdir())).toBe(os.tmpdir());
  });

  it('T15: makeCreateHandler preserves resolveCwd throw code', async () => {
    const resolveCwd = vi.fn(() => {
      throw unresolvedError('test');
    });
    const handler = makeCreateHandler({ resolveCwd });

    await expect(
      handler({}, { id: 42 } as unknown as import('electron').BrowserWindow),
    ).rejects.toMatchObject({ code: 'TERMINAL_CWD_UNRESOLVED' });
    expect(resolveCwd).toHaveBeenCalledOnce();
  });

  it('T18: processIpcCall envelope preserves coded handler failures', async () => {
    const result = await processIpcCall(
      z.object({}).strict(),
      () => {
        throw unresolvedError('terminal cwd unresolved');
      },
      {},
      trustedFrame,
      trusted,
    );

    expect(result).toMatchObject({
      ok: false,
      code: 'TERMINAL_CWD_UNRESOLVED',
    });
    expect((result as { message?: string }).message).toEqual(expect.any(String));
  });

  it('T25: makeCreateSessionTool rejects with the createSession code preserved', async () => {
    const tool = makeCreateSessionTool({
      ensureAuthorized: vi.fn(async (): Promise<'session'> => 'session'),
      createSession: vi.fn(async () => {
        throw unresolvedError('cwd');
      }),
    });

    await expect(tool.run({}, ctx)).rejects.toMatchObject({
      code: 'TERMINAL_CWD_UNRESOLVED',
    });
  });

  it('T26: dispatchRpc tools/call returns JSON-RPC error data.code for coded tool failures', async () => {
    const tool = makeCreateSessionTool({
      ensureAuthorized: vi.fn(async (): Promise<'session'> => 'session'),
      createSession: vi.fn(async () => {
        throw unresolvedError('cwd');
      }),
    });

    const result = await dispatchRpc(
      {
        id: 1,
        method: 'tools/call',
        params: {
          name: tool.name,
          arguments: {},
        },
      },
      new Map([[tool.name, tool]]),
      serverInfo,
      ctx,
    );

    expect(result).toEqual({
      error: {
        code: -32603,
        message: 'cwd',
        data: { code: 'TERMINAL_CWD_UNRESOLVED' },
      },
    });
  });

  it('T34: empty cwd/workspaceRoot fail schema before create handler runs', async () => {
    const handler = makeCreateHandler({
      resolveCwd: vi.fn(() => os.tmpdir()),
    });

    const emptyCwd = await processIpcCall(
      createInputSchema,
      (input) =>
        handler(
          input,
          { id: 42 } as unknown as import('electron').BrowserWindow,
        ),
      { cwd: '' },
      trustedFrame,
      trusted,
    );
    const emptyWorkspaceRoot = await processIpcCall(
      createInputSchema,
      (input) =>
        handler(
          input,
          { id: 42 } as unknown as import('electron').BrowserWindow,
        ),
      { workspaceRoot: '' },
      trustedFrame,
      trusted,
    );

    expect(emptyCwd).toMatchObject({ ok: false, code: 'IPC_BAD_INPUT' });
    expect(emptyWorkspaceRoot).toMatchObject({
      ok: false,
      code: 'IPC_BAD_INPUT',
    });
  });
});
