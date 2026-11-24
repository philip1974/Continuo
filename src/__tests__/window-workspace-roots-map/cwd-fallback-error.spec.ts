import { describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
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
  // 性能:cwd 校验走单次异步 fs.promises.stat,不在 Electron main 同步 existsSync+statSync(网络盘 /
  // 失联挂载点会同步卡住所有窗口与 IPC)。语义不变:缺省 / 不存在 / 非目录均 TERMINAL_CWD_UNRESOLVED。
  it('T12: resolveTerminalCwd(undefined) rejects TERMINAL_CWD_UNRESOLVED', async () => {
    await expect(resolveTerminalCwd(undefined)).rejects.toThrowError(/cwd unresolved/i);
    await expect(resolveTerminalCwd(undefined)).rejects.toMatchObject({
      code: 'TERMINAL_CWD_UNRESOLVED',
    });
  });

  it('T13: resolveTerminalCwd(invalid path) rejects TERMINAL_CWD_UNRESOLVED', async () => {
    const p = resolveTerminalCwd('/this/does/not/exist/xyz123');
    await expect(p).rejects.toThrowError(/cwd invalid/i);
    await expect(p).rejects.toMatchObject({ code: 'TERMINAL_CWD_UNRESOLVED' });
  });

  it('T13b: resolveTerminalCwd(existing file, not dir) rejects TERMINAL_CWD_UNRESOLVED', async () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cwd-')), 'f.txt');
    fs.writeFileSync(file, 'x');
    await expect(resolveTerminalCwd(file)).rejects.toMatchObject({
      code: 'TERMINAL_CWD_UNRESOLVED',
    });
  });

  // 目录判定 stat 经全局闸(lib/dir-stat-gate,与 open-file / 新窗口打开文件夹共用;闸行为由 dir-stat-gate.test 覆盖)。
  it('T14a: resolveTerminalCwd 经 statDirGated,不直接 fs.promises.stat', () => {
    const src = fs.readFileSync(path.join(process.cwd(), 'electron/main/ipc/terminal.ipc.ts'), 'utf8');
    const start = src.indexOf('export async function resolveTerminalCwd(');
    const body = src.slice(start, src.indexOf('\n}\n', start));
    expect(start).toBeGreaterThan(0);
    expect(body).toMatch(/await statDirGated\(cwdHint\)/);
    expect(body).not.toMatch(/promises\.stat\(/);
  });

  it('T14: resolveTerminalCwd(valid absolute dir) resolves it(异步,不同步阻塞)', async () => {
    const p = resolveTerminalCwd(os.tmpdir());
    expect(p).toBeInstanceOf(Promise);
    await expect(p).resolves.toBe(os.tmpdir());
  });

  // cwd 校验改异步后多了一个 await 边界:期间窗口关闭(window-closed cleanup 已跑完)时不得再登记
  // session / 签发 token / spawn PTY,否则成为已关窗口名下的孤儿终端。
  it('T14b: 异步 cwd 解析期间窗口销毁 → TERMINAL_CREATE_CANCELLED,不登记不 spawn', async () => {
    let destroyed = false;
    const win = { id: 42, isDestroyed: () => destroyed } as unknown as import('electron').BrowserWindow;
    const add = vi.fn();
    const createTerminal = vi.fn();
    const handler = makeCreateHandler({
      service: { createTerminal } as never,
      sessionStore: { add, nextDefaultTitleIndex: () => 1 } as never,
      resolveCwd: async () => {
        destroyed = true;
        return '/work';
      },
    });
    await expect(handler({ cwd: '/work' }, win)).rejects.toMatchObject({
      code: 'TERMINAL_CREATE_CANCELLED',
    });
    expect(add).not.toHaveBeenCalled();
    expect(createTerminal).not.toHaveBeenCalled();
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
